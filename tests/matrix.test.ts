import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CELLS,
  XCODE_FOR,
  appDelegateMethod,
  majorsOf,
  newestOf,
  parseArgs,
  stepName,
  summary,
  verdict,
  withAppDelegateMethod,
  withDeploymentTarget,
  withPinnedCapacitor,
} from '../test-matrix/plan.mjs';

const read = (name: string) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const MAJORS = [7, 8];

describe('the supported Capacitor majors', () => {
  it('are the same for npm and Swift Package Manager', () => {
    const peer = JSON.parse(read('package.json')).peerDependencies['@capacitor/core'];
    const swift = /capacitor-swift-pm\.git", (.+)\)/.exec(read('Package.swift'))?.[1] ?? '';
    expect(majorsOf(peer)).toEqual(MAJORS);
    expect(majorsOf(swift)).toEqual(majorsOf(peer));
  });

  it('each have an Xcode, and the first and the newest release of each are built in CI', () => {
    expect(Object.keys(XCODE_FOR).map(Number)).toEqual(MAJORS);
    const ci = read('.github/workflows/ci.yml');
    for (const major of MAJORS)
      for (const version of [`'${major}.0.0'`, `'${major}'`])
        expect(ci.split(`capacitor: ${version}`).length - 1, `${version} on Linux and macOS`).toBe(2);
  });

  it('are refused as a range that is open or not of whole majors', () => {
    for (const range of ['>=7.0.0', '>=7.1.0 <9.0.0', 'from: "7.0.0"', '^7.0.0'])
      expect(() => majorsOf(range)).toThrow('not a range of whole majors');
  });
});

describe('the newest release of a major', () => {
  it('compares numbers, and leaves out other majors and pre-releases', () => {
    expect(newestOf(7, ['7.0.0', '7.6.10', '7.6.9', '7.7.0-nightly-1', '8.6.2', '9.0.0-rc.0'])).toBe('7.6.10');
  });

  it('is an error when there is none', () => {
    expect(() => newestOf(9, ['8.6.2', '9.0.0-rc.0'])).toThrow('no release of Capacitor 9');
  });
});

describe('the arguments', () => {
  it('take a major, and run every cell', () => {
    expect(parseArgs(['8'], MAJORS)).toEqual({
      version: '8',
      major: 8,
      exact: false,
      cells: CELLS.map((cell) => cell.id),
      keep: false,
    });
  });

  it('take an exact release, and leave CocoaPods to the newest one', () => {
    const { version, exact, cells } = parseArgs(['7.0.0', '--keep'], MAJORS);
    expect({ version, exact }).toEqual({ version: '7.0.0', exact: true });
    expect(cells).not.toContain('ios-cocoapods');
    expect(parseArgs(['7.0.0', '--cells', 'ios-cocoapods'], MAJORS).cells).toEqual(['ios-cocoapods']);
  });

  it.each([
    [[], 'which Capacitor version'],
    [['9'], 'supports Capacitor 7 and 8, not 9'],
    [['6.2.0'], 'supports Capacitor 7 and 8, not 6.2.0'],
    [['latest'], 'not a Capacitor major or release'],
    [['8.7.0-beta.1'], 'not a Capacitor major or release'],
    [['7', '8'], 'unexpected argument: 8'],
    [['7', '--cell', 'js'], 'unexpected argument: --cell'],
    [['7', '--cells', 'js,ios'], 'no such cell: ios'],
    [['7', '--cells'], '--cells names no cell'],
  ])('refuse %j', (args, message) => {
    expect(() => parseArgs(args, MAJORS)).toThrow(message);
  });
});

describe('the verdict', () => {
  const passed = { id: 'js', status: 'passed' };
  const skipped = { id: 'ios-spm', status: 'skipped', reason: 'needs macOS with Xcode' };
  const failed = { id: 'android-app', status: 'failed', reason: 'gradlew: exit 1' };

  it('lets a skipped cell pass, except in CI', () => {
    expect(verdict([passed, skipped], { ci: false })).toBe(true);
    expect(verdict([passed, skipped], { ci: true })).toBe(false);
  });

  it('fails on a failed cell, and when nothing was asked for', () => {
    expect(verdict([passed, failed], { ci: false })).toBe(false);
    expect(verdict([], { ci: false })).toBe(false);
  });

  it('lists each cell with its reason', () => {
    const lines = summary([passed, skipped]);
    expect(lines[0]).toMatch(/^passed +js +Typecheck/);
    expect(lines[1]).toMatch(/^skipped +ios-spm .*: needs macOS with Xcode$/);
  });
});

describe('the name of a step', () => {
  it.each([
    ['npm', ['run', 'test'], 'npm run test'],
    [
      'npm',
      ['install', '@capacitor/core@7.0.0', '/tmp/x/plugin-0.2.0.tgz', '--save-exact'],
      'npm install @capacitor/core@7.0.0 plugin-0.2.0.tgz',
    ],
    ['./gradlew', [':plugin:testDebugUnitTest', '--no-daemon'], 'gradlew :plugin:testDebugUnitTest'],
    ['/usr/bin/node', ['/tmp/x/bin/capacitor', 'sync', 'android'], 'node capacitor sync android'],
    ['xcodebuild', ['build', '-project', 'App.xcodeproj'], 'xcodebuild build'],
  ])('%s %j is %s', (cmd, args, name) => {
    expect(stepName(cmd, args)).toBe(name);
  });
});

describe('the app the plugin is built into', () => {
  const template = `import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
}
`;

  it("has the README's AppDelegate example", () => {
    const example = appDelegateMethod(read('README.md'));
    expect(example.module).toBe('BackgroundTransferPlugin');
    const source = withAppDelegateMethod(template, example);
    expect(source).toContain('import Capacitor\nimport BackgroundTransferPlugin\n');
    expect(source).toContain(
      'UIApplicationDelegate {\n\n    func application(_ application: UIApplication, handleEvents',
    );
    expect(source.match(/\{/g)?.length).toBe(source.match(/\}/g)?.length);
  });

  it('is refused when the template or the README changed shape', () => {
    expect(() => appDelegateMethod('# No example')).toThrow('no AppDelegate example');
    expect(() => withAppDelegateMethod('struct App {}', appDelegateMethod(read('README.md')))).toThrow(
      'not laid out as expected',
    );
  });

  it('has its deployment target raised, never lowered', () => {
    const text = "IPHONEOS_DEPLOYMENT_TARGET = 14.0;\nIPHONEOS_DEPLOYMENT_TARGET = 16.4;\nplatform :ios, '14.0'\n";
    expect(withDeploymentTarget(text, 15)).toBe(
      "IPHONEOS_DEPLOYMENT_TARGET = 15.0;\nIPHONEOS_DEPLOYMENT_TARGET = 16.4;\nplatform :ios, '15.0'\n",
    );
  });

  it('has Capacitor pinned where its CLI follows the main branch', () => {
    const line = '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", branch: "main")';
    expect(withPinnedCapacitor(line, '7.0.0')).toBe(line.replace('branch: "main"', 'exact: "7.0.0"'));
    const pinned = line.replace('branch: "main"', 'exact: "7.6.10"');
    expect(withPinnedCapacitor(pinned, '7.6.10')).toBe(pinned);
  });
});
