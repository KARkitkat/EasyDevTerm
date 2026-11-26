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

        // The MASTER fd is the "cable end" the fake device reads/writes.
        // (slave = what serialport opens as the "port")
        std::thread::spawn(move || {
            use std::os::unix::io::FromRawFd;
            let mut f = std::fs::File::from(unsafe { std::fs::File::from_raw_fd(m) });
            let _ = f.write_all(b"BANNER\r\n");
            let _ = f.flush();
            let mut buf = [0u8; 256];
            loop {
                match f.read(&mut buf) {
                    Ok(0) | Err(_) => { println!("[device] master read end"); break; }
                    Ok(n) => {
                        println!("[device] got: {:?}", String::from_utf8_lossy(&buf[..n]));
                        let _ = f.write_all(b"ECHO:");
                        let _ = f.write_all(&buf[..n]);
                        let _ = f.flush();
                    }
                }
            }
        });
        std::thread::sleep(Duration::from_millis(200));

        // Simple blocking write+read first (no timeout polling):
        let mut port = serialport::new(&name, 115200)
            .timeout(Duration::from_millis(1000))
            .open()
            .unwrap();
        port.write_all(b"hello\r").unwrap();
        port.flush().unwrap();
        println!("[app] wrote hello, blocking read with 1s timeout...");
        let mut buf = [0u8; 256];
        match port.read(&mut buf) {
            Ok(n) => println!("[app] read {} bytes: {:?}", n, String::from_utf8_lossy(&buf[..n])),
            Err(e) => println!("[app] read err: {} ({:?})", e, e.kind()),
        }
    }
}
