//! Binary entry point for the Setu desktop app.
//!
//! All application logic lives in the library crate (`setu_lib`); this binary
//! only hands control to [`setu_lib::run`].

#![deny(missing_docs)]
// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    setu_lib::run()
}
