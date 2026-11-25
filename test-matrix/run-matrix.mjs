// `npm run test:matrix -- <version>`: builds and tests the plugin against one Capacitor version, with
// Node's standard library only. It packs the plugin as it would be published, installs the tarball
// in new apps made from that Capacitor's own templates, all in a temporary directory (the checkout
// is left as it was), runs the cells in plan.mjs this machine can run, and lists the others with the
// reason. A failed cell fails the command; a skipped one fails it only in CI (`CI` set). See
// CONTRIBUTING.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  USAGE,
  XCODE_FOR,
  appDelegateMethod,
  majorsOf,
  newestOf,
  parseArgs,
  summary,
  verdict,
  withAppDelegateMethod,
  withDeploymentTarget,
  withPinnedCapacitor,
} from './plan.mjs';

const PLUGIN = 'capacitor-background-transfer';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const pkg = JSON.parse(read(root, 'package.json'));

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`test:matrix needs Node.js 22 or later (Capacitor 8's CLI does), not ${process.version}`);
  process.exit(2);
}

let plan;
try {
  plan = parseArgs(process.argv.slice(2), majorsOf(pkg.peerDependencies['@capacitor/core']));
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`);
  process.exit(2);
}

// The children run in other packages: npm's description of this one is dropped. The tests against
// the storage servers run elsewhere (test:servers).
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(npm_(package|lifecycle)_|npm_config_local_prefix$|INIT_CWD$|BT_HARNESS$)/.test(name),
  ),
);

// realpath: macOS's temporary directory is behind a symbolic link.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-matrix-')));
process.on('exit', () => {
  if (plan.keep) console.log(`kept ${work}`);
  else fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}   (${path.relative(work, cwd) || '.'})`);
  const { status, error, signal } = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env });
  if (status !== 0)
    throw new Error(`${path.basename(cmd)} ${args[0]}: ${error?.message ?? signal ?? `exit ${status}`}`);
}

/** What a command prints, stdout and stderr, or undefined if it can't run or fails. */
function output(cmd, args, cwd = work) {
  const { status, stdout, stderr } = spawnSync(cmd, args, { cwd, encoding: 'utf8', env, maxBuffer: 1 << 26 });
  return status === 0 ? `${stdout}${stderr}` : undefined;
}

function edit(file, change) {
  fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
}

function once(make) {
  let result;
  return () => {
    result ??= (() => {
      try {
        return { value: make() };
      } catch (error) {
        return { error };
      }
    })();
    if (result.error) throw result.error;
    return result.value;
  };
}

// What this machine has

const android = once(() => {
  const java = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java') : 'java';
  const jdk = /version "(\d+)/.exec(output(java, ['-version']) ?? '')?.[1];
  if (!jdk || Number(jdk) < 21) return { missing: `needs JDK 21 (JAVA_HOME)${jdk ? `, found ${jdk}` : ''}` };
  const localProperties = path.join(root, 'android/local.properties');
  const local = fs.existsSync(localProperties) && /^sdk\.dir=(.+)$/m.exec(read(localProperties));
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (local && local[1].trim());
  if (!sdk) return { missing: 'needs the Android SDK (ANDROID_HOME)' };
  env.ANDROID_HOME = sdk;
  return {};
});

const ios = once(() => {
  if (process.platform !== 'darwin') return { missing: 'needs macOS with Xcode' };
  const xcode = /^Xcode (\d+)(\S*)/m.exec(output('xcodebuild', ['-version']) ?? '');
  if (!xcode) return { missing: 'needs Xcode' };
  const wanted = XCODE_FOR[plan.major];
  if (Number(xcode[1]) < wanted)
    return { missing: `Capacitor ${plan.major} needs Xcode ${wanted} or later, found ${xcode[1]}${xcode[2]}` };
  return {};
});

const cocoapods = once(() => {
  const { missing } = ios();
  if (missing) return { missing };
  return output('pod', ['--version']) ? {} : { missing: 'needs CocoaPods' };
});

// What the cells share

const version = plan.exact
  ? plan.version
  : newestOf(plan.major, JSON.parse(output('npm', ['view', '@capacitor/core', 'versions', '--json']) ?? '[]'));
const capacitor = (...names) => names.map((name) => `@capacitor/${name}@${version}`);

/** A copy of the checkout's own files (ignored ones left out), with the lockfile's dependencies. */
const source = once(() => {
  const dir = path.join(work, 'source');
  const listed = output('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  if (listed === undefined) throw new Error('git ls-files failed: the matrix runs in a git checkout');
  for (const file of new Set(listed.split('\0').filter(Boolean))) {
    const from = path.join(root, file);
    if (!fs.lstatSync(from, { throwIfNoEntry: false })) continue;
    fs.cpSync(from, path.join(dir, file), { recursive: true, verbatimSymlinks: true });
  }
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  return dir;
});

/** The tarball as npm would publish it. One tarball, whichever Capacitor the cells install. */
const tarball = once(() => {
  const dir = source();
  run('npm', ['run', 'build'], dir);
  run('npm', ['pack', '--pack-destination', work], dir);
  return path.join(work, `${PLUGIN}-${pkg.version}.tgz`);
});

/** A new app made with this Capacitor's CLI, before the plugin is installed. */
function newApp(name, platform, ...addOptions) {
  const dir = path.join(work, name);
  fs.mkdirSync(path.join(dir, 'www'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'www/index.html'), '<!doctype html><title>Matrix</title>\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "matrix-app", "version": "1.0.0", "private": true }\n');
  fs.writeFileSync(
    path.join(dir, 'capacitor.config.json'),
    '{ "appId": "com.example.matrix", "appName": "Matrix", "webDir": "www" }\n',
  );
  install(dir, ...capacitor('core', 'cli', platform));
  cap(dir, 'add', platform, ...addOptions);
  return dir;
}

// --strict-peer-deps: a Capacitor outside the plugin's peer range fails the install.
function install(dir, ...packages) {
  run('npm', ['install', '--save-exact', '--strict-peer-deps', '--no-audit', '--no-fund', ...packages], dir);
}

function cap(dir, ...args) {
  run(process.execPath, [path.join(dir, 'node_modules/@capacitor/cli/bin/capacitor'), ...args], dir);
}

function expect(file, text) {
  if (!read(file).includes(text)) throw new Error(`${path.relative(work, file)} doesn't have ${text}`);
}

const androidApp = once(() => {
  const dir = newApp('android', 'android');
  install(dir, tarball());
  cap(dir, 'sync', 'android');
  expect(path.join(dir, 'android/capacitor.settings.gradle'), `':${PLUGIN}'`);
  expect(path.join(dir, 'android/app/src/main/assets/capacitor.plugins.json'), PLUGIN);
  return dir;
});

function gradle(app, ...tasks) {
  run('./gradlew', ['--no-daemon', ...tasks], path.join(app, 'android'));
}

function iosApp(name, packageManager) {
  const dir = newApp(name, 'ios', '--packagemanager', packageManager);
  const project = path.join(dir, 'ios/App');
  const minimum = Number(/\.iOS\(\.v(\d+)\)/.exec(read(root, 'Package.swift'))[1]);
  // Capacitor 7's template targets iOS 14; the plugin needs 15.
  const targets = [path.join(project, 'App.xcodeproj/project.pbxproj'), path.join(project, 'Podfile')];
  for (const file of targets.filter((each) => fs.existsSync(each)))
    edit(file, (text) => withDeploymentTarget(text, minimum));
  edit(path.join(project, 'App/AppDelegate.swift'), (text) =>
    withAppDelegateMethod(text, appDelegateMethod(read(root, 'README.md'))),
  );
  install(dir, tarball());
  cap(dir, 'sync', 'ios');
  return project;
}

function xcodebuild(project, container) {
  const destination = ['-destination', 'generic/platform=iOS Simulator'];
  const options = [
    '-configuration',
    'Debug',
    '-derivedDataPath',
    path.join(project, 'build'),
    '-scmProvider',
    'system',
  ];
  run(
    'xcodebuild',
    ['build', ...container, '-scheme', 'App', ...destination, ...options, 'CODE_SIGNING_ALLOWED=NO', '-quiet'],
    project,
  );
}

// The cells

const cells = {
  js: {
    needs: () => ({}),
    run() {
      const dir = path.join(work, 'js');
      fs.cpSync(source(), dir, { recursive: true, verbatimSymlinks: true });
      const packages = capacitor('core', 'android', 'ios');
      run(
        'npm',
        ['install', '--save-dev', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', ...packages],
        dir,
      );
      for (const script of ['typecheck', 'test', 'build']) run('npm', ['run', script], dir);
    },
  },
  'android-app': {
    needs: android,
    run() {
      gradle(androidApp(), 'assembleDebug');
    },
  },
  'android-tests': {
    needs: android,
    run() {
      // The tests aren't in the tarball, so they are put beside the installed sources.
      const app = androidApp();
      const plugin = path.join(app, 'node_modules', PLUGIN, 'android');
      fs.cpSync(path.join(root, 'android/src/test'), path.join(plugin, 'src/test'), { recursive: true });
      gradle(app, `:${PLUGIN}:testDebugUnitTest`);
      const results = path.join(plugin, 'build/test-results/testDebugUnitTest');
      const reports = fs.readdirSync(results).filter((file) => file.endsWith('.xml'));
      const counts = reports.map((file) => /tests="(\d+)" skipped="(\d+)"/.exec(read(results, file)));
      const ran = counts.reduce((sum, [, tests, skipped]) => sum + (tests - skipped), 0);
      if (!ran) throw new Error('no JUnit test ran');
      console.log(`${ran} JUnit tests ran`);
    },
  },
  'ios-spm': {
    needs: ios,
    run() {
      const project = iosApp('ios-spm', 'SPM');
      const manifest = path.join(project, 'CapApp-SPM/Package.swift');
      edit(manifest, (text) => withPinnedCapacitor(text, version));
      expect(manifest, '"CapacitorBackgroundTransfer"');
      // `cap sync` (7.6, 8.6) rewrites a plugin's `from:` that names another major.
      const installed = read(project, '../../node_modules', PLUGIN, 'Package.swift');
      if (installed !== read(root, 'Package.swift')) throw new Error("cap sync rewrote the plugin's Package.swift");
      xcodebuild(project, ['-project', 'App.xcodeproj']);
      const resolved = 'App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved';
      const { pins } = JSON.parse(read(project, resolved));
      const built = pins.find(({ identity }) => identity === 'capacitor-swift-pm')?.state.version;
      if (built !== version) throw new Error(`the app was built with capacitor-swift-pm ${built}`);
    },
  },
  'ios-cocoapods': {
    needs: cocoapods,
    run() {
      const project = iosApp('ios-cocoapods', 'CocoaPods');
      expect(path.join(project, 'Podfile'), "'CapacitorBackgroundTransfer'");
      expect(path.join(project, 'Podfile.lock'), `- Capacitor (${version})`);
      xcodebuild(project, ['-workspace', 'App.xcworkspace']);
    },
  },
};

const results = plan.cells.map((id) => {
  const { missing } = cells[id].needs();
  if (missing) return { id, status: 'skipped', reason: missing };
  console.log(`\n=== Capacitor ${version}: ${id}`);
  try {
    cells[id].run();
    return { id, status: 'passed' };
  } catch (error) {
    console.error(error.message);
    return { id, status: 'failed', reason: error.message };
  }
});

const ci = Boolean(env.CI) && env.CI !== 'false';
console.log(`\nCapacitor ${version}`);
for (const line of summary(results)) console.log(`  ${line}`);
const passed = verdict(results, { ci });
if (!passed && results.every(({ status }) => status !== 'failed'))
  console.error('In CI every cell asked for must run.');
process.exit(passed ? 0 : 1);
