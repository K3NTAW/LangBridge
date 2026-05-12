// Prevents an additional console window from appearing on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sift_app_lib::run();
}
