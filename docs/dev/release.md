# Releasing

The complete release workflow — universal build, packaging, GitHub release,
Homebrew cask, signing/notarization — lives in
[RELEASING.md](../../RELEASING.md) at the repository root. This page keeps the
asset pipelines that feed it.

## App icon pipeline (Phase 4)

The icon source of truth is `assets/app-icon.svg` — the LED-bridge glyph
on the Phosphor near-black (§7 tokens, values inlined because SVG can't
read `tokens.css`). To change the icon, edit the SVG and regenerate:

```sh
rsvg-convert -w 1024 -h 1024 assets/app-icon.svg -o assets/app-icon.png
pnpm tauri icon assets/app-icon.png
rm -rf src-tauri/icons/android src-tauri/icons/ios   # macOS-only v1
```

`rsvg-convert` comes from `brew install librsvg`. The generated
`src-tauri/icons/` files are committed; `tauri.conf.json` already points
at them.
