# Contributing

Issues and pull requests are welcome.

## Setup

```bash
npm install
```

You need Node.js 22 or later; for Android, JDK 21 and the Android SDK (`ANDROID_HOME`, platforms 35
and 36); for iOS, Xcode 26 or later on macOS (Capacitor 8 needs it); for the tests against local
storage servers, Docker.

## Checks

Run these before opening a pull request:

```bash
npm run verify   # typecheck, Vitest, build, JUnit, XCTest
npm run lint     # ESLint, Prettier and SwiftLint (SwiftLint on macOS, where installed)
npm run test:servers   # with Docker: the JUnit and XCTest suites against MinIO and Azurite
npm run test:matrix -- 7   # the plugin in new Capacitor 7 apps; the same with 8
```

SwiftLint's rules are in `.swiftlint.yml`, relaxed for the tests by `ios/Tests/.swiftlint.yml`.

CI runs all of these on every pull request and every push to `main`, forks' pull requests
included. Its **Verify** job passes only when the checks, every Capacitor cell, the server
tests and the workflow checks have.

A change to an upload protocol should also pass the end-to-end runs on an emulator or simulator
(`npm run test:e2e`; see [Local storage servers](#local-storage-servers)).

`npm run fmt` fixes formatting. The API section of `README.md` is generated from
`src/definitions.ts` by `npm run build`; edit the comments there, not the README.

### The workflows

A change under `.github/` should also pass the checks CI's **Workflow checks** job runs on every
push and pull request: [zizmor](https://docs.zizmor.sh) (security) and
[actionlint](https://github.com/rhysd/actionlint) (correctness). The job fails on any high or
medium zizmor finding and on any actionlint error. Locally, with zizmor 1.31.1 and actionlint
1.7.12 (the versions CI pins):

```bash
zizmor --offline --min-severity medium .   # the workflows, .github/actions/ and dependabot.yml
actionlint
```

A finding accepted on purpose gets an inline `# zizmor: ignore[<audit>]` on the line zizmor
points at, with the reason beside it.

Every `uses:` names an action by its full commit SHA, with the version in a comment
(`actions/checkout@<sha> # v4.4.0`), so a moved tag can't change what runs. Dependabot keeps them
current (`.github/dependabot.yml`): once a week, every actions update, majors included, comes in
one pull request, a week after the release it offers. A person reviews and merges it: CI can't,
because `GITHUB_TOKEN` may not merge a change to `.github/workflows/`, so CI's Dependabot merge
leaves any pull request touching `.github/workflows/` or `.github/actions/` open with a notice.

npm dependencies get Dependabot security updates only. CI merges their patch and minor ones once
Verify, the server tests and the workflow checks pass; majors wait for review. It only merges a
pull request Dependabot opened from a branch in this repository whose every commit Dependabot
authored and GitHub signed, so one somebody else has pushed to stays open.

CI caches what Gradle downloads in the six jobs that run it (**Checks**, **Android tests against
MinIO and Azurite** and the four **JavaScript and Android** cells), so a run whose dependency set is
unchanged asks Maven Central for nothing. The cache holds the dependencies and the wrapper's
unpacked Gradle distributions (`~/.gradle/caches/modules-2` and `~/.gradle/wrapper/dists`), not
build outputs. Its key is the runner's OS, the job, the Gradle files under `android/`
(`build.gradle`, `settings.gradle`, `gradle.properties` and the wrapper's properties) and the
Capacitor in use: the installed `@capacitor/android` for the first two jobs, and for a matrix cell
the Capacitor release it runs, which the job looks up before restoring and then hands to the
matrix. A run with no exact match restores the newest cache of the same job and OS and downloads
only the difference. Any run saves when no cache matched its key exactly and the job passed, pull
requests from forks included: GitHub confines a pull request's cache to that pull request, so
`main` and other pull requests never restore it. A cache that can't be restored or saved doesn't
fail the job.

Wherever Gradle is started (`npm run test:android`, `npm run verify:android`, `npm run
test:matrix` and `npm run test:servers`, through `scripts/gradle.mjs`), a run whose error output
reports a failed download (an error status such as 429, a timeout, a refused or lost connection,
from Gradle or its wrapper, in its plain or its rich console) is run once more after a minute, and
the log says so and names the failure. Any other failure, and a second one, fails at once with
Gradle's own output. This covers a run with no cache, and the release checks.

The publish path restores no caches and runs no install scripts: caching is off explicitly on
every setup action in `release.yml` and `.github/actions/release-checks`, neither has a cache step,
and dependencies are installed with `npm ci --ignore-scripts`.

## The tests

```bash
npm run build           # TypeScript, the API section of README.md, rollup bundles
npm test                # Vitest: option checks, the web implementation
npm run test:android    # JUnit: chunking, offsets, Range, retries, the queue (JDK 21, Android SDK)
npm run test:ios        # XCTest on macOS: remainder copies, part files, upload outcomes
npm run verify          # all of the above
npm run test:servers    # MinIO and Azurite in Docker; the JUnit and XCTest suites against them
npm run test:matrix -- 8   # against one Capacitor version, below
```

### The Capacitor matrix

The repository develops on Capacitor 8. The plugin supports 7 and 8, and the range is in two places
that must name the same majors: `peerDependencies` in `package.json` and `capacitor-swift-pm` in
`Package.swift` (`tests/matrix.test.ts` compares them).

`npm run test:matrix -- <version>` takes a major (`7` or `8`: its newest release, looked up on npm)
or an exact release (`7.0.0`). It packs the plugin as npm would publish it and installs the tarball
in new apps made by that Capacitor's own CLI, in a temporary directory, so the checkout is left as
it was. Its cells:

| Cell | What | Needs |
|---|---|---|
| `js` | Typecheck, Vitest and build, with that Capacitor installed | |
| `android-app` | A new app from that Capacitor's Android template, built with the plugin | JDK 21, the Android SDK |
| `android-tests` | The plugin's JUnit tests, in that app's Gradle build | The same |
| `ios-spm` | A new app with Swift Package Manager, built for the simulator with the plugin | macOS; Xcode 16 for Capacitor 7, Xcode 26 for Capacitor 8 |
| `ios-cocoapods` | The same with CocoaPods (for an exact release, only when named) | The same, and CocoaPods |

`--cells js,android-app` runs only those, and `--keep` leaves the temporary directory in place. Each
cell the machine can't run is listed as skipped with the reason. A failed cell fails the command. A
skipped one doesn't, except in CI (with `CI` set), where a job names the cells its runner must run.

The apps are the templates as they come, with three changes: the `AppDelegate` method from
`README.md`; iOS 15 as the deployment target, since Capacitor 7's template says 14; and, where
Capacitor 7.0.0's CLI writes `branch: "main"` for `capacitor-swift-pm` (the newest Capacitor of any
major), the exact version instead.
Capacitor 7.6.10's `cap add ios --packagemanager SPM` makes the project and then fails on `pod
install`; the `cap sync` after it carries on from there.

CI runs the matrix for 7.0.0, the newest 7, 8.0.0 and the newest 8: the first three cells on Linux,
the iOS ones on `macos-15` with Xcode 16.4 for Capacitor 7 and Xcode 26.3 for Capacitor 8, CocoaPods
with the newest of each. So a Capacitor release that breaks the plugin fails the next run. The
Swift core tests and the tests against the storage servers don't involve Capacitor and run once.

### Local storage servers

`test-servers/` holds a Docker Compose file running MinIO (S3, release
`RELEASE.2025-10-15T17-29-55Z`, built from its repository by `minio.Dockerfile` since MinIO no
longer publishes images; the first start builds it) and Azurite (Azure Blob, 3.37.0) with their
well-known development credentials (`minioadmin`/`minioadmin`, and Azurite's `devstoreaccount1`),
and a small harness in front of them (`harness.mjs`, Node's standard library only). Its control
API on port 8790 creates multipart uploads, presigns part URLs and SAS URLs, checks what the
servers stored, and injects faults; the S3 (8791) and Azure (8792) endpoints it hands out go
through a recording proxy that can cut a request part-way, refuse it, swallow its answer, slow it
down or drop every connection for a while. The containers are memory-limited, their images
pinned, and their ports published on `127.0.0.1` only.

`npm run test:servers` needs Docker running, a JDK 21 (`JAVA_HOME`) and the Android SDK
(`ANDROID_HOME`, or `sdk.dir` in `android/local.properties`), and on macOS Swift; it refuses to
start without them. It reruns the JUnit suite even when Gradle holds results from a run without
the servers, and says how many of `ServersTest`'s cases ran. In CI the JUnit suite runs against
the compose servers on Linux; the Swift suite runs on macOS, which has no Docker, against the
same MinIO release built from its repository, Azurite 3.37.0 from npm and the harness. CI also
scans every push and pull request for committed secrets (gitleaks, configured in
`.gitleaks.toml`, which allowlists the test servers' published development credentials).
When the repository belongs to an organisation, the gitleaks action needs a licence key (free from
gitleaks.io), stored twice under the name `GITLEAKS_LICENSE`: as a repository secret for pushes and
pull requests from branches of the repository, and as a Dependabot secret for Dependabot's pull
requests, which read only Dependabot secrets. Pull requests from forks fail the scan, because GitHub
gives their runs no secrets. A personal account's repository needs no key.

```bash
npm run servers:up      # start them (docker compose up --wait)
BT_HARNESS=http://localhost:8790 npm run test:android   # the JVM tests that need them run only with BT_HARNESS set
BT_HARNESS=http://localhost:8790 npm run test:ios
npm run servers:down
```

End to end, on one booted Android emulator or iOS simulator at a time (the URLs it hands the
device use `10.0.2.2` on Android and `127.0.0.1` on iOS):

```bash
npm run build && (cd example-app && npm install && npm run build:harness && npx cap sync)
# Android: build and install example-app/android (./gradlew assembleDebug; adb install -r -g …)
# iOS: build the example for the simulator signed ad hoc (CODE_SIGN_IDENTITY=-): an unsigned
#      app is never woken in the background when a task ends
npm run servers:up
npm run test:e2e -- --platform android    # or --platform ios; --only s3-multipart, --case killed
```

It makes the test files on the device (three parts of 5, 5 and 1 MiB), locks the device, sends the
app to the background and kills it, cuts the network, lets URLs expire, refuses or swallows the
commit, and checks the stored objects and what the app reports.

`test:ios` runs `ios/CoreTests`, a package of its own whose sources are symlinks to
`ios/Sources/BackgroundTransferCore` and `ios/Tests/BackgroundTransferCoreTests`, because
Capacitor's Swift package only ships iOS binaries. The Android tests run the uploader and
downloader against a local MockWebServer. The upload protocols' tests against real servers are described under
[Local storage servers](#local-storage-servers).

Things only a real device can show: locking an iPhone mid-transfer, Low Power Mode, an Android
restart part-way through (the job is persisted), and makers' own battery managers.

## Trying a change on a device

`example-app/` uses the plugin from this folder:

```bash
cd example-app
npm install
npm run sync
npx cap run android   # or: npx cap run ios
```

## Releasing

A GitHub release publishes the package to npm (`.github/workflows/release.yml`). Nothing is
published by a merge to `main`.

1. On a branch, set the version in `package.json` (and `package-lock.json`: `npm version X.Y.Z
   --no-git-tag-version` does both) and date the version's entry in `CHANGELOG.md` (`## X.Y.Z
   (YYYY-MM-DD)`, not `(unreleased)`). Merge it.
2. On GitHub, draft a release from `main` with a new tag `vX.Y.Z` and the changelog entry as its
   notes. Tick **pre-release** for a version to try first: it is published under npm's `next`
   dist-tag, so `npm install capacitor-background-transfer@next` gets it and plain installs don't.
   To promote it later, untick pre-release and move `latest` by hand, signed in to npm with
   two-factor authentication: `npm dist-tag add capacitor-background-transfer@X.Y.Z latest`
   (trusted publishing covers `npm publish` only, so the workflow's check fails until `latest` is
   moved). Or publish the next version as a full release.
3. Publishing the release runs the workflow: it checks that the tag names the version in
   `package.json`, that `CHANGELOG.md` has a dated entry for it and that the tagged commit is on
   `main`; runs the lint, TypeScript, JUnit and XCTest suites and the iOS build with Xcode 26 (the
   Capacitor matrix and the server tests ran on the pull request and on the merge to `main`); installs a pinned npm 11; shows what the tarball holds
   (`npm pack --dry-run`, the `files` list in `package.json`); and runs
   `npm publish --provenance --access public`, so the npm page links the release back to this
   repository and the workflow run. The checks live in `.github/actions/release-checks`, which
   the dry run below shares.

### A dry run

To try the release workflow without releasing, start it by hand: Actions → **Release** → Run
workflow, from `main` (or `gh workflow run release.yml --ref main`). Its **Dry run** job runs the
same checks as a release, less the tag ones (it checks the version's dated changelog entry but no
tag, and not that the commit is on `main`), and ends in `npm publish --dry-run`. If the version
in `package.json` is already on npm, as it is between releases, that run's copy is renamed to a
throwaway `X.Y.Z-dryrun.<run id>` first, because npm refuses even a dry run over a published
version. It can't publish: it has no `id-token` permission, and the publish job and the `latest`
check run only for a GitHub release.

### One-time npm setup

The workflow signs in to npm by trusted publishing, with no stored token. On npmjs.com, under the
package's settings:

- Add a trusted publisher: GitHub Actions, organization `Outface-World`, repository
  `capacitor-background-transfer`, workflow `release.yml`, no environment (so keep the workflow's
  file name). The publish job's `id-token: write` permission lets npm verify the run.
- Under publishing access, require two-factor authentication and disallow bypass 2FA tokens.

Provenance needs a public repository, which this is.
