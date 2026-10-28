fn main() {
    // On Linux, apply a version script to hide statically linked ICU/HarfBuzz/
    // FreeType/Fontconfig symbols from the dynamic symbol table.  This prevents
    // symbol collisions with the system copies loaded by WebKit2GTK (segfault).
    // See: https://github.com/delibae/claude-prism/issues/100
    #[cfg(target_os = "linux")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        println!(
            "cargo:rustc-link-arg=-Wl,--version-script={}/symbols.map",
            manifest_dir
        );
        println!("cargo:rerun-if-changed=symbols.map");
    }

    tauri_build::build()
}
