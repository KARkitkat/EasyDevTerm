// Host-side (linux) integration test: a pty pretends to be an OpenWrt console;
// the same poll-read + write pattern as serial.rs must round-trip.
use std::io::{Read, Write};
use std::os::unix::io::RawFd;
use std::time::Duration;

fn main() {
    unsafe {
        let m: RawFd = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
        assert!(m >= 0);
        assert_eq!(libc::grantpt(m), 0);
        assert_eq!(libc::unlockpt(m), 0);
        let name = std::ffi::CStr::from_ptr(libc::ptsname(m)).to_string_lossy().into_owned();
        println!("slave pty: {}", name);

        let s: RawFd = libc::open(
            std::ffi::CString::new(name.clone()).unwrap().as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY,
        );
        assert!(s >= 0);
        std::thread::spawn(move || {
            use std::os::unix::io::FromRawFd;
            let mut f = std::fs::File::from(unsafe { std::fs::File::from_raw_fd(s) });
            let _ = f.write_all(b"OpenWrt 21.02 welcome\r\nroot@OpenWrt:/# ");
            let _ = f.flush();
            let mut buf = [0u8; 256];
            loop {
                match f.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = f.write_all(&buf[..n]);
                        if buf[..n].iter().any(|&b| b == b'\r') {
                            let _ = f.write_all(b"\r\nBusyBox v1.35\r\nroot@OpenWrt:/# ");
                        }
                        let _ = f.flush();
                    }
                }
            }
        });

        let mut port = serialport::new(&name, 115200)
            .timeout(Duration::from_millis(20))
            .open()
            .unwrap();
        port.write_data_terminal_ready(true).ok();
        port.write_all(b"help\r").unwrap();
        port.flush().unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut buf = [0u8; 4096];
        let mut got = Vec::new();
        while std::time::Instant::now() < deadline {
            match port.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => got.extend_from_slice(&buf[..n]),
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => {
                    println!("read err: {}", e);
                    break;
                }
            }
        }
        let text = String::from_utf8_lossy(&got);
        println!("received {} bytes: {:?}", got.len(), text);
        assert!(text.contains("OpenWrt"), "did not receive banner!");
        assert!(text.contains("help"), "echo missing!");
        println!("PASS: write+read+echo work through the same loop pattern");
    }
}
