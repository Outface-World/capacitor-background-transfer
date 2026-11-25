import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

// run-matrix.mjs as a process, with stand-ins for npm, git and java first on the PATH.

const script = fileURLToPath(new URL('../test-matrix/run-matrix.mjs', import.meta.url));
const VERSIONS = 'echo \'["7.0.0", "7.6.10", "8.0.0"]\'';
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-run-matrix-'));
  fs.mkdirSync(path.join(dir, 'tmp'));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function command(file: string, body: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** Runs the matrix with `npm` as the body of npm's stand-in, and lists the npm commands it ran. */
function matrix(npm: string, ...args: string[]) {
  const log = path.join(dir, 'npm.log');
  command('bin/npm', `echo "$*" >> '${log}'\n${npm}`);
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '',
      JAVA_HOME: path.join(dir, 'jdk'),
      ANDROID_HOME: path.join(dir, 'sdk'),
      PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`,
      TMPDIR: path.join(dir, 'tmp'),
    },
  });
  const ran = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status, stdout, stderr, npm: ran.map((line) => line.split(' ')[0]) };
}

it('reads the newest release from stdout, whatever npm says on stderr', { timeout: 30_000 }, () => {
  const { status, stdout, stderr } = matrix(
    `echo 'npm warn Unknown user config' >&2; ${VERSIONS}; echo 'npm notice New major version' >&2`,
    '7',
    '--cells',
    'android-app',
  );
  expect(stdout).toMatch(/\nCapacitor 7\.6\.10\n +skipped +android-app .*: needs JDK 21/);
  expect(stderr).toContain('npm warn Unknown user config');
  expect(status).toBe(0);
});

it("fails with npm's own error when the lookup does", { timeout: 30_000 }, () => {
  const { status, stdout, stderr } = matrix("echo 'npm error code ENOTFOUND' >&2; exit 1", '7');
  expect(stderr).toContain('npm error code ENOTFOUND');
  expect(stderr).toContain('The newest Capacitor 7 was not found: npm view @capacitor/core versions: exit 1');
  expect(stderr).not.toMatch(/^ +at /m);
  expect(stdout).not.toContain('=== ');
  expect(status).toBe(1);
});

it.each(['INT', 'TERM'] as const)('stops altogether on SIG%s', { timeout: 30_000 }, (signal) => {
  command('bin/git', "printf 'package.json\\0'");
  command('jdk/bin/java', 'echo \'openjdk version "21.0.1"\' >&2');
  // The signal goes to the matrix alone; `npm ci` ends when the matrix passes it on.
  const { status, stdout, npm } = matrix(`kill -${signal} $PPID; exec sleep 5`, '7.0.0', '--cells', 'js,android-app');
  expect(npm).toEqual(['ci']);
  expect(stdout).not.toMatch(/failed|android-app/);
  expect(status).toBe(128 + os.constants.signals[`SIG${signal}`]);
  expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
});

it('names the step that failed', { timeout: 30_000 }, () => {
  command('bin/git', "printf 'package.json\\0'");
  const { status, stdout } = matrix('[ "$*" != "run test" ]', '7.0.0', '--cells', 'js');
  expect(stdout).toMatch(/^ +failed +js .*: npm run test: exit 1$/m);
  expect(status).toBe(1);
});
