# Releasing Setu

How a Setu release is built, packaged, published, and — should the project
ever hold a paid Apple Developer Program membership — signed.
Every step runs on a Mac; nothing here needs CI. The examples use `1.0.0` —
substitute the version you are cutting.

## Prerequisites

- macOS 12+, either architecture (the universal build cross-compiles the
  other half)
- Rust stable with **both** Apple targets:

  ```sh
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  ```

- Node 20+, pnpm 9+, Xcode Command Line Tools
- [`gh`](https://cli.github.com/) authenticated for `rpandox/setu`
- For signing (optional — requires the paid Apple Developer Program, which the
  project currently does not have): a Developer ID Application certificate in
  your Keychain and an App Store Connect app-specific password

## 1 · Bump the version

The version lives in three files that must always agree:

| File                        | Key                 |
| --------------------------- | ------------------- |
| `package.json`              | `"version"`         |
| `src-tauri/Cargo.toml`      | `[package] version` |
| `src-tauri/tauri.conf.json` | `"version"`         |

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

The app lands at
`src-tauri/target/universal-apple-darwin/release/bundle/macos/Setu.app`,
ad-hoc signed (`signingIdentity: "-"` in `tauri.conf.json` — Apple silicon
refuses to execute unsigned arm64 binaries, so even local builds need at least
this).

Tauri's own DMG step (`bundle_dmg.sh`) drives Finder via AppleScript for the
window layout and fails in headless sessions — if it errors after "Bundling
…dmg", build the DMG by hand instead:

```sh
cd src-tauri/target/universal-apple-darwin/release/bundle/macos
mkdir -p dmg-stage ../dmg && cp -R Setu.app dmg-stage/ && ln -sf /Applications dmg-stage/Applications
hdiutil create -volname "Setu" -srcfolder dmg-stage -ov -format UDZO ../dmg/Setu_1.0.0_universal.dmg
rm -rf dmg-stage
```

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

## 7 · Unsigned releases (the current normal)

Releases ship **unsigned** (Tauri applies an ad-hoc signature — Apple silicon
refuses to execute binaries without at least that). Real signing needs the
paid Apple Developer Program, which this project doesn't have. Gatekeeper will
quarantine the first launch of a downloaded copy. Users have three documented
outs, in the cask caveats and the README:

- Install with the quarantine attribute never applied:
  ```sh
  brew install --cask --no-quarantine rpandox/tap/setu
  ```
- Right-click `Setu.app` → **Open** → **Open** (once; macOS remembers), or
- ```sh
  xattr -dr com.apple.quarantine /Applications/Setu.app
  ```

## 8 · Signing + notarization (if a Developer ID ever exists)

Kept for the day the project holds an Apple Developer Program membership —
none of this section is runnable without one. With a Developer ID Application
certificate installed, Tauri signs during the build when the identity is in
the environment:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)"
pnpm tauri build --target universal-apple-darwin
```

**Order matters: notarize and staple the app _before_ packaging.** A DMG or
tar.gz built first would carry an app copy with no embedded ticket — Gatekeeper
then blocks it for any user who extracts the app while offline (the ticket
stapled to a container does not follow the app out of it).

Notarize the app itself (zipped for submission; the ticket is keyed to the
code signature, so this one submission covers every copy of this build), then
staple the app:

```sh
cd src-tauri/target/universal-apple-darwin/release/bundle/macos
ditto -c -k --keepParent Setu.app Setu-notarize.zip
xcrun notarytool submit Setu-notarize.zip --keychain-profile setu-notary --wait
xcrun stapler staple Setu.app
rm Setu-notarize.zip
```

(`setu-notary` is a keychain profile created once with
`xcrun notarytool store-credentials setu-notary --apple-id <email> --team-id <team id>`,
which prompts for an app-specific password and stores it in the Keychain —
never in a file or shell history.)

Now rebuild both artifacts from the **stapled** app — the DMG via step 3's
`hdiutil` recipe, the tar.gz via step 4 (the sha256 changes) — then notarize
and staple the DMG container as well (a second submission; free, and it lets
the DMG itself validate offline), and confirm Gatekeeper accepts everything
before publishing:

```sh
xcrun notarytool submit ../dmg/Setu_1.0.1_universal.dmg --keychain-profile setu-notary --wait
xcrun stapler staple ../dmg/Setu_1.0.1_universal.dmg
spctl -a -vv --type execute Setu.app   # → accepted, source=Notarized Developer ID
xcrun stapler validate ../dmg/Setu_1.0.1_universal.dmg
```

Drop the quarantine caveat from the cask once notarized releases are the norm.

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
