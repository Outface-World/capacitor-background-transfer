// `node scripts/gradle.mjs <directory> [<argument>…]`: runs `./gradlew` in that directory with the
// arguments, its output passed through, and exits with its status. A run that fails because a
// dependency or the Gradle distribution could not be downloaded (a 429 or other error status, a
// timeout, a refused or lost connection) is run once more after a pause; any other failure, and a
// second failure, ends it. `npm run test:android`, the Capacitor matrix and `npm run test:servers`
// start Gradle through it. See CONTRIBUTING.md.
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
// The wrapper fetching the distribution throws from `main`: a java.net exception, or an IOException
// for an error status or a timeout. A failed checksum is a RuntimeException.
const WRAPPER = /^(Exception in thread "main" java\.(?:net\.\w+|io\.IOException)\b.*)$/m;

/** The line of Gradle's output that reports a failed download, or undefined if none does. */
export function downloadFailure(output) {
  const request = REQUEST.exec(output) ?? DOWNLOAD.exec(output);
  if (request) return request[1].trim();
  const wrapper = WRAPPER.exec(output);
  if (wrapper && /^\tat org\.gradle\.wrapper\./m.test(output)) return wrapper[1].trim();
  return undefined;
}

/** A GitHub Actions workflow command's message, escaped. */
function escaped(message) {
  return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function once(dir, args, { env, onChild, stdout, stderr }) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('./gradlew', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild(child);
    for (const [from, to] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ])
      from.setEncoding('utf8').on('data', (text) => {
        output += text;
        to.write(text);
      });
    // `error` (it could not start) and `close` can both come.
    let ended = false;
    const end = (result) => {
      if (ended) return;
      ended = true;
      onChild(undefined);
      resolve({ output, ...result });
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
  const run = () => once(dir, args, { env, onChild, stdout, stderr });
  let result = await run();
  const cause = result.status !== 0 && !result.signal && !result.error && downloadFailure(result.output);
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
  process.exit(signal ? 128 + os.constants.signals[signal] : (status ?? 1));
}
