# Third-party notices

Setu bundles the following fonts, all licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org/) (OFL-1.1). They are
packaged from [Fontsource](https://fontsource.org/) npm packages and shipped
with the app — nothing is fetched at runtime.

| Font           | Copyright                            | Package                               |
| -------------- | ------------------------------------ | ------------------------------------- |
| Inter          | © The Inter Project Authors          | `@fontsource-variable/inter`          |
| JetBrains Mono | © The JetBrains Mono Project Authors | `@fontsource-variable/jetbrains-mono` |
| Space Grotesk  | © Florian Karsten                    | `@fontsource-variable/space-grotesk`  |

Full OFL license texts ship inside each package under
`node_modules/@fontsource-variable/*/LICENSE` and in the app bundle.

## Notable dependencies

Setu is built on open source. The load-bearing pieces:

- [Tauri](https://tauri.app/) (MIT/Apache-2.0) — application framework.
- [React](https://react.dev/) (MIT) — UI.
- [Vite](https://vite.dev/) (MIT) — build tooling.
- [xterm.js](https://xtermjs.org/) (MIT) — terminal renderer (from Phase 1).
- [portable-pty](https://crates.io/crates/portable-pty) (MIT) — PTY layer (from Phase 1).
- [russh](https://crates.io/crates/russh) (Apache-2.0) — SFTP protocol (from Phase 5).

A complete dependency list with licenses lives in `pnpm-lock.yaml` and
`src-tauri/Cargo.lock`.
