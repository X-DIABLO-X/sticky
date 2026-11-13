#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
extern "system" {
    fn AttachConsole(dwProcessId: u32) -> i32;
}

fn main() {
    #[cfg(windows)]
    unsafe {
        // Attach to calling terminal so stdout / stderr logs display if launched from command line
        let _ = AttachConsole(0xFFFFFFFF); // ATTACH_PARENT_PROCESS
    }

    heyclicky_lib::run();
}
