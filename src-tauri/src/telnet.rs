//! Telnet session: plain TCP to host:port plus minimal IAC negotiation.
//! Routers/embedded consoles rarely need full RFC854 negotiation: we answer
//! every DO/WILL with WONT/DONT (refuse all options) and strip IAC sequences
//! from the data stream, passing everything else through verbatim.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::session::{spawn_session_task, SessionKind, SessionManager, SessionTx};

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

/// TCP connect timeout. The OS default on Windows is ~21s (SYN retries) -
/// an explicit bound keeps a dead IP from hanging the connect for that long.
pub const CONNECT_TIMEOUT_MS: u64 = 5000;

/// Connect with an explicit timeout, trying each resolved address in turn.
pub fn connect_timeout(addr: &str, timeout: Duration) -> Result<TcpStream, String> {
    let addrs: Vec<_> = addr
        .to_socket_addrs()
        .map_err(|e| format!("解析 {addr} 失败: {e}"))?
        .collect();
    let mut last = None;
    for a in addrs {
        match TcpStream::connect_timeout(&a, timeout) {
            Ok(s) => return Ok(s),
            Err(e) => last = Some(e),
        }
    }
    Err(format!(
        "连接 {addr} 失败: {} (超时 {timeout:?})",
        last.map(|e| e.to_string())
            .unwrap_or_else(|| "无可用地址".into())
    ))
}

#[derive(Debug, Deserialize)]
pub struct TelnetOpenArgs {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub label: Option<String>,
}

fn default_port() -> u16 {
    23
}

/// Strip IAC sequences from `input`, appending clean bytes to `out` and
/// pushing required replies (e.g. our WONT/DONT answers) to `replies`.
pub fn iac_filter(input: &[u8], out: &mut Vec<u8>, replies: &mut Vec<u8>) {
    let mut i = 0;
    while i < input.len() {
        let b = input[i];
        if b != IAC {
            out.push(b);
            i += 1;
            continue;
        }
        // IAC sequence
        if i + 1 >= input.len() {
            break; // incomplete; drop (tcp segments shouldn't split often, and
                   // losing one negotiation byte on a split is tolerable here)
        }
        match input[i + 1] {
            IAC => {
                out.push(IAC); // escaped 0xff data byte
                i += 2;
            }
            DO | DONT => {
                if i + 2 >= input.len() {
                    break;
                }
                // refuse every option
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
                // skip subnegotiation until IAC SE
                let mut j = i + 2;
                while j + 1 < input.len() && !(input[j] == IAC && input[j + 1] == SE) {
                    j += 1;
                }
                i = if j + 1 < input.len() { j + 2 } else { input.len() };
            }
            _ => {
                // other commands (NOP, AYT, ...) - ignore the 2-byte sequence
                i += 2;
            }
        }
    }
}

pub static TELNET_REGISTRY: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<u32, mpsc::SyncSender<Vec<u8>>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
use std::sync::mpsc;

#[tauri::command]
pub async fn telnet_open(
    mgr: State<'_, SessionManager>,
    args: TelnetOpenArgs,
    on_event: Channel<String>,
) -> Result<u32, String> {
    let addr = format!("{}:{}", args.host, args.port);
    let label = args
        .label
        .clone()
        .unwrap_or_else(|| format!("telnet {}", args.host));

    // Connect off the main thread: sync commands run on the main thread, so a
    // blocking connect there would freeze the whole UI for the timeout.
    let stream = tauri::async_runtime::spawn_blocking(move || {
        connect_timeout(&addr, Duration::from_millis(CONNECT_TIMEOUT_MS))
    })
    .await
    .map_err(|e| format!("连接任务失败: {e}"))??;
    stream
        .set_nodelay(true)
        .ok();
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .ok();

    let id = spawn_session_task(
        mgr.inner(),
        SessionKind::Telnet,
        label,
        on_event,
        move |id, tx, close_rx| {
            let _ = tx.send(r#"{"event":"state","state":"open"}"#.into());

            let (write_tx, write_rx) = mpsc::sync_channel::<Vec<u8>>(64);
            TELNET_REGISTRY.lock().unwrap().insert(id, write_tx);

            let mut stream = stream;
            let mut buf = [0u8; 4096];
            let mut clean = Vec::with_capacity(4096);
            let mut replies = Vec::with_capacity(64);
            let reason;
            loop {
                if close_rx.is_terminated() {
                    reason = "closed by user".to_string();
                    break;
                }
                // service queued writes
                let mut failed = None;
                loop {
                    match write_rx.try_recv() {
                        Ok(data) => {
                            if let Err(e) = stream.write_all(&data).and_then(|_| stream.flush()) {
                                failed = Some(format!("write error: {e}"));
                                break;
                            }
                        }
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => {}
                    }
                }
                if let Some(r) = failed {
                    reason = r;
                    break;
                }
                // read + IAC filter
                clean.clear();
                replies.clear();
                let n = match stream.read(&mut buf) {
                    Ok(n) => n,
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => 0,
                    Err(e) => {
                        reason = format!("read error: {e}");
                        break;
                    }
                };
                if n > 0 {
                    iac_filter(&buf[..n], &mut clean, &mut replies);
                    if !replies.is_empty() && stream.write_all(&replies).is_err() {
                        reason = "write error (negotiation)".to_string();
                        break;
                    }
                }
                if !clean.is_empty() {
                    let msg = format!(
                        "{{\"event\":\"data\",\"bytes\":\"{}\"}}",
                        crate::serial::base64_encode(&clean)
                    );
                    if tx.send(msg).is_err() {
                        reason = "frontend channel gone".to_string();
                        break;
                    }
                }
            }

            TELNET_REGISTRY.lock().unwrap().remove(&id);
            let _ = tx.send(format!(
                "{{\"event\":\"state\",\"state\":\"closed\",\"reason\":\"{}\"}}",
                reason
            ));
        },
    );

    Ok(id)
}

#[tauri::command]
pub fn telnet_write(id: u32, data_base64: String) -> Result<(), String> {
    let data = crate::serial::base64_decode(&data_base64).ok_or("bad base64")?;
    let tx = TELNET_REGISTRY
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("session not found")?;
    tx.try_send(data).map_err(|e| format!("队列写入失败: {e}"))
}

#[tauri::command]
pub fn telnet_close(id: u32) -> bool {
    // Dropping the sender closes nothing by itself; the loop notices via
    // SessionManager close (close_rx terminated) and tears down.
    TELNET_REGISTRY.lock().unwrap().remove(&id).is_some()
}
