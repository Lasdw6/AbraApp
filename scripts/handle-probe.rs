use std::{process::{Command, Stdio}, os::windows::{process::CommandExt, io::AsRawHandle}};
#[link(name = "kernel32")]
unsafe extern "system" { fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32; }
fn main() {
    let mode = std::env::args().nth(1).unwrap();
    if mode == "child" { std::thread::sleep(std::time::Duration::from_secs(5)); return; }
    if mode == "clear" {
        for h in [std::io::stdin().as_raw_handle(), std::io::stdout().as_raw_handle(), std::io::stderr().as_raw_handle()] {
            assert_ne!(unsafe { SetHandleInformation(h, 1, 0) }, 0);
        }
    }
    let log = std::fs::File::create(std::env::temp_dir().join("probe.log")).unwrap();
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    if mode != "plain" { cmd.creation_flags(0x08000000); }
    let child = cmd.arg("child").stdin(Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log).spawn().unwrap();
    println!("{}", child.id());
}
