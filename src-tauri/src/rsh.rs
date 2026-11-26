//! Hidden shell session: an invisible Telnet connection used to run
//! commands (ls/pwd/tftp) on the device without touching the user's
//! visible terminal. One session per device IP, cached and reused.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::State;

use crate::telnet::iac_filter;

const LOGIN_TIMEOUT_MS: u64 = 8000;
const EXEC_TIMEOUT_MS: u64 = 5000;

pub struct RshManager {
    sessions: Mutex<HashMap<String, RshSession>>,
}

impl Default for RshManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

pub struct RshSession {
    stream: TcpStream,
    /// leftover bytes after the last exec (partially received lines etc.)
    buf: Vec<u8>,
}

#[derive(Debug, serde::Deserialize)]
pub struct RshConnectArgs {
    pub host: String,
    #[serde(default = "default_telnet_port")]
    pub port: u16,
    #[serde(default = "default_user")]
    pub user: String,
    #[serde(default)]
    pub password: String,
}

fn default_telnet_port() -> u16 {
    23
}
fn default_user() -> String {
    "root".into()
}

/// Connect + login. Returns Ok once a shell prompt is (heuristically) seen.
fn connect_and_login(host: &str, port: u16, user: &str, pass: &str) -> Result<RshSession, String> {
    let stream = crate::telnet::connect_timeout(
        &format!("{host}:{port}"),
        Duration::from_millis(crate::telnet::CONNECT_TIMEOUT_MS),
    )?;
    stream.set_nodelay(true).ok();
    stream
        .set_read_timeout(Some(Duration::from_millis(300)))
        .ok();
    let mut s = RshSession {
        stream,
        buf: Vec::new(),
    };

    let deadline = Instant::now() + Duration::from_millis(LOGIN_TIMEOUT_MS);
    let mut seen_login_prompt = false;
    let mut seen_password_prompt = false;
    let mut seen_prompt = false;

    while Instant::now() < deadline {
        let chunk = s.read_available();
        if !chunk.is_empty() {
            let text = String::from_utf8_lossy(&chunk).to_string();
            let lower = text.to_lowercase();
            if lower.contains("login:") {
                seen_login_prompt = true;
                let _ = s.stream.write_all(user.as_bytes());
                let _ = s.stream.write_all(b"\r\n");
            } else if lower.contains("password:") {
                seen_password_prompt = true;
                let _ = s.stream.write_all(pass.as_bytes());
                let _ = s.stream.write_all(b"\r\n");
            } else if (seen_login_prompt || seen_password_prompt || !lower.is_empty())
                && (text.trim_end().ends_with('#') || text.trim_end().ends_with('$'))
            {
                // crude prompt heuristic: last non-empty line ends with # or $
                let last = text.lines().next_back().unwrap_or("").trim_end();
                if last.ends_with('#') || last.ends_with('$') {
                    seen_prompt = true;
                }
            }
        }
        if seen_prompt {
            // Verify the shell actually executes commands: send an echo and
            // wait for its output in the raw stream (exec_raw extracts between
            // __DTS__/__DTE__ which this probe doesn't emit, so probe directly).
            let _ = s.stream.write_all(b"echo __RDY__\r\n");
            let verify_deadline = Instant::now() + Duration::from_millis(2000);
            let mut got = false;
            loop {
                if Instant::now() > verify_deadline {
                    break;
                }
                let chunk = s.read_available();
                if !chunk.is_empty() {
                    if String::from_utf8_lossy(&chunk).contains("__RDY__") {
                        got = true;
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if got {
                return Ok(s);
            }
            seen_prompt = false; // keep waiting/verifying
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("登录超时:未识别到 shell 提示符(检查用户名/密码设置)".into())
}

impl RshSession {
    /// Read whatever is available now (with IAC filtering).
    fn read_available(&mut self) -> Vec<u8> {
        let mut tmp = [0u8; 4096];
        let mut out = Vec::new();
        loop {
            match self.stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    let mut clean = Vec::with_capacity(n);
                    let mut replies = Vec::new();
                    iac_filter(&tmp[..n], &mut clean, &mut replies);
                    if !replies.is_empty() {
                        let _ = self.stream.write_all(&replies);
                    }
                    out.extend_from_slice(&clean);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => break,
                Err(_) => break,
            }
        }
        self.buf.extend_from_slice(&out);
        std::mem::take(&mut self.buf)
    }

    /// Run a command wrapped in markers; returns output between the markers.
    /// Markers are matched at LINE START only: busybox telnetd echoes the
    /// typed command line back, and that echo contains the marker text
    /// mid-line ("echo __DTS__; ... __DTE__:$?"), which would otherwise be
    /// picked up as the markers.
    fn exec_raw(&mut self, cmd: &str) -> String {
        // clear pending input
        let _ = self.read_available();
        let _ = self.stream.write_all(cmd.as_bytes());
        let _ = self.stream.write_all(b"\r\n");

        let deadline = Instant::now() + Duration::from_millis(EXEC_TIMEOUT_MS);
        let mut collected = String::new();
        loop {
            if Instant::now() > deadline {
                break;
            }
            let chunk = self.read_available();
            if chunk.is_empty() {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            collected.push_str(&String::from_utf8_lossy(&chunk));
            if collected.contains("__DTE__:") {
                break;
            }
        }
        // start marker: "__DTS__" at start of a line (after \n or at pos 0);
        // end marker: "__DTE__:" at start of a line after the start marker.
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
        let start = find_line_start(&collected, "__DTS__", 0).map(|p| p + "__DTS__".len());
        let Some(start) = start else {
            return String::new();
        };
        let Some(end_rel) = find_line_start(&collected, "__DTE__:", start) else {
            return String::new();
        };
        collected[start..end_rel]
            .trim_start_matches(['\r', '\n'])
            .lines()
            .filter(|l| !l.contains("__DTS__") && !l.contains("__DTE__"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Get-or-create the cached session for an IP.
fn with_session<T>(
    mgr: &RshManager,
    args: &RshConnectArgs,
    f: impl Fn(&mut RshSession) -> Result<T, String>,
) -> Result<T, String> {
    {
        let mut map = mgr.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(&args.host) {
            match f(s) {
                Ok(v) => return Ok(v),
                Err(_) => {
                    // stale session: drop and reconnect below
                    map.remove(&args.host);
                }
            }
        }
    }
    let mut s = connect_and_login(&args.host, args.port, &args.user, &args.password)?;
    let r = f(&mut s);
    if r.is_ok() {
        mgr.sessions
            .lock()
            .unwrap()
            .insert(args.host.clone(), s);
    }
    r
}

/// Run `cmd` on the hidden shell of host.
#[tauri::command]
pub async fn rsh_exec(
    mgr: State<'_, std::sync::Arc<RshManager>>,
    args: RshConnectArgs,
    cmd: String,
) -> Result<String, String> {
    let mgr = mgr.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_session(&mgr, &args, |s| {
            let marker_cmd = format!("echo __DTS__; {cmd}; echo __DTE__:$?");
            Ok(s.exec_raw(&marker_cmd))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// pwd on the hidden shell (initial browser dir).
#[tauri::command]
pub async fn rsh_pwd(
    mgr: State<'_, std::sync::Arc<RshManager>>,
    args: RshConnectArgs,
) -> Result<String, String> {
    let mgr = mgr.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_session(&mgr, &args, |s| {
            let out = s.exec_raw("echo __DTS__; pwd; echo __DTE__:$?");
            Ok(out.lines().next_back().unwrap_or("/").trim().to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, serde::Serialize)]
pub struct RshEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Parse `ls -F` output lines into entries. Some devices print long format
/// (perms + links + owner + group + size + date + name) even with -F (busybox
/// variants / aliases), so both shapes are handled:
///   bare:   bin/  sh*  note.txt  ipc_ioos=
///   long:   srw------- 1 root root 0 Nov 24 13:38 ipc_ioos
pub fn parse_ls_f(out: &str) -> Vec<RshEntry> {
    let mut v = Vec::new();
    for line in out.lines() {
        let l = line.trim_end();
        if l.is_empty() || l.starts_with("total ") || l.contains("__DTS__") || l.contains("__DTE__") {
            continue;
        }
        // Long format: first token is a permission string like -rw-r--r--,
        // srw-------, drwxr-xr-x (file-type char + >=8 of rwxstST-).
        let first = l.split_whitespace().next().unwrap_or("");
        let is_long = first.len() >= 9
            && first
                .starts_with(|c: char| matches!(c, '-' | 'd' | 'l' | 's' | 'b' | 'c' | 'p'))
            && first.chars().skip(1).all(|c| matches!(c, 'r' | 'w' | 'x' | '-' | 's' | 'S' | 't' | 'T'));
        if is_long {
            let ftype = first.chars().next().unwrap();
            // name = last whitespace-separated token
            let Some(name) = l.split_whitespace().next_back() else {
                continue;
            };
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            let is_dir = ftype == 'd';
            // strip ls -F suffix chars (= socket, * exec, @ link) if present
            let mut name: &str = &name;
            if name.ends_with(['=', '*', '@']) {
                name = &name[..name.len() - 1];
            }
            if name.ends_with('/') {
                name = &name[..name.len() - 1];
            }
            if name.is_empty() {
                continue;
            }
            v.push(RshEntry {
                name: name.to_string(),
                is_dir,
            });
            continue;
        }
        // Bare ls -F line: name + optional classification suffix
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

#[tauri::command]
pub async fn rsh_ls(
    mgr: State<'_, std::sync::Arc<RshManager>>,
    args: RshConnectArgs,
    path: String,
) -> Result<Vec<RshEntry>, String> {
    let mgr = mgr.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_session(&mgr, &args, |s| {
            let cmd = format!("echo __DTS__; ls -F {path} 2>&1 | cat; echo __DTE__:$?");
            let out = s.exec_raw(&cmd);
            if out.contains("No such file") || out.contains("not found") {
                return Err(format!("路径不存在: {path}"));
            }
            Ok(parse_ls_f(&out))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
