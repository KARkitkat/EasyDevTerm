// Mirror of src-tauri/src/telnet.rs iac_filter for host-side unit testing.
// Keep in sync with the tauri crate (checked by test parity in CI habit).
pub const IAC: u8 = 255;
pub const DONT: u8 = 254;
pub const DO: u8 = 253;
pub const WONT: u8 = 252;
pub const WILL: u8 = 251;
pub const SB: u8 = 250;
pub const SE: u8 = 240;

pub fn iac_filter(input: &[u8], out: &mut Vec<u8>, replies: &mut Vec<u8>) {
    let mut i = 0;
    while i < input.len() {
        let b = input[i];
        if b != IAC {
            out.push(b);
            i += 1;
            continue;
        }
        if i + 1 >= input.len() {
            break;
        }
        match input[i + 1] {
            IAC => {
                out.push(IAC);
                i += 2;
            }
            DO | DONT => {
                if i + 2 >= input.len() {
                    break;
                }
                replies.push(IAC);
                replies.push(if input[i + 1] == DO { WONT } else { DONT });
                replies.push(input[i + 2]);
                i += 3;
            }
            WILL | WONT => {
                if i + 2 >= input.len() {
                    break;
                }
                replies.push(IAC);
                replies.push(if input[i + 1] == WILL { DONT } else { DO });
                replies.push(input[i + 2]);
                i += 3;
            }
            SB => {
                let mut j = i + 2;
                while j + 1 < input.len() && !(input[j] == IAC && input[j + 1] == SE) {
                    j += 1;
                }
                i = if j + 1 < input.len() { j + 2 } else { input.len() };
            }
            _ => {
                i += 2;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::iac_filter;

    fn filt(input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut out = Vec::new();
        let mut replies = Vec::new();
        iac_filter(input, &mut out, &mut replies);
        (out, replies)
    }

    #[test]
    fn passthrough_plain_data() {
        let (out, replies) = filt(b"root@OpenWrt:/# ");
        assert_eq!(out, b"root@OpenWrt:/# ");
        assert!(replies.is_empty());
    }

    #[test]
    fn refuse_will_option() {
        let (out, replies) = filt(&[255, 251, 1]);
        assert!(out.is_empty());
        assert_eq!(replies, vec![255, 254, 1]);
    }

    #[test]
    fn refuse_do_option() {
        let (out, replies) = filt(&[255, 253, 3]);
        assert!(out.is_empty());
        assert_eq!(replies, vec![255, 252, 3]);
    }

    #[test]
    fn escaped_0xff_data() {
        let (out, replies) = filt(&[0x01, 255, 255, 0x02]);
        assert_eq!(out, vec![0x01, 255, 0x02]);
        assert!(replies.is_empty());
    }

    #[test]
    fn skip_subnegotiation() {
        // IAC SB <params> IAC SE, then following data passes through
        let (out, replies) = filt(&[255, 250, 24, 0, 88, 255, 240, 65, 66]);
        assert_eq!(out, vec![65, 66]);
        assert!(replies.is_empty());
    }

    #[test]
    fn mixed_stream() {
        let input: Vec<u8> = {
            let mut v = b"Welcome\r\n".to_vec();
            v.extend_from_slice(&[255, 251, 1]);
            v.extend_from_slice(&[255, 251, 3]);
            v.extend_from_slice(b"login: ");
            v
        };
        let (out, replies) = filt(&input);
        assert_eq!(out, b"Welcome\r\nlogin: ");
        assert_eq!(replies, vec![255, 254, 1, 255, 254, 3]);
    }

    #[test]
    fn incomplete_trailing_iac_dropped() {
        let (out, replies) = filt(&[65, 255, 251]);
        assert_eq!(out, vec![65]);
        assert!(replies.is_empty());
    }

    #[test]
    fn base64_roundtrip() {
        // mirror of serial base64 helpers used by all transports
        fn enc(data: &[u8]) -> String {
            const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut out = String::new();
            for chunk in data.chunks(3) {
                let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
                let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
                out.push(TABLE[(n >> 18 & 63) as usize] as char);
                out.push(TABLE[(n >> 12 & 63) as usize] as char);
                out.push(if chunk.len() > 1 { TABLE[(n >> 6 & 63) as usize] as char } else { '=' });
                out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
            }
            out
        }
        fn dec(s: &str) -> Option<Vec<u8>> {
            fn val(c: u8) -> Option<u32> {
                match c {
                    b'A'..=b'Z' => Some((c - b'A') as u32),
                    b'a'..=b'z' => Some((c - b'a' + 26) as u32),
                    b'0'..=b'9' => Some((c - b'0' + 52) as u32),
                    b'+' => Some(62),
                    b'/' => Some(63),
                    _ => None,
                }
            }
            let s: Vec<u8> = s.bytes().filter(|b| !b" \r\n\t".contains(b)).collect();
            let mut out = Vec::new();
            for chunk in s.chunks(4) {
                if chunk.len() < 2 { break; }
                let mut n = 0u32;
                let mut bits = 0u32;
                for (i, &c) in chunk.iter().enumerate() {
                    if c == b'=' { break; }
                    let v = val(c)?;
                    n |= v << (18 - 6 * i);
                    bits += 6;
                }
                let take = (bits / 8) as usize;
                out.push((n >> 16) as u8);
                if take > 1 { out.push((n >> 8) as u8); }
                if take > 2 { out.push(n as u8); }
            }
            Some(out)
        }
        for sample in [&b"\r\n"[..], b"hello world", &[0u8, 255, 1, 2, 3][..]] {
            assert_eq!(dec(&enc(sample)).as_deref(), Some(sample), "roundtrip failed for {sample:?}");
        }
    }
}

// ---------------- TFTP packet codec tests (mirror of tftp.rs) ----------------

pub mod tftp_codec {
    pub const OPCODE_RRQ: u16 = 1;
    pub const OPCODE_WRQ: u16 = 2;
    pub const OPCODE_DATA: u16 = 3;
    pub const OPCODE_ACK: u16 = 4;
    pub const OPCODE_ERROR: u16 = 5;
    pub const OPCODE_OACK: u16 = 6;

    #[derive(Debug, PartialEq)]
    pub struct Request {
        pub opcode: u16,
        pub filename: String,
        pub mode: String,
        pub blksize: Option<usize>,
    }

    pub fn parse_request(buf: &[u8]) -> Option<Request> {
        if buf.len() < 4 {
            return None;
        }
        let opcode = u16::from_be_bytes([buf[0], buf[1]]);
        if opcode != OPCODE_RRQ && opcode != OPCODE_WRQ {
            return None;
        }
        let mut parts = buf[2..].split(|&b| b == 0);
        let filename = String::from_utf8_lossy(parts.next()?).to_string();
        let mode = String::from_utf8_lossy(parts.next()?).to_string();
        let mut blksize = None;
        loop {
            let opt = parts.next()?;
            if opt.is_empty() {
                break;
            }
            let val = parts.next()?;
            if String::from_utf8_lossy(opt).to_ascii_lowercase() == "blksize" {
                if let Ok(n) = String::from_utf8_lossy(val).parse::<usize>() {
                    blksize = Some(n.clamp(8, 65464));
                }
            }
        }
        Some(Request { opcode, filename, mode: mode.to_ascii_lowercase(), blksize })
    }

    pub fn make_data(block: u16, payload: &[u8]) -> Vec<u8> {
        let mut v = vec![0, 3, 0, 0];
        v[0..2].copy_from_slice(&OPCODE_DATA.to_be_bytes());
        v[2..4].copy_from_slice(&block.to_be_bytes());
        v.extend_from_slice(payload);
        v
    }

    pub fn make_ack(block: u16) -> Vec<u8> {
        let mut v = Vec::with_capacity(4);
        v.extend_from_slice(&OPCODE_ACK.to_be_bytes());
        v.extend_from_slice(&block.to_be_bytes());
        v
    }

    pub fn make_error(code: u16, msg: &str) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&OPCODE_ERROR.to_be_bytes());
        v.extend_from_slice(&code.to_be_bytes());
        v.extend_from_slice(msg.as_bytes());
        v.push(0);
        v
    }

    pub fn make_oack(blksize: usize) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&OPCODE_OACK.to_be_bytes());
        v.extend_from_slice(b"blksize\0");
        v.extend_from_slice(blksize.to_string().as_bytes());
        v.push(0);
        v
    }

    pub fn parse_ack(buf: &[u8]) -> Option<u16> {
        if buf.len() < 4 || u16::from_be_bytes([buf[0], buf[1]]) != OPCODE_ACK {
            return None;
        }
        Some(u16::from_be_bytes([buf[2], buf[3]]))
    }

    pub fn parse_oack(buf: &[u8]) -> Option<usize> {
        if buf.len() < 2 || u16::from_be_bytes([buf[0], buf[1]]) != OPCODE_OACK {
            return None;
        }
        let mut parts = buf[2..].split(|&b| b == 0);
        while let Some(opt) = parts.next() {
            if opt.is_empty() { break; }
            let val = parts.next()?;
            if String::from_utf8_lossy(opt).to_ascii_lowercase() == "blksize" {
                return String::from_utf8_lossy(val).parse().ok();
            }
        }
        None
    }

    pub fn parse_error(buf: &[u8]) -> Option<(u16, String)> {
        if buf.len() < 5 || u16::from_be_bytes([buf[0], buf[1]]) != OPCODE_ERROR {
            return None;
        }
        let code = u16::from_be_bytes([buf[2], buf[3]]);
        let msg = String::from_utf8_lossy(&buf[4..buf.len() - 1]).to_string();
        Some((code, msg))
    }
}

#[cfg(test)]
mod tftp_tests {
    use super::tftp_codec::*;

    #[test]
    fn parse_rrq_with_blksize() {
        let mut pkt = vec![0, 1];
        pkt.extend_from_slice(b"firmware.bin\0");
        pkt.extend_from_slice(b"octet\0");
        pkt.extend_from_slice(b"blksize\01468\0");
        let r = parse_request(&pkt).unwrap();
        assert_eq!(r.opcode, OPCODE_RRQ);
        assert_eq!(r.filename, "firmware.bin");
        assert_eq!(r.mode, "octet");
        assert_eq!(r.blksize, Some(1468));
    }

    #[test]
    fn parse_wrq_no_options() {
        let mut pkt = vec![0, 2];
        pkt.extend_from_slice(b"backup.tar.gz\0octet\0");
        let r = parse_request(&pkt).unwrap();
        assert_eq!(r.opcode, OPCODE_WRQ);
        assert_eq!(r.blksize, None);
    }

    #[test]
    fn parse_rejects_data_as_request() {
        assert!(parse_request(&make_data(1, b"x")).is_none());
    }

    #[test]
    fn data_ack_roundtrip() {
        let d = make_data(7, b"hello");
        assert_eq!(&d[0..4], &[0, 3, 0, 7]);
        assert_eq!(&d[4..], b"hello");
        assert_eq!(parse_ack(&make_ack(7)), Some(7));
        assert_eq!(parse_ack(&make_data(7, b"")), None);
    }

    #[test]
    fn oack_roundtrip() {
        let pkt = make_oack(1468);
        assert_eq!(parse_oack(&pkt), Some(1468));
        assert_eq!(parse_oack(&make_ack(0)), None);
    }

    #[test]
    fn error_parse() {
        let pkt = make_error(1, "file not found");
        assert_eq!(parse_error(&pkt), Some((1, "file not found".into())));
    }
}

// ---------------- ls -F output parser tests (mirror of rsh.rs) ----------------

#[derive(Debug, PartialEq)]
pub struct RshEntry {
    pub name: String,
    pub is_dir: bool,
}

pub fn parse_ls_f(out: &str) -> Vec<RshEntry> {
    let mut v = Vec::new();
    for line in out.lines() {
        let l = line.trim_end();
        if l.is_empty() || l.starts_with("total ") || l.contains("__DTS__") || l.contains("__DTE__") {
            continue;
        }
        // Long format detection: perms string as first token.
        let first = l.split_whitespace().next().unwrap_or("");
        let is_long = first.len() >= 9
            && first
                .starts_with(|c: char| matches!(c, '-' | 'd' | 'l' | 's' | 'b' | 'c' | 'p'))
            && first.chars().skip(1).all(|c| matches!(c, 'r' | 'w' | 'x' | '-' | 's' | 'S' | 't' | 'T'));
        if is_long {
            let ftype = first.chars().next().unwrap();
            let Some(name) = l.split_whitespace().next_back() else { continue };
            if name.is_empty() || name == "." || name == ".." { continue; }
            let is_dir = ftype == 'd';
            let mut name: &str = &name;
            if name.ends_with(['=', '*', '@']) { name = &name[..name.len() - 1]; }
            if name.ends_with('/') { name = &name[..name.len() - 1]; }
            if name.is_empty() { continue; }
            v.push(RshEntry { name: name.to_string(), is_dir });
            continue;
        }
        let is_dir = l.ends_with('/');
        let mut name = l.to_string();
        if name.ends_with('/') || name.ends_with('*') || name.ends_with('@') || name.ends_with('=') {
            name.pop();
        }
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        v.push(RshEntry { name, is_dir });
    }
    v
}

#[cfg(test)]
mod rsh_tests {
    use super::{parse_ls_f, RshEntry};

    #[test]
    fn parse_busybox_ls_f() {
        // `ls -F <path> | cat` yields bare names with classification suffixes
        let out = "__DTS__\nbin/\netc/\nsh*\nnote.txt\nlinuxrc@\n__DTE__:0";
        let entries = parse_ls_f(out);
        assert_eq!(
            entries,
            vec![
                RshEntry { name: "bin".into(), is_dir: true },
                RshEntry { name: "etc".into(), is_dir: true },
                RshEntry { name: "sh".into(), is_dir: false },
                RshEntry { name: "note.txt".into(), is_dir: false },
                RshEntry { name: "linuxrc".into(), is_dir: false },
            ]
        );
    }

    #[test]
    fn parse_empty_dir() {
        assert!(parse_ls_f("__DTS__\n__DTE__:0").is_empty());
    }

    #[test]
    fn parse_skips_total_line() {
        let out = "total 12\nbin/";
        let entries = parse_ls_f(out);
        assert_eq!(entries, vec![RshEntry { name: "bin".into(), is_dir: true }]);
    }
}

// ---------------- marker extraction (mirror of rsh.rs exec_raw) ----------------

pub fn extract_between_markers(collected: &str) -> String {
    let find_line_start = |hay: &str, needle: &str, from: usize| -> Option<usize> {
        let bytes = hay.as_bytes();
        let mut idx = from;
        while let Some(p) = hay[idx..].find(needle) {
            let abs = idx + p;
            if abs == 0 || bytes[abs - 1] == b'\n' || bytes[abs - 1] == b'\r' {
                return Some(abs);
            }
            idx = abs + needle.len();
            if idx >= hay.len() {
                return None;
            }
        }
        None
    };
    let start = find_line_start(collected, "__DTS__", 0).map(|p| p + "__DTS__".len());
    let Some(start) = start else {
        return String::new();
    };
    let Some(end_rel) = find_line_start(collected, "__DTE__:", start) else {
        return String::new();
    };
    collected[start..end_rel]
        .trim_start_matches(['\r', '\n'])
        .lines()
        .filter(|l| !l.contains("__DTS__") && !l.contains("__DTE__"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod marker_tests {
    use super::extract_between_markers;

    #[test]
    fn skips_echoed_command_with_markers() {
        // telnetd echoes the typed line; markers inside it are mid-line
        let raw = "echo __DTS__; ls -F /bin 2>&1 | cat; echo __DTE__:$?\r\n__DTS__\r\nash/\r\nbusybox*\r\n__DTE__:0\r\nroot@MeshLink:~# ";
        let out = extract_between_markers(raw);
        assert_eq!(out, "ash/\nbusybox*");
    }

    #[test]
    fn works_without_echo() {
        let raw = "__DTS__\nbin/\n__DTE__:0\n";
        assert_eq!(extract_between_markers(raw), "bin/");
    }

    #[test]
    fn no_marker_returns_empty() {
        assert_eq!(extract_between_markers("garbage"), "");
    }

    #[test]
    fn error_path_markers() {
        let raw = "echo __DTS__; ls -F /nope 2>&1 | cat; echo __DTE__:$?\r\n__DTS__\r\nls: /nope: No such file or directory\r\n__DTE__:1\r\n";
        let out = extract_between_markers(raw);
        assert!(out.contains("No such file"), "got: {out}");
    }
}

#[cfg(test)]
mod longformat_tests {
    use super::{parse_ls_f, RshEntry};

    #[test]
    fn parse_long_format_sockets() {
        // the user's real-world case: socket files listed in long format
        let out = "srw-------    1 root     root             0 Nov 24 13:38 ipc_ioos\nsrw-------    1 root     root             0 Nov 24 13:38 ipc_path_mux\n-rw-------    1 root     root           123 Nov 24 13:38 config.json\ndrwxr-xr-x    2 root     root            76 Nov 24 13:38 subdir";
        let entries = parse_ls_f(out);
        assert_eq!(
            entries,
            vec![
                RshEntry { name: "ipc_ioos".into(), is_dir: false },
                RshEntry { name: "ipc_path_mux".into(), is_dir: false },
                RshEntry { name: "config.json".into(), is_dir: false },
                RshEntry { name: "subdir".into(), is_dir: true },
            ]
        );
    }

    #[test]
    fn long_format_with_f_suffix_still_strips() {
        let out = "-rwxr-xr-x    1 root     root           999 Jan  1 00:00 sh*";
        let entries = parse_ls_f(out);
        assert_eq!(entries, vec![RshEntry { name: "sh".into(), is_dir: false }]);
    }

    #[test]
    fn bare_names_still_work() {
        let out = "bin/\nsh*\nnote.txt\nipc_ioos=";
        let entries = parse_ls_f(out);
        assert_eq!(
            entries,
            vec![
                RshEntry { name: "bin".into(), is_dir: true },
                RshEntry { name: "sh".into(), is_dir: false },
                RshEntry { name: "note.txt".into(), is_dir: false },
                RshEntry { name: "ipc_ioos".into(), is_dir: false },
            ]
        );
    }
}
