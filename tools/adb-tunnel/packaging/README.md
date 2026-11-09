# STF utilities releases and Homebrew

The client is the private package `@finservice/stf-utils`; its executable is
`stf`, with the command `stf utils adb connect`. Releases use their own
`stf-utils-vMAJOR.MINOR.PATCH` tags, independent of the farm server's releases.
Nothing in this change creates a tap, tag, GitHub Release, or npm publication.

## Build the distributable

From the repository root:

```sh
node tools/adb-tunnel/packaging/build-release.mts --out /tmp/stf-utils-release
```

The builder copies an explicit client-only source list into a temporary directory,
then runs `npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund`
using the committed lockfile. The only runtime dependency is `ws@8.22.0`.
Optional native addons, gateway/server code, tests, private configuration and SDKs
are excluded. The archive includes the Apache license and the bundled dependency's
MIT license. No npm download or lifecycle script runs during Homebrew installation.

For package version `0.1.0`, the output is:

- `stf-utils-0.1.0.tar.gz`: portable client plus `node_modules/ws`.
- `stf-utils-0.1.0.tar.gz.sha256`: checksum of those actual archive bytes.
- `stf-utils-0.1.0.manifest.json`: package/dependency versions and per-file hashes.

Output files are created exclusively; an existing release is never silently
overwritten. Use a fresh output directory when rebuilding. `--offline` uses a
previously populated npm cache; `--npm-cache /path` selects an isolated cache.
No registry credentials are needed for the public `ws` dependency.

Tar entries have sorted paths, fixed permissions, zero uid/gid/timestamps, and
no platform extensions. Gzip metadata is normalized. Rebuilding identical inputs
with the same Node/npm/zlib toolchain produces identical archive bytes; the test
checks this. The release workflow pins Node `24.22.0`. Different compression
toolchains can produce different compressed bytes, so regenerate the formula
from the artifact that will actually be uploaded rather than copying a checksum.

## Generate the formula from an actual archive

For a local, unpublished artifact:

```sh
node tools/adb-tunnel/packaging/generate-formula.mts \
  --artifact /tmp/stf-utils-release/stf-utils-0.1.0.tar.gz \
  --out /tmp/stf-utils-tap/Formula/stf-utils.rb
```

The default URL is the exact local `file://` archive. The generator verifies its
SHA-256 against its manifest and reads the version from its packaged metadata.
It refuses a changed archive and refuses an existing output formula.

For public distribution, provide `--url` with the approved immutable HTTPS asset
URL and optionally `--homepage`. A generated HTTPS formula is preparation until
the bytes at that URL have been uploaded and independently verified. Do not
publish a formula that points at a local file, an uncreated tag, or unavailable
assets. No public tap or release destination has been created by these scripts.

The formula declares `node@24` and calls that runtime explicitly. It is compatible
with the package's minimum Node `22.18.0`; versioned Node 24 is an available,
supported Homebrew runtime. Installation copies the bundled application into
`libexec` and writes a launcher; it does not invoke npm.

This follows Homebrew's requirements for an explicit runtime, checksummed sources,
local application dependencies and an installed functional test. See the official
[language packaging guide](https://docs.brew.sh/Language-Specific-Formulae),
[formula cookbook](https://docs.brew.sh/Formula-Cookbook), and
[Node 24 formula metadata](https://formulae.brew.sh/api/formula/node@24.json).

## Smoke without changing the user's Homebrew installation

```sh
node --test tools/adb-tunnel/packaging/test/*.test.mts

node tools/adb-tunnel/packaging/stage-release.mts \
  --artifact /tmp/stf-utils-release/stf-utils-0.1.0.tar.gz \
  --prefix /tmp/stf-utils-installed
/tmp/stf-utils-installed/bin/stf --version
/tmp/stf-utils-installed/bin/stf utils adb connect --help
```

The prefix must not exist. The staging helper verifies all archive entries and
file hashes and refuses links, traversal and replacement of an existing prefix.
Use `--node /path/to/node` to smoke a particular supported runtime. This exercises
the installed client and bundled dependency outside the checkout; it is not a
claim that Homebrew's installer has run. Tests also validate Ruby formula syntax.
No phone, local ADB server, credentials or registry network access is used by the
smoke tests after the npm dependency cache has been populated.

The release workflow also runs on relevant pull requests. A disposable `macos-15`
runner creates a fresh local tap with the downloaded archive's `file://` URL,
executes the real `brew install --build-from-source` and `brew test`, then removes
the trial formula/tap. It may install Node 24 on that disposable runner. This is
separate from the local staging smoke; no Homebrew installation or tap on the
developer's machine is changed by our tests. Publication waits for this job.

For a real local-tap trial, make the generated directory a Git
repository and choose a local tap identity. Then `brew tap USER/REPO /absolute/path/to/tap`,
`brew install --build-from-source USER/REPO/stf-utils` and
`brew test USER/REPO/stf-utils` exercise Homebrew itself. These commands change the
user's Homebrew installation and can install Node; they are deliberately not run
by the staging helper. Clean up only the trial formula/tap you created.

The formula supplies `stf`, which may already be the farm server's executable.
Homebrew's ordinary linking refuses a conflicting file. Never add
`brew link --overwrite` or `link_overwrite` to bypass that protection. Preserve
the existing server command and use the formula's full executable path
`$(brew --prefix USER/REPO/stf-utils)/bin/stf`, or deliberately arrange aliases/PATH.
There is no automatic replacement of an existing `stf`.

## Publish only after explicit release selection

`.github/workflows/stf-utils-release.yml` runs on an explicitly pushed
`stf-utils-v*` tag, or can prepare artifacts for an existing tag through
`workflow_dispatch` with `publish=false`. It verifies the tag format and exact
client package version. It never creates or pushes tags.

GitHub registers manual `workflow_dispatch` entry points only after the workflow
exists on the repository's default branch (`master` in this fork). Merging this
change into `develop` alone does not make the manual action available. A future
explicit version-tag push can run the workflow contained in that tagged commit;
the tag must include these files. No default-branch setting is changed here.

Publication runs only for that explicit tag event or a manual `publish=true` run,
and uses the `stf-utils-release` environment. Configure its required reviewers and
tag restrictions before enabling publication; GitHub does not add approval rules
automatically. Review the prepared artifact and formula before approving.
The publish job uses `gh release create --verify-tag` and refuses to overwrite an
existing release. It does not publish to npm, create a tap repository, or update
the independent farm server's release.

A dedicated approved Homebrew tap and uploaded immutable release asset are still
required before giving developers a public `brew install OWNER/TAP/stf-utils`
command. Copy the generated `Formula/stf-utils.rb` into that tap only after its
HTTPS download checksum matches the prepared artifact. Homebrew's
[tap guide](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap) describes that
separate repository structure.
