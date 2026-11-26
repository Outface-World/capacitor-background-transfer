import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { downloadFailure, gradlew } from '../scripts/gradle.mjs';

// Gradle's own output: the 429s from a CI run, and the other failures from local runs.
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/gradle/${name}.txt`, import.meta.url));
const output = (name: string) => fs.readFileSync(fixture(name), 'utf8');
const script = fileURLToPath(new URL('../scripts/gradle.mjs', import.meta.url));

describe('downloadFailure', () => {
  it('finds the first failed request in the 429s from Maven Central', () => {
    expect(downloadFailure(output('download-429'))).toBe(
      "Could not GET 'https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib-jdk8/1.9.20/kotlin-stdlib-jdk8-1.9.20.pom'. Received status code 429 from server: Too Many Requests",
    );
  });

  it('finds a request that timed out or lost its connection', () => {
    const timedOut = [
      "> Could not resolve all files for configuration ':app:debugRuntimeClasspath'.",
      '   > Could not download kotlin-stdlib-2.2.0.jar (org.jetbrains.kotlin:kotlin-stdlib:2.2.0)',
      "      > Could not get resource 'https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.2.0/kotlin-stdlib-2.2.0.jar'.",
      "         > Could not GET 'https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.2.0/kotlin-stdlib-2.2.0.jar'.",
      '            > Read timed out',
    ].join('\n');
    expect(downloadFailure(timedOut)).toMatch(/^Could not GET 'https:\/\/repo\.maven\.apache\.org\/.*\.jar'\.$/);
    expect(downloadFailure(timedOut.replace(/^.*Could not (get resource|GET).*\n/gm, ''))).toBe(
      'Could not download kotlin-stdlib-2.2.0.jar (org.jetbrains.kotlin:kotlin-stdlib:2.2.0)',
    );
  });

  it("finds the wrapper's failed download of the distribution", () => {
    expect(downloadFailure(output('wrapper-download'))).toBe(
      'Exception in thread "main" java.net.ConnectException: Connection refused',
    );
  });

  it.each(['junit-failure', 'compile-error', 'no-sdk'])('finds nothing in %s', (name) => {
    expect(downloadFailure(output(name))).toBeUndefined();
  });

  it('finds nothing in a dependency that does not exist, or a failed checksum', () => {
    const missing = [
      "> Could not resolve all files for configuration ':classpath'.",
      '   > Could not find com.example:missing:1.0.',
    ].join('\n');
    expect(downloadFailure(missing)).toBeUndefined();
    const checksum = [
      'Exception in thread "main" java.lang.RuntimeException: Verification of Gradle distribution failed!',
      '\tat org.gradle.wrapper.Install.verifyDownloadChecksum(Install.java:240)',
    ].join('\n');
    expect(downloadFailure(checksum)).toBeUndefined();
  });

  it('finds nothing in a java.net exception that is not the wrapper', () => {
    const test = 'Exception in thread "main" java.net.ConnectException: Connection refused\n\tat com.example.Main.main';
    expect(downloadFailure(test)).toBeUndefined();
  });
});

describe('gradlew', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-gradle-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A stand-in ./gradlew that logs its arguments and, on its nth run, prints `runs[n]` and exits with its status. */
  function standIn(...runs: { print?: string; status: number }[]) {
    const cases = runs
      .map(({ print, status }, i) => `  ${i + 1}) ${print ? `cat '${fixture(print)}' >&2; ` : ''}exit ${status} ;;`)
      .join('\n');
    const body = `echo "$*" >> runs.log\nn=$(wc -l < runs.log | tr -d ' ')\ncase "$n" in\n${cases}\n  *) exit 99 ;;\nesac\n`;
    fs.writeFileSync(path.join(dir, 'gradlew'), `#!/bin/sh\n${body}`, { mode: 0o755 });
  }

  const runs = () => fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n');

  function sink() {
    let text = '';
    const stream = new Writable({
      write(chunk, _encoding, done) {
        text += chunk;
        done();
      },
    });
    return { stream, text: () => text };
  }

  async function run(env: NodeJS.ProcessEnv = { PATH: process.env.PATH }) {
    const out = sink();
    const err = sink();
    const result = await gradlew(dir, ['test', '--no-daemon'], {
      env,
      pauseMs: 10,
      stdout: out.stream,
      stderr: err.stream,
    });
    return { ...result, stdout: out.text(), stderr: err.text() };
  }

  it('runs once more after a 429, and passes when that run does', async () => {
    standIn({ print: 'download-429', status: 1 }, { status: 0 });
    const { status, stderr } = await run();
    expect(status).toBe(0);
    expect(runs()).toEqual(['test --no-daemon', 'test --no-daemon']);
    expect(stderr).toContain('BUILD FAILED in 1m 18s');
    expect(stderr).toMatch(
      /^Gradle could not download a dependency, so \.\/gradlew test --no-daemon runs once more in 0\.01 s: Could not GET 'https:\/\/repo\.maven\.apache\.org\/.*Received status code 429 from server: Too Many Requests$/m,
    );
  });

  it("fails with Gradle's own output after a second failed download, with no third run", async () => {
    standIn({ print: 'download-429', status: 1 }, { print: 'download-429', status: 1 }, { status: 0 });
    const { status, stderr } = await run();
    expect(status).toBe(1);
    expect(runs()).toHaveLength(2);
    expect(stderr.match(/BUILD FAILED in 1m 18s/g)).toHaveLength(2);
    expect(stderr.match(/^Gradle could not download/gm)).toHaveLength(1);
  });

  it('does not run a failing JUnit test again', async () => {
    standIn({ print: 'junit-failure', status: 1 }, { status: 0 });
    const { status, stderr } = await run();
    expect(status).toBe(1);
    expect(runs()).toHaveLength(1);
    expect(stderr).toContain('There were failing tests');
    expect(stderr).not.toContain('Gradle could not download');
  });

  it('runs once when Gradle passes', async () => {
    standIn({ status: 0 });
    expect((await run()).status).toBe(0);
    expect(runs()).toHaveLength(1);
  });

  it('says why it retries as a GitHub Actions warning in a workflow', async () => {
    standIn({ print: 'download-429', status: 1 }, { status: 0 });
    const { stderr } = await run({ PATH: process.env.PATH, GITHUB_ACTIONS: 'true' });
    expect(stderr).toMatch(/^::warning::Gradle could not download a dependency, .*status code 429/m);
  });

  it('says so when ./gradlew is not there', async () => {
    const { status, error } = await run();
    expect(status).toBeNull();
    expect(error?.message).toMatch(/ENOENT/);
  });

  it('passes the arguments and the exit status through on the command line', { timeout: 30_000 }, () => {
    standIn({ print: 'junit-failure', status: 3 });
    const { status, stderr } = spawnSync(process.execPath, [script, dir, 'testDebugUnitTest', '--rerun'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(status).toBe(3);
    expect(runs()).toEqual(['testDebugUnitTest --rerun']);
    expect(stderr).toContain('There were failing tests');
  });
});
