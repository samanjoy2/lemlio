// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Hidden CLI mode: when invoked with `--tectonic-compile <work_dir> <main_file>`,
    // run tectonic in this subprocess and exit. This isolates tectonic's global C state
    // so that a failed compilation doesn't poison the font cache for subsequent runs.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--reset-drive-backups") {
        match prismpro_desktop_lib::reset_drive_backups_headless() {
            Ok(result) => {
                println!("{}", result);
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("{}", error);
                std::process::exit(1);
            }
        }
    }
    if args.get(1).map(String::as_str) == Some("--backup-project") && args.len() >= 3 {
        match prismpro_desktop_lib::backup_project_headless(&args[2]) {
            Ok(result) => {
                println!("{}", result);
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("{}", error);
                std::process::exit(1);
            }
        }
    }
    if args.get(1).map(String::as_str) == Some("--clear-drive-setup") {
        match prismpro_desktop_lib::clear_drive_setup() {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("{}", error);
                std::process::exit(1);
            }
        }
    }
    if args.len() >= 3 && args[1] == "--configure-drive" {
        match prismpro_desktop_lib::configure_drive_client(std::path::Path::new(&args[2])) {
            Ok(()) => {
                eprintln!("Drive OAuth configuration saved locally");
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("{}", error);
                std::process::exit(1);
            }
        }
    }
    if args.len() >= 4 && args[1] == "--compile-project" {
        match prismpro_desktop_lib::compile_project_headless(
            &args[2],
            &args[3],
            !args.iter().any(|arg| arg == "--tectonic"),
        ) {
            Ok(size) => {
                eprintln!("Compiled PDF: {} bytes", size);
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("{}", error);
                std::process::exit(1);
            }
        }
    }
    if args.len() >= 4
        && matches!(
            args[1].as_str(),
            "--tectonic-compile" | "--system-tex-compile"
        )
    {
        let work_dir = std::path::Path::new(&args[2]);
        let main_file = &args[3];
        let result = if args[1] == "--system-tex-compile" {
            prismpro_desktop_lib::system_tex_compile_subprocess(work_dir, main_file)
        } else {
            prismpro_desktop_lib::tectonic_compile_subprocess(work_dir, main_file)
        };
        match result {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("{}", e);
                std::process::exit(1);
            }
        }
    }

    prismpro_desktop_lib::run()
}
