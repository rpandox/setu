# Releasing Setu

How a Setu release is built, packaged, published, and (from v1.0.1 on) signed.
Every step runs on a Mac; nothing here needs CI. The examples use `1.0.0` —
substitute the version you are cutting.

## Prerequisites

- macOS 12+ on Apple silicon (the universal build cross-compiles the Intel half)
- Rust stable with **both** Apple targets:

  ```sh
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  ```

- Node 20+, pnpm 9+, Xcode Command Line Tools
- [`gh`](https://cli.github.com/) authenticated for `rpandox/setu`
- For signing (v1.0.1+): an Apple Developer ID Application certificate in your
  Keychain and an App Store Connect app-specific password

## 1 · Bump the version

The version lives in three files that must always agree:

| File | Key |
|---|---|
| `package.json` | `"version"` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/tauri.conf.json` | `"version"` |

## 2 · Cut the CHANGELOG

In `CHANGELOG.md`, rename `## [Unreleased]` to `## [1.0.0] - YYYY-MM-DD` and add
a fresh, empty `## [Unreleased]` above it. The release notes in step 5 are
extracted from this section, so write it for users.

Commit the bump + changelog together:

```sh
git commit -am "chore(release): v1.0.0"
```

## 3 · Build the universal binary

```sh
pnpm install
pnpm tauri build --target universal-apple-darwin
```

Artifacts land under `src-tauri/target/universal-apple-darwin/release/bundle/`:

- `macos/Setu.app` — the app
- `dmg/Setu_1.0.0_universal.dmg` — the drag-to-Applications disk image

Verify both architecture slices and the size gate (< 25 MB):

```sh
lipo -archs src-tauri/target/universal-apple-darwin/release/bundle/macos/Setu.app/Contents/MacOS/setu
# → x86_64 arm64
du -sh src-tauri/target/universal-apple-darwin/release/bundle/macos/Setu.app
```

Optional: measure cold launch. `SETU_STARTUP_PROBE=1` makes the app print the
milliseconds from process start to page load on stderr:

```sh
SETU_STARTUP_PROBE=1 src-tauri/target/universal-apple-darwin/release/bundle/macos/Setu.app/Contents/MacOS/setu
```

## 4 · Package the cask artifact

The Homebrew cask installs a `.app.tar.gz` (lighter than the DMG and no mount
step); the DMG is attached to the release for direct downloads.

```sh
cd src-tauri/target/universal-apple-darwin/release/bundle/macos
tar -czf Setu_1.0.0_universal.app.tar.gz Setu.app
shasum -a 256 Setu_1.0.0_universal.app.tar.gz | tee Setu_1.0.0_universal.app.tar.gz.sha256
```

Keep the sha256 — the cask needs it in step 6.

## 5 · Tag and publish the GitHub release

Tag the commit that is actually on `main` (after the release PR merges):

```sh
git tag v1.0.0
git push origin v1.0.0
```

Create the release as a draft with notes from the CHANGELOG section, attach the
artifacts, then publish:

```sh
gh release create v1.0.0 --draft --title "Setu v1.0.0" --notes-file /tmp/notes.md
gh release upload v1.0.0 \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/Setu_1.0.0_universal.app.tar.gz \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/Setu_1.0.0_universal.app.tar.gz.sha256 \
  src-tauri/target/universal-apple-darwin/release/bundle/dmg/Setu_1.0.0_universal.dmg
gh release edit v1.0.0 --draft=false
```

(`/tmp/notes.md` = the `[1.0.0]` section of `CHANGELOG.md`, plus the install
one-liner and — while releases are unsigned — the quarantine note from step 7.)

## 6 · Update the Homebrew cask

The tap lives at [`rpandox/homebrew-tap`](https://github.com/rpandox/homebrew-tap);
the cask is `Casks/setu.rb`. For each release, update two lines — `version` and
`sha256` (from step 4) — commit, and push:

```sh
brew install --cask rpandox/tap/setu   # verifies url + sha256 resolve
```

## 7 · Unsigned releases (v1.0.0)

v1.0.0 ships **unsigned** (Tauri applies an ad-hoc signature). Gatekeeper will
quarantine the first launch of a downloaded copy. Users have two documented
outs, in the cask caveats and the README:

- Right-click `Setu.app` → **Open** → **Open** (once; macOS remembers), or
- ```sh
  xattr -dr com.apple.quarantine /Applications/Setu.app
  ```

## 8 · Signing + notarization (v1.0.1 and later)

With a Developer ID Application certificate installed, Tauri signs during the
build when the identity is in the environment:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)"
pnpm tauri build --target universal-apple-darwin
```

Then notarize the DMG and staple the ticket:

```sh
xcrun notarytool submit src-tauri/target/universal-apple-darwin/release/bundle/dmg/Setu_1.0.1_universal.dmg \
  --apple-id <apple id email> --team-id <team id> \
  --password <app-specific password> --wait
xcrun stapler staple src-tauri/target/universal-apple-darwin/release/bundle/dmg/Setu_1.0.1_universal.dmg
```

Re-create the `.app.tar.gz` from the signed app (the sha256 changes), and drop
the quarantine caveat from the cask once notarized releases are the norm.

Tauri can also notarize inline during the build when `APPLE_ID`,
`APPLE_PASSWORD`, and `APPLE_TEAM_ID` are exported — either path is fine; the
explicit `notarytool` flow above is easier to debug.

## Rolling back

A bad release is deleted, not patched in place:

```sh
gh release delete v1.0.0 --yes
git push origin :refs/tags/v1.0.0
git tag -d v1.0.0
```

Then revert the cask bump in the tap (or point it back at the previous
version/sha256). Version numbers are never reused — the next attempt is a patch
bump.

## Reference

- App icon regeneration: [docs/dev/release.md](docs/dev/release.md)
- Release size/profile decisions: `PLAN.md` §5 (Phase 9 kickoff rows)
- What must be true before any release: the verify suite and the
  Documentation Gate (`PLAN.md` §6.4)
