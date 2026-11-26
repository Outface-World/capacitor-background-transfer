// `node scripts/gradle.mjs <directory> [<argument>…]`: runs `./gradlew` in that directory with the
// arguments, its output passed through, and exits with its status. A run that fails because a
// dependency or the Gradle distribution could not be downloaded (a 429 or other error status, a
// timeout, a refused or lost connection) is run once more after a pause; any other failure, and a
// second failure, ends it. `npm run test:android`, `npm run verify:android`, the Capacitor matrix
// and `npm run test:servers` start Gradle through it. See CONTRIBUTING.md.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAUSE_MS = 60_000;

// Gradle's failure tree reports a failed request as `> Could not GET '<url>'.` (or HEAD) with the
// status or the network error, under `Could not download` for an artifact. A missing dependency is
// `Could not find`, which no retry fixes.
const REQUEST = /^[ \t]*> (Could not (?:GET|HEAD) '[^']+'.*)$/m;
const DOWNLOAD = /^[ \t]*> (Could not download .*)$/m;
// The wrapper fetching the distribution throws from `main`: a java.net or javax.net.ssl exception, or
// an IOException for an error status or a timeout. A failed checksum is a RuntimeException.
const WRAPPER = /^(Exception in thread "main" (?:java\.net\.\w+|javax\.net\.ssl\.\w+|java\.io\.IOException)\b.*)$/m;

// Gradle's rich console colours the failure tree (`\x1b[33m> \x1b[39mCould not GET …`).
const ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** The line of Gradle's error output that reports a failed download, or undefined if none does. */
export function downloadFailure(errors) {
  const text = errors.replace(ESCAPE, '');
  const request = REQUEST.exec(text) ?? DOWNLOAD.exec(text);
  if (request) return request[1].trim();
  const wrapper = WRAPPER.exec(text);
  if (wrapper && /^\tat org\.gradle\.wrapper\./m.test(text)) return wrapper[1].trim();
  return undefined;
}

/** Resolves once everything written to `stream` so far has been handed on. */
function flushed(stream) {
  return new Promise((resolve) => stream.write('', resolve));
}

/** A GitHub Actions workflow command's message, escaped. */
function escaped(message) {
  return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function once(dir, args, { env, onChild, stdout, stderr }) {
  return new Promise((resolve) => {
    // Gradle's failure tree and the wrapper's exception go to stderr. Stdout is kept out: its progress
    // has no closing newline, so a line of stderr appended to it would not start a line.
    let errors = '';
    const child = spawn('./gradlew', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild(child);
    child.stdout.setEncoding('utf8').on('data', (text) => stdout.write(text));
    child.stderr.setEncoding('utf8').on('data', (text) => {
      errors += text;
      stderr.write(text);
    });
    // `error` (it could not start) and `close` can both come.
    let ended = false;
    // A write to a pipe is asynchronous on macOS: a caller that exits once this resolves would drop
    // the end of the output, where Gradle says what went wrong.
    const end = async (result) => {
      if (ended) return;
      ended = true;
      onChild(undefined);
      await Promise.all([flushed(stdout), flushed(stderr)]);
      resolve({ errors, ...result });
    };
    child.on('error', (error) => end({ status: null, signal: null, error }));
    child.on('close', (status, signal) => end({ status, signal }));
  });
}

/**
 * `./gradlew` in `dir`, run again after `pauseMs` if it failed on a download; resolves `{ status, signal, error }`.
 * `onChild` gets each run's process, then undefined once it ends; a run a signal ended is not retried.
 */
export async function gradlew(dir, args, options = {}) {
  const {
    env = process.env,
    onChild = () => {},
    pauseMs = PAUSE_MS,
    stdout = process.stdout,
    stderr = process.stderr,
  } = options;
  // Gradle's stdout is a pipe here, so it picks its plain console unless told otherwise.
  const rich = stdout.isTTY && !args.some((arg) => arg.startsWith('--console')) ? ['--console=rich'] : [];
  const run = () => once(dir, [...args, ...rich], { env, onChild, stdout, stderr });
  let result = await run();
  const cause = result.status !== 0 && !result.signal && !result.error && downloadFailure(result.errors);
  if (cause) {
    const message = `Gradle could not download a dependency, so ./gradlew ${args.join(' ')} runs once more in ${pauseMs / 1000} s: ${cause}`;
    stderr.write(`\n${env.GITHUB_ACTIONS === 'true' ? `::warning::${escaped(message)}` : message}\n`);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    result = await run();
  }
  const { status, signal, error } = result;
  return { status, signal, error };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, ...args] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node scripts/gradle.mjs <directory> [<argument>…]');
    process.exit(2);
  }
  const { status, signal, error } = await gradlew(path.resolve(dir), args);
  if (error) console.error(`./gradlew in ${dir}: ${error.message}`);
  process.exitCode = signal ? 128 + os.constants.signals[signal] : (status ?? 1);
}
