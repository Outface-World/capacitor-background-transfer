// What `npm run test:matrix` is asked for and what it makes of the results: the arguments, the
// supported majors, the newest version of one, the cells and the verdict. No I/O, so Vitest can test
// it (tests/matrix.test.ts); run-matrix.mjs does the work.
import path from 'node:path';

/** Every cell, in the order they run. */
export const CELLS = [
  { id: 'js', title: 'Typecheck, Vitest and build' },
  { id: 'android-app', title: "A new app from Capacitor's Android template, built with the plugin" },
  { id: 'android-tests', title: "The plugin's JUnit tests, in that app" },
  { id: 'ios-spm', title: 'A new app with Swift Package Manager, built for the simulator with the plugin' },
  { id: 'ios-cocoapods', title: 'A new app with CocoaPods, built for the simulator with the plugin' },
];

/** The oldest Xcode major that builds each Capacitor major. */
export const XCODE_FOR = { 7: 16, 8: 26 };

export const USAGE = `usage: npm run test:matrix -- <version> [--cells <id>,…] [--keep]
  <version>  a Capacitor major (its newest release) or an exact release, e.g. 7, 8 or 7.0.0
  --cells    only these cells: ${CELLS.map((cell) => cell.id).join(', ')}
  --keep     leave the temporary copies in place and print where they are`;

/** The majors a range like `>=7.0.0 <9.0.0` (npm) or `"7.0.0"..<"9.0.0"` (Package.swift) takes. */
export function majorsOf(range) {
  const match = /^(?:>=(\d+)\.0\.0 <(\d+)\.0\.0|"(\d+)\.0\.0"\.\.<"(\d+)\.0\.0")$/.exec(range.trim());
  if (!match) throw new Error(`not a range of whole majors: ${range}`);
  const from = Number(match[1] ?? match[3]);
  const until = Number(match[2] ?? match[4]);
  return Array.from({ length: until - from }, (_, i) => from + i);
}

/** The newest release (not a pre-release) of a major among `versions`. */
export function newestOf(major, versions) {
  const minorAndPatch = versions
    .map((version) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version))
    .filter((match) => match && Number(match[1]) === major)
    .map((match) => [Number(match[2]), Number(match[3])])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
  if (!minorAndPatch) throw new Error(`no release of Capacitor ${major}`);
  return [major, ...minorAndPatch].join('.');
}

/** `{ version, major, exact, cells, keep }`, or an Error that says what is wrong. */
export function parseArgs(args, majors) {
  let version;
  let cells;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--keep') keep = true;
    else if (arg === '--cells') {
      cells = (args[++i] ?? '').split(',').filter(Boolean);
      const unknown = cells.filter((id) => !CELLS.some((cell) => cell.id === id));
      if (unknown.length) throw new Error(`no such cell: ${unknown.join(', ')}`);
      if (!cells.length) throw new Error('--cells names no cell');
    } else if (arg.startsWith('-') || version) throw new Error(`unexpected argument: ${arg}`);
    else version = arg;
  }
  if (!version) throw new Error('which Capacitor version?');
  const match = /^(\d+)(\.\d+\.\d+)?$/.exec(version);
  if (!match) throw new Error(`not a Capacitor major or release: ${version}`);
  const major = Number(match[1]);
  if (!majors.includes(major)) throw new Error(`the plugin supports Capacitor ${majors.join(' and ')}, not ${version}`);
  const exact = Boolean(match[2]);
  return { version, major, exact, cells: cells ?? defaultCells(exact), keep };
}

/** CocoaPods is built with the newest release of each major, so only a major runs it unasked. */
function defaultCells(exact) {
  return CELLS.map((cell) => cell.id).filter((id) => !exact || id !== 'ios-cocoapods');
}

/**
 * Whether a run passed. `results` is one `{ id, status, reason }` per cell, status `passed`,
 * `failed` or `skipped`. In CI a job names the cells its runner can run, so a skipped one fails it.
 */
export function verdict(results, { ci }) {
  return results.length > 0 && results.every(({ status }) => status === 'passed' || (status === 'skipped' && !ci));
}

/** A command as a failure names it: up to its first option, a path by its last part. */
export function stepName(cmd, args) {
  const options = args.findIndex((arg) => arg.startsWith('-'));
  return [cmd, ...args.slice(0, options < 0 ? args.length : options)]
    .map((word) => (/^\.?\//.test(word) ? path.basename(word) : word))
    .join(' ');
}

/** The lines printed at the end: every cell, its status and the reason for a skip or a failure. */
export function summary(results) {
  const width = Math.max(...CELLS.map((cell) => cell.id.length));
  return results.map(({ id, status, reason }) => {
    const { title } = CELLS.find((cell) => cell.id === id);
    return `${status.padEnd(7)}  ${id.padEnd(width)}  ${title}${reason ? `: ${reason}` : ''}`;
  });
}

/** The `AppDelegate` method the README tells an app to add, from the README itself. */
export function appDelegateMethod(readme) {
  const blocks = [...readme.matchAll(/```swift\n([\s\S]*?)```/g)].map((match) => match[1]);
  const block = blocks.find((text) => text.includes('handleEventsForBackgroundURLSession'));
  const match = block && /^import (\w+)\n+([\s\S]+)$/.exec(block);
  if (!match) throw new Error('README.md has no AppDelegate example');
  return { module: match[1], method: match[2].trimEnd() };
}

/** A template's `AppDelegate.swift` with the README's import and method added. */
export function withAppDelegateMethod(source, { module, method }) {
  const added = source
    .replace(/^import Capacitor$/m, (line) => `${line}\nimport ${module}`)
    .replace(/^class AppDelegate\b.*\{$/m, (line) => `${line}\n\n${method.replace(/^(?=.)/gm, '    ')}`);
  if (!added.includes(`import ${module}`) || !added.includes(method.split('\n')[0]))
    throw new Error('the template AppDelegate.swift is not laid out as expected');
  return added;
}

/** Xcode project or Podfile text with every iOS deployment target below `minimum` raised to it. */
export function withDeploymentTarget(text, minimum) {
  return text.replace(/(IPHONEOS_DEPLOYMENT_TARGET = |platform :ios, ')(\d+)\.\d+/g, (all, before, major) =>
    Number(major) < minimum ? `${before}${minimum}.0` : all,
  );
}

/**
 * The app's generated Package.swift with Capacitor pinned to `version`. Capacitor 7.0.0's CLI writes
 * `branch: "main"`, which is the newest Capacitor of any major; later ones pin it themselves.
 */
export function withPinnedCapacitor(text, version) {
  return text.replace(/(capacitor-swift-pm\.git", )branch: "main"/, `$1exact: "${version}"`);
}
