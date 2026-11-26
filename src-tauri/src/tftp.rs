//! TFTP (RFC1350) server + client with RFC2348 blksize option negotiation.
//! octet mode only. UDP; each transfer gets its own socket+thread after the
//! first request (standard TFTP concurrency model).

use std::io::{Read, Write};
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

// ---------------- protocol constants ----------------

const OPCODE_RRQ: u16 = 1;
const OPCODE_WRQ: u16 = 2;
const OPCODE_DATA: u16 = 3;
const OPCODE_ACK: u16 = 4;
const OPCODE_ERROR: u16 = 5;
const OPCODE_OACK: u16 = 6;

const MAX_BLOCK_SIZE: usize = 65464; // RFC2348 max
const DEFAULT_BLOCK_SIZE: usize = 512;
const RETRIES: u32 = 5;
const TIMEOUT_MS: u64 = 1000;

// ---------------- packet codec (pure, testable) ----------------

/// Parsed initial request (RRQ/WRQ).
#[derive(Debug, PartialEq)]
pub struct Request {
    pub opcode: u16, // 1 or 2
    pub filename: String,
    pub mode: String,
    pub blksize: Option<usize>,
}

/// Parse an RRQ/WRQ packet: [opcode:2][name\0][mode\0][opt\0 val\0]...
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
    let mut opts: Vec<(String, String)> = Vec::new();
    loop {
        let opt = parts.next()?;
        if opt.is_empty() {
            break;
        }
        let val = parts.next()?;
        opts.push((
            String::from_utf8_lossy(opt).to_ascii_lowercase(),
            String::from_utf8_lossy(val).to_string(),
        ));
    }
    for (k, v) in opts {
        if k == "blksize" {
            if let Ok(n) = v.parse::<usize>() {
                blksize = Some(n.clamp(8, MAX_BLOCK_SIZE));
            }
        }
    }
    Some(Request {
        opcode,
        filename,
        mode: mode.to_ascii_lowercase(),
        blksize,
    })
}

/// DATA packet: [opcode:2][block#:2][payload]
pub fn make_data(block: u16, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + payload.len());
    v.extend_from_slice(&OPCODE_DATA.to_be_bytes());
    v.extend_from_slice(&block.to_be_bytes());
    v.extend_from_slice(payload);
    v
}

/// ACK packet: [opcode:2][block#:2]
pub fn make_ack(block: u16) -> Vec<u8> {
    let mut v = Vec::with_capacity(4);
    v.extend_from_slice(&OPCODE_ACK.to_be_bytes());
    v.extend_from_slice(&block.to_be_bytes());
    v
}

/// ERROR packet: [opcode:2][code:2][msg\0]
pub fn make_error(code: u16, msg: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&OPCODE_ERROR.to_be_bytes());
    v.extend_from_slice(&code.to_be_bytes());
    v.extend_from_slice(msg.as_bytes());
    v.push(0);
    v
}

/// OACK packet: [opcode:2][opt\0 val\0]...
pub fn make_oack(blksize: usize) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&OPCODE_OACK.to_be_bytes());
    v.extend_from_slice(b"blksize\0");
    v.extend_from_slice(blksize.to_string().as_bytes());
    v.push(0);
    v
}

/// Parse an ACK: returns block number.
pub fn parse_ack(buf: &[u8]) -> Option<u16> {
    if buf.len() < 4 || u16::from_be_bytes([buf[0], buf[1]]) != OPCODE_ACK {
        return None;
    }
    Some(u16::from_be_bytes([buf[2], buf[3]]))
}

/// Parse an OACK: returns options.
pub fn parse_oack(buf: &[u8]) -> Option<(usize)> {
    if buf.len() < 2 || u16::from_be_bytes([buf[0], buf[1]]) != OPCODE_OACK {
        return None;
    }
    let mut parts = buf[2..].split(|&b| b == 0);
    while let Some(opt) = parts.next() {
        if opt.is_empty() {
            break;
        }
        let val = parts.next()?;
        if String::from_utf8_lossy(opt).to_ascii_lowercase() == "blksize" {
            return String::from_utf8_lossy(val).parse().ok();
        }
    }
    None
}

/// Parse an ERROR packet: returns (code, msg).
pub fn parse_error(buf: &[u8]) -> Option<(u16, String)> {
    if buf.len() < 5 || u16::from_be_bytes([buf[0], buf[1]]) != OPCODE_ERROR {
        return None;
    }
    let code = u16::from_be_bytes([buf[2], buf[3]]);
    let msg = String::from_utf8_lossy(&buf[4..buf.len() - 1]).to_string();
    Some((code, msg))
}

// ---------------- events ----------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TftpEvent {
    Start {
        dir: String, // "get" = device pulls (RRQ), "put" = device pushes (WRQ)
        file: String,
        peer: String,
        total: Option<u64>,
    },
    Progress {
        dir: String,
        file: String,
        bytes: u64,
        total: Option<u64>,
    },
    Done {
        dir: String,
        file: String,
        bytes: u64,
        speed: u64, // bytes/sec
    },
    Error {
        dir: String,
        file: String,
        message: String,
    },
}

impl TftpEvent {
    fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap()
    }
}

// ---------------- server ----------------

#[derive(Default)]
pub struct TftpServer {
    running: AtomicBool,
    dir: std::sync::Mutex<String>,
}

#[derive(Debug, Deserialize)]
pub struct TftpServerStartArgs {
    pub dir: String,
    #[serde(default = "default_tftp_port")]
    pub port: u16,
}

fn default_tftp_port() -> u16 {
    69
}

/// Sanitize a requested filename: no path components, no traversal.
fn safe_filename(name: &str) -> Option<String> {
    let cleaned = name.replace('\\', "/");
    if cleaned.contains("..") || cleaned.starts_with('/') || cleaned.is_empty() {
        return None;
    }
    if cleaned
        .bytes()
        .any(|b| b == 0 || b.is_ascii_control() || b"\"<>|:*?".contains(&b))
    {
        return None;
    }
    Some(cleaned)
}

#[tauri::command]
pub fn tftp_server_start(
    state: State<'_, TftpServer>,
    args: TftpServerStartArgs,
    on_event: Channel<String>,
) -> Result<String, String> {
    if state.running.load(Ordering::Relaxed) {
        return Err("TFTP 服务端已在运行".into());
    }
    // Validate/create directory.
    let dir_path = std::path::PathBuf::from(&args.dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| format!("无法创建目录 {dir_path:?}: {e}"))?;

    // Bind the requested port; if taken, auto-fall back to random ports.
    let (socket, bound_port) = match UdpSocket::bind(("0.0.0.0", args.port)) {
        Ok(s) => (s, args.port),
        Err(first_err) => {
            let mut bound = None;
            let mut last_err = first_err.to_string();
            for _ in 0..8 {
                let nano = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .subsec_nanos();
                let p: u16 = 40000 + (nano % 20000) as u16;
                match UdpSocket::bind(("0.0.0.0", p)) {
                    Ok(s) => {
                        bound = Some((s, p));
                        break;
                    }
                    Err(e) => last_err = e.to_string(),
                }
            }
            match bound {
                Some(pair) => pair,
                None => match UdpSocket::bind(("0.0.0.0", 0)) {
                    Ok(s) => {
                        let p = s.local_addr().map_err(|e| e.to_string())?.port();
                        (s, p)
                    }
                    Err(e3) => {
                        return Err(format!(
                            "绑定 UDP 端口 {} 失败: {last_err};随机端口也失败: {e3}",
                            args.port
                        ))
                    }
                },
            }
        }
    };

    state.running.store(true, Ordering::Relaxed);
    *state.dir.lock().unwrap() = args.dir.clone();
    let running = Arc::new(AtomicBool::new(true));
    let server_running = running.clone();
    let dir = Arc::new(dir_path);

    std::thread::spawn(move || {
        let _ = on_event.send(r#"{"kind":"state","state":"running"}"#.into());
        let mut buf = [0u8; 2048]; // enough for RRQ/WRQ + options
        while server_running.load(Ordering::Relaxed) {
            socket.set_read_timeout(Some(Duration::from_millis(500))).ok();
            match socket.recv_from(&mut buf) {
                Ok((n, peer)) => {
                    if let Some(req) = parse_request(&buf[..n]) {
                        // Per-request transfer thread with its own socket bound
                        // to an ephemeral port (standard TFTP behavior).
                        let dir = dir.clone();
                        let ev = on_event.clone();
                        let server_running = server_running.clone();
                        std::thread::spawn(move || {
                            let xfer = UdpSocket::bind("0.0.0.0:0");
                            let xfer = match xfer {
                                Ok(s) => s,
                                Err(_) => return,
                            };
                            let _ = xfer.connect(peer);
                            run_transfer(xfer, req, (*dir).clone(), peer.to_string(), ev, server_running);
                        });
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
        }
        let _ = on_event.send(r#"{"kind":"state","state":"stopped"}"#.into());
    });

    if bound_port == args.port {
        Ok(format!("TFTP 服务端已启动: {} @ UDP {}", args.dir, args.port))
    } else {
        Ok(format!(
            "端口 {} 被占用,TFTP 服务端已改用随机端口 {}",
            args.port, bound_port
        ))
    }
}

#[tauri::command]
pub fn tftp_server_stop(state: State<'_, TftpServer>) -> String {
    state.running.store(false, Ordering::Relaxed);
    "TFTP 服务端已停止".into()
}

#[tauri::command]
pub fn tftp_server_status(state: State<'_, TftpServer>) -> bool {
    state.running.load(Ordering::Relaxed)
}

/// One RRQ or WRQ transfer on a dedicated connected socket.
fn run_transfer(
    xfer: UdpSocket,
    req: Request,
    dir: std::path::PathBuf,
    peer: String,
    ev: Channel<String>,
    running: Arc<AtomicBool>,
) {
    xfer.set_read_timeout(Some(Duration::from_millis(TIMEOUT_MS))).ok();
    let blksize = req.blksize.unwrap_or(DEFAULT_BLOCK_SIZE).min(MAX_BLOCK_SIZE);
    let mode = req.mode;
    if mode != "octet" && mode != "netascii" {
        let _ = xfer.send(&make_error(4, "only octet supported"));
        let _ = ev.send(TftpEvent::Error { dir: dir_label(req.opcode), file: req.filename.clone(), message: "unsupported mode".into() }.to_json());
        return;
    }

    match req.opcode {
        OPCODE_RRQ => {
            // Device pulls a file from `dir`.
            let Some(fname) = safe_filename(&req.filename) else {
                let _ = xfer.send(&make_error(2, "invalid filename"));
                let _ = ev.send(TftpEvent::Error { dir: "get".into(), file: req.filename, message: "invalid filename".into() }.to_json());
                return;
            };
            let path = dir.join(&fname);
            let data = match std::fs::read(&path) {
                Ok(d) => d,
                Err(e) => {
                    let _ = xfer.send(&make_error(1, "file not found"));
                    let _ = ev.send(TftpEvent::Error { dir: "get".into(), file: fname, message: format!("read: {e}") }.to_json());
                    return;
                }
            };
            let total = data.len() as u64;
            let _ = ev.send(TftpEvent::Start { dir: "get".into(), file: fname.clone(), peer: peer.clone(), total: Some(total) }.to_json());

            // Send with retransmit-until-ACK; final block (size < blksize) ends.
            let mut block: u16 = 0;
            let mut sent: u64 = 0;
            let start_time = Instant::now();
            let mut buf = [0u8; MAX_BLOCK_SIZE + 4];
            loop {
                block = block.wrapping_add(1);
                let off = ((block as usize - 1) * blksize).min(data.len());
                let end = (off + blksize).min(data.len());
                let chunk = &data[off..end];
                let pkt = make_data(block, chunk);
                let mut retries = RETRIES;
                loop {
                    if xfer.send(&pkt).is_err() {
                        let _ = ev.send(TftpEvent::Error { dir: "get".into(), file: fname.clone(), message: "send failed".into() }.to_json());
                        return;
                    }
                    match xfer.recv(&mut buf) {
                        Ok(n) => {
                            if parse_ack(&buf[..n]) == Some(block) {
                                break;
                            }
                            if parse_error(&buf[..n]).is_some() {
                                let _ = ev.send(TftpEvent::Error { dir: "get".into(), file: fname.clone(), message: "peer error".into() }.to_json());
                                return;
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock => {
                            retries -= 1;
                            if retries == 0 {
                                let _ = ev.send(TftpEvent::Error { dir: "get".into(), file: fname.clone(), message: "timeout".into() }.to_json());
                                return;
                            }
                        }
                        Err(_) => {
                            let _ = ev.send(TftpEvent::Error { dir: "get".into(), file: fname.clone(), message: "recv failed".into() }.to_json());
                            return;
                        }
                    }
                    if !running.load(Ordering::Relaxed) {
                        return;
                    }
                }
                sent += chunk.len() as u64;
                let _ = ev.send(TftpEvent::Progress { dir: "get".into(), file: fname.clone(), bytes: sent, total: Some(total) }.to_json());
                if chunk.len() < blksize {
                    break;
                }
                if sent as usize >= data.len() {
                    break;
                }
            }
            let secs = start_time.elapsed().as_secs_f64().max(0.001);
            let _ = ev.send(TftpEvent::Done { dir: "get".into(), file: fname, bytes: total, speed: (total as f64 / secs) as u64 }.to_json());
        }
        OPCODE_WRQ => {
            // Device pushes a file into `dir`.
            let Some(fname) = safe_filename(&req.filename) else {
                let _ = xfer.send(&make_error(2, "invalid filename"));
                let _ = ev.send(TftpEvent::Error { dir: "put".into(), file: req.filename, message: "invalid filename".into() }.to_json());
                return;
            };
            let path = dir.join(&fname);
            let mut file = match std::fs::File::create(&path) {
                Ok(f) => f,
                Err(e) => {
                    let _ = xfer.send(&make_error(2, "cannot create file"));
                    let _ = ev.send(TftpEvent::Error { dir: "put".into(), file: fname, message: format!("create: {e}") }.to_json());
                    return;
                }
            };
            let _ = ev.send(TftpEvent::Start { dir: "put".into(), file: fname.clone(), peer: peer.clone(), total: None }.to_json());

            // If options were requested, answer with OACK and start at block 0
            // (client then sends DATA block 1). Without options, ACK block 0.
            let mut expect: u16 = 1;
            if req.blksize.is_some() {
                if xfer.send(&make_oack(blksize)).is_err() {
                    return;
                }
            } else if xfer.send(&make_ack(0)).is_err() {
                return;
            }

            let start_time = Instant::now();
            let mut buf = vec![0u8; blksize + 4];
            let mut received: u64 = 0;
            loop {
                if !running.load(Ordering::Relaxed) {
                    return;
                }
                let n = match xfer.recv(&mut buf) {
                    Ok(n) => n,
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock => {
                        // re-ACK last (or re-OACK): resend the previous packet
                        if req.blksize.is_some() && expect == 1 && received == 0 {
                            let _ = xfer.send(&make_oack(blksize));
                        } else {
                            let _ = xfer.send(&make_ack(expect.wrapping_sub(1)));
                        }
                        continue;
                    }
                    Err(_) => return,
                };
                if n < 4 {
                    continue;
                }
                let opcode = u16::from_be_bytes([buf[0], buf[1]]);
                match opcode {
                    OPCODE_DATA => {
                        let block = u16::from_be_bytes([buf[2], buf[3]]);
                        if block != expect {
                            if block == expect.wrapping_sub(1) {
                                // duplicate DATA from our lost ACK: re-ACK
                                let _ = xfer.send(&make_ack(block));
                            }
                            continue;
                        }
                        if file.write_all(&buf[4..n]).is_err() {
                            let _ = xfer.send(&make_error(3, "disk full"));
                            let _ = ev.send(TftpEvent::Error { dir: "put".into(), file: fname.clone(), message: "disk write failed".into() }.to_json());
                            return;
                        }
                        let _ = xfer.send(&make_ack(block));
                        received += (n - 4) as u64;
                        expect = expect.wrapping_add(1);
                        let _ = ev.send(TftpEvent::Progress { dir: "put".into(), file: fname.clone(), bytes: received, total: None }.to_json());
                        if n - 4 < blksize {
                            // final block
                            drop(file);
                            let secs = start_time.elapsed().as_secs_f64().max(0.001);
                            let _ = ev.send(TftpEvent::Done { dir: "put".into(), file: fname, bytes: received, speed: (received as f64 / secs) as u64 }.to_json());
                            return;
                        }
                    }
                    OPCODE_ERROR => {
                        let _ = ev.send(TftpEvent::Error { dir: "put".into(), file: fname, message: "peer aborted".into() }.to_json());
                        return;
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn dir_label(opcode: u16) -> String {
    if opcode == OPCODE_RRQ { "get".into() } else { "put".into() }
}

// ---------------- client ----------------

#[derive(Debug, Deserialize)]
pub struct TftpGetArgs {
    pub server: String,
    pub remote: String,
    pub local: String,
    #[serde(default = "default_tftp_port")]
    pub port: u16,
}

#[derive(Debug, Deserialize)]
pub struct TftpPutArgs {
    pub server: String,
    pub local: String,
    pub remote: String,
    #[serde(default = "default_tftp_port")]
    pub port: u16,
}

/// GET: read remote file into local path. Runs on a blocking thread.
#[tauri::command]
pub async fn tftp_get(
    args: TftpGetArgs,
    on_progress: Channel<String>,
) -> Result<(), String> {
    let ev = on_progress.clone();
    let res = tauri::async_runtime::spawn_blocking(move || client_transfer(&args.server, args.port, &args.remote, &args.local, true, &ev))
        .await
        .map_err(|e| format!("join: {e}"))?;
    res
}

/// PUT: send local file to remote server. Runs on a blocking thread.
#[tauri::command]
pub async fn tftp_put(
    args: TftpPutArgs,
    on_progress: Channel<String>,
) -> Result<(), String> {
    let ev = on_progress.clone();
    let res = tauri::async_runtime::spawn_blocking(move || client_transfer(&args.server, args.port, &args.remote, &args.local, false, &ev))
        .await
        .map_err(|e| format!("join: {e}"))?;
    res
}

fn client_transfer(
    server: &str,
    port: u16,
    remote: &str,
    local: &str,
    is_get: bool,
    ev: &Channel<String>,
) -> Result<(), String> {
    let remote = remote.trim_start_matches('/').to_string();
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket
        .connect((server, port))
        .map_err(|e| format!("连接 {server}:{port} 失败: {e}"))?;
    socket
        .set_read_timeout(Some(Duration::from_millis(TIMEOUT_MS)))
        .ok();

    let mode = "octet";
    let mut req = Vec::new();
    req.extend_from_slice(&(if is_get { OPCODE_RRQ } else { OPCODE_WRQ }).to_be_bytes());
    req.extend_from_slice(remote.as_bytes());
    req.push(0);
    req.extend_from_slice(mode.as_bytes());
    req.push(0);
    // negotiate a bigger block for speed
    req.extend_from_slice(b"blksize\01468\0");

    socket.send(&req).map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; MAX_BLOCK_SIZE + 4];
    if is_get {
        // first reply: OACK (block 0) or DATA block 1
        let mut expect: u16 = 1;
        let mut file: Option<std::fs::File> = None;
        let mut bytes: u64 = 0;
        let start = Instant::now();
        let mut retries = RETRIES;
        loop {
            let n = match socket.recv(&mut buf) {
                Ok(n) => n,
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock => {
                    retries -= 1;
                    if retries == 0 {
                        return Err("服务器无响应".into());
                    }
                    let _ = socket.send(&req);
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            if n < 4 { continue; }
            let opcode = u16::from_be_bytes([buf[0], buf[1]]);
            match opcode {
                OPCODE_OACK => {
                    if expect == 1 && file.is_none() {
                        let _ = socket.send(&make_ack(0));
                    }
                }
                OPCODE_DATA => {
                    let block = u16::from_be_bytes([buf[2], buf[3]]);
                    if block != expect {
                        continue;
                    }
                    if file.is_none() {
                        let f = std::fs::File::create(local).map_err(|e| format!("创建 {local} 失败: {e}"))?;
                        file = Some(f);
                        let _ = ev.send(format!("{{\"kind\":\"start\",\"dir\":\"get\",\"file\":\"{remote}\"}}"));
                    }
                    {
                        let mut f = file.as_ref().unwrap();
                        f.write_all(&buf[4..n]).map_err(|e| e.to_string())?;
                    }
                    bytes += (n - 4) as u64;
                    let _ = socket.send(&make_ack(block));
                    expect = expect.wrapping_add(1);
                    let _ = ev.send(format!("{{\"kind\":\"progress\",\"dir\":\"get\",\"file\":\"{remote}\",\"bytes\":{bytes}}}"));
                    if n - 4 < 1468 {
                        let secs = start.elapsed().as_secs_f64().max(0.001);
                        let _ = ev.send(format!("{{\"kind\":\"done\",\"dir\":\"get\",\"file\":\"{remote}\",\"bytes\":{bytes},\"speed\":{}}}", (bytes as f64 / secs) as u64));
                        return Ok(());
                    }
                }
                OPCODE_ERROR => {
                    let (code, msg) = parse_error(&buf[..n]).unwrap_or((0, "error".into()));
                    return Err(format!("服务器错误 {code}: {msg}"));
                }
                _ => {}
            }
        }
    } else {
        // PUT: local -> server. Read file, send DATA blocks with retransmit.
        let data = std::fs::read(local).map_err(|e| format!("读取 {local} 失败: {e}"))?;
        let total = data.len() as u64;
        let _ = ev.send(format!("{{\"kind\":\"start\",\"dir\":\"put\",\"file\":\"{remote}\",\"total\":{total}}}"));
        let mut expect_ack: u16 = 0; // block 0 = request itself
        let mut off: usize = 0;
        let mut block: u16 = 0;
        let start = Instant::now();
        let mut retries;
        loop {
            if expect_ack == block {
                block = block.wrapping_add(1);
                off = (block as usize - 1) * 1468;
                let end = (off + 1468).min(data.len());
                if off > data.len() {
                    // sent everything incl. final zero-length? final already sent
                    let secs = start.elapsed().as_secs_f64().max(0.001);
                    let _ = ev.send(format!("{{\"kind\":\"done\",\"dir\":\"put\",\"file\":\"{remote}\",\"bytes\":{total},\"speed\":{}}}", (total as f64 / secs) as u64));
                    return Ok(());
                }
                let pkt = make_data(block, &data[off..end]);
                socket.send(&pkt).map_err(|e| e.to_string())?;
                if end >= data.len() && end - off < 1468 {
                    // final block flag: after its ACK we're done
                    let n = wait_ack(&socket, &mut buf, block)?;
                    if n {
                        let secs = start.elapsed().as_secs_f64().max(0.001);
                        let _ = ev.send(format!("{{\"kind\":\"done\",\"dir\":\"put\",\"file\":\"{remote}\",\"bytes\":{total},\"speed\":{}}}", (total as f64 / secs) as u64));
                        return Ok(());
                    }
                    continue;
                }
            } else {
                retries = RETRIES;
                loop {
                    let n = socket.recv(&mut buf).map_err(|e| e.to_string())?;
                    if let Some(b) = parse_ack(&buf[..n]) {
                        if b == expect_ack {
                            break;
                        }
                    } else if let Some((_, msg)) = parse_error(&buf[..n]) {
                        return Err(format!("服务器错误: {msg}"));
                    }
                    retries -= 1;
                    if retries == 0 {
                        return Err("ACK 超时".into());
                    }
                }
                continue;
            }
            // wait for ack of the block we just sent
            let n = wait_ack(&socket, &mut buf, block);
            match n {
                Ok(true) => {
                    expect_ack = block;
                }
                Ok(false) => {}
                Err(e) => return Err(e),
            }
        }
    }
}

fn wait_ack(socket: &UdpSocket, buf: &mut [u8], block: u16) -> Result<bool, String> {
    let mut retries = RETRIES;
    loop {
        match socket.recv(buf) {
            Ok(n) => {
                if n >= 4 {
                    let opcode = u16::from_be_bytes([buf[0], buf[1]]);
                    if opcode == OPCODE_ACK && u16::from_be_bytes([buf[2], buf[3]]) == block {
                        return Ok(true);
                    }
                    if opcode == OPCODE_ERROR {
                        let (_, msg) = parse_error(&buf[..n]).unwrap_or((0, "error".into()));
                        return Err(format!("服务器错误: {msg}"));
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock => {
                retries -= 1;
                if retries == 0 {
                    return Err("ACK 超时".into());
                }
                return Ok(false); // caller re-sends
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

// ---------------- server directory helpers ----------------

#[derive(Debug, Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub size: u64,
    pub modified: String,
}

#[tauri::command]
pub fn tftp_list_dir(dir: String) -> Result<Vec<DirEntryInfo>, String> {
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in rd {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| {
                let secs = t
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()?
                    .as_secs();
                // format as local-ish YYYY-MM-DD HH:MM (approximate, no tz db)
                let dt = time_format(secs);
                Some(dt)
            })
            .unwrap_or_default();
        out.push(DirEntryInfo {
            name,
            size: meta.len(),
            modified,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Minimal UTC timestamp formatting without external crates.
fn time_format(secs: u64) -> String {
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days algorithm (Howard Hinnant)
    let z = days as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

/// Copy an external file into the server dir (command assistant upload).
#[tauri::command]
pub fn tftp_copy_in(dir: String, src: String, name: String) -> Result<(), String> {
    let Some(safe) = safe_filename(&name) else {
        return Err("非法文件名".into());
    };
    let dst = std::path::Path::new(&dir).join(safe);
    // If src already lives in the server dir (typical: the user picks a file
    // from the very folder they configured), copying onto itself fails with
    // os error 32 on Windows. Skip when both paths resolve to the same file.
    if let (Ok(src_meta), Ok(dst_meta)) = (std::fs::metadata(&src), std::fs::metadata(&dst)) {
        if src_meta.len() == dst_meta.len() {
            #[cfg(windows)]
            let same = std::fs::canonicalize(&src)
                .ok()
                .zip(std::fs::canonicalize(&dst).ok())
                .map(|(a, b)| {
                    // canonicalize returns \\?\UNC/\\?\C:\ style; compare case-insensitively
                    let a = a.to_string_lossy().to_lowercase();
                    let b = b.to_string_lossy().to_lowercase();
                    a == b
                })
                .unwrap_or(false);
            #[cfg(not(windows))]
            let same = std::fs::canonicalize(&src)
                .ok()
                .zip(std::fs::canonicalize(&dst).ok())
                .map(|(a, b)| a == b)
                .unwrap_or(false);
            if same {
                return Ok(());
            }
        }
    }
    std::fs::copy(&src, &dst).map_err(|e| format!("复制失败: {e}"))?;
    Ok(())
}

/// Copy a file out of the server dir to an arbitrary user-chosen path
/// (download finalization: router pushed file -> srv dir -> save as).
#[tauri::command]
pub fn tftp_export(srv_dir: String, name: String, save_path: String) -> Result<(), String> {
    let Some(safe) = safe_filename(&name) else {
        return Err("非法文件名".into());
    };
    let src = std::path::Path::new(&srv_dir).join(safe);
    let dst = std::path::Path::new(&save_path);

    // Same-file case: user saved into the server dir itself with the same
    // name - the file is already there, nothing to copy (Windows errors 32).
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(&src), std::fs::canonicalize(dst)) {
        #[cfg(windows)]
        let same = a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase();
        #[cfg(not(windows))]
        let same = a == b;
        if same {
            return Ok(());
        }
    }

    // The WRQ transfer thread may release its handle just after the tftp
    // command returns; retry briefly on sharing violations (os error 32/33).
    let mut last_err = None;
    for _ in 0..5 {
        match std::fs::copy(&src, dst) {
            Ok(_) => return Ok(()),
            Err(e) => {
                let raw = e.raw_os_error().unwrap_or(0);
                if raw == 32 || raw == 33 {
                    last_err = Some(e);
                    std::thread::sleep(Duration::from_millis(300));
                } else {
                    return Err(format!("导出失败: {e}"));
                }
            }
        }
    }
    Err(format!(
        "导出失败: {} (文件可能仍被传输线程占用,稍后重试)",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}
