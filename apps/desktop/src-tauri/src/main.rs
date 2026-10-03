//! Desktop entry point. All logic lives in the library crate so the same `run()` can be reused by
//! a future integration test harness without duplicating a `main`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    noltri_companion_lib::run();
}
