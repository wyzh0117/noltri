use std::path::PathBuf;
use std::process::Command;

fn main() {
    // tauri-build validates tauri.conf.json + capabilities and embeds the frontend assets.
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        link_ax_native_library();
    }
}

fn link_ax_native_library() {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let package = manifest.join("native-ax-p0-spike");
    let scratch = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("ax-swift");
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported macOS architecture for AX native bridge"),
    };
    let triple = format!("{arch}-apple-macosx13.5");

    println!("cargo:rerun-if-changed={}", package.join("Package.swift").display());
    println!("cargo:rerun-if-changed={}", package.join("Sources").display());

    let mut build = Command::new("swift");
    build.args([
        "build",
        "--package-path",
        package.to_str().expect("package path"),
        "--scratch-path",
        scratch.to_str().expect("scratch path"),
        "--product",
        "NoltriAXP0Spike",
        "--configuration",
        "release",
        "--triple",
        &triple,
    ]);
    let status = build.status().expect("Swift compiler is required for macOS AX bridge");
    assert!(status.success(), "failed to build the in-process Swift AX bridge");

    let output = Command::new("swift")
        .args([
            "build",
            "--package-path",
            package.to_str().expect("package path"),
            "--scratch-path",
            scratch.to_str().expect("scratch path"),
            "--configuration",
            "release",
            "--triple",
            &triple,
            "--show-bin-path",
        ])
        .output()
        .expect("Swift compiler is required for macOS AX bridge");
    assert!(output.status.success(), "could not locate Swift AX library output");
    let bin = String::from_utf8(output.stdout).expect("Swift output path is UTF-8");
    println!("cargo:rustc-link-search=native={}", bin.trim());
    println!("cargo:rustc-link-lib=static=NoltriAXP0Spike");
    println!("cargo:rustc-link-lib=framework=ApplicationServices");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");
}
