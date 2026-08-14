/**
 * Frontend entry point: loads the bundled fonts and global styles, then
 * mounts the shell this window asked for. The Settings window (Phase 8)
 * is a second webview serving this same bundle, routed by its URL —
 * `?window=settings` mounts {@link SettingsWindow} instead of the app
 * (PLAN.md §5, settings-window-mechanics row).
 */
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/space-grotesk";
import "../styles/tokens.css";
import "../styles/base.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { SettingsWindow } from "../features/settings/SettingsWindow";

const isSettingsWindow =
  new URLSearchParams(window.location.search).get("window") === "settings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isSettingsWindow ? <SettingsWindow /> : <App />}</React.StrictMode>,
);
