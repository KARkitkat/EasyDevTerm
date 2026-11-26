use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::session::{spawn_session_task, SessionKind, SessionManager, SessionTx};

#[derive(Debug, Deserialize)]
pub struct SerialOpenArgs {
    pub port: String,
    #[serde(default = "default_baud")]
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default)]
    pub stop_bits: u8, // 1 or 2
    #[serde(default)]
    pub parity: String, // "none" | "even" | "odd"
    pub label: Option<String>,
}

fn default_baud() -> u32 {
    115200
}
fn default_data_bits() -> u8 {
    8
}

#[derive(Debug, Serialize)]
pub struct PortInfo {
    pub name: String,
    pub kind: String, // "usb" | "pci" | "unknown"
    pub desc: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

#[tauri::command]
pub fn serial_list() -> Vec<PortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| match p.port_type {
            serialport::SerialPortType::UsbPort(info) => PortInfo {
                name: p.port_name,
                kind: "usb".into(),
                desc: info.product.clone().or(info.serial_number.clone()),
                vid: Some(info.vid),
                pid: Some(info.pid),
            },
            serialport::SerialPortType::PciPort => PortInfo {
                name: p.port_name,
                kind: "pci".into(),
                desc: None,
                vid: None,
                pid: None,
            },
            serialport::SerialPortType::BluetoothPort => PortInfo {
                name: p.port_name,
                kind: "bluetooth".into(),
                desc: None,
                vid: None,
                pid: None,
            },
            _ => PortInfo {
                name: p.port_name,
                kind: "unknown".into(),
                desc: None,
                vid: None,
                pid: None,
            },
        })
        .collect()
}

fn data_bits_from(n: u8) -> serialport::DataBits {
    match n {
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    }
}

fn stop_bits_from(n: u8) -> serialport::StopBits {
    match n {
        2 => serialport::StopBits::Two,
        _ => serialport::StopBits::One,
    }
}

fn parity_from(s: &str) -> serialport::Parity {
    match s {
        "even" => serialport::Parity::Even,
        "odd" => serialport::Parity::Odd,
        _ => serialport::Parity::None,
    }
}

/// Live session plumbing for write + close, looked up by session id.
/// The writer thread owns the port exclusively; commands enqueue bytes and
/// never block on the reader.
pub struct PortEntry {
    pub write_tx: mpsc::SyncSender<Vec<u8>>,
    pub close: Option<tokio::sync::oneshot::Sender<()>>,
    pub tx: SessionTx,
}

pub static PORT_REGISTRY: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<u32, std::sync::Arc<std::sync::Mutex<PortEntry>>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[tauri::command]
pub fn serial_open(
    mgr: State<'_, SessionManager>,
    args: SerialOpenArgs,
    on_event: Channel<String>,
) -> Result<u32, String> {
    let port_name = args.port.clone();
    let label = args
        .label
        .clone()
        .unwrap_or_else(|| format!("{} @ {}", args.port, args.baud_rate));

    // Open and configure on this thread first: surface open errors to the caller.
    let mut port = serialport::new(&port_name, args.baud_rate)
        .data_bits(data_bits_from(args.data_bits))
        .stop_bits(stop_bits_from(args.stop_bits))
        .parity(parity_from(&args.parity))
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| format!("打开 {} 失败: {}", port_name, e))?;
    let _ = port.write_data_terminal_ready(true);
    let _ = port.write_request_to_send(true);

    // Writer thread: owns the port for writes; reads happen from a second
    // handle-free path - we must serialize with reads though. serialport gives
    // one object; so the reader loop and writer thread share it via this mpsc:
    // the reader loop drains write requests between reads. This keeps latency
    // low (write happens right after the current read returns) without a
    // second lock held across blocking syscalls.
    let (write_tx, write_rx) = mpsc::sync_channel::<Vec<u8>>(64);

    // The port is owned solely by the IO loop below (no Arc needed); the
    // writer command path goes through the mpsc queue instead.
    let id = spawn_session_task(
        mgr.inner(),
        SessionKind::Serial,
        label,
        on_event,
        move |id, tx, close_rx| {
            let _ = tx.send(r#"{"event":"state","state":"open"}"#.into());

            let (close_ack_tx, close_ack_rx) = std::sync::mpsc::channel::<()>();
            PORT_REGISTRY.lock().unwrap().insert(
                id,
                std::sync::Arc::new(std::sync::Mutex::new(PortEntry {
                    write_tx,
                    // Real close goes through SessionManager (drops its sender,
                    // terminating close_rx in the loop below); store None so
                    // serial_close's take() simply finds nothing extra to do.
                    close: None,
                    tx: tx.clone(),
                })),
            );
            let _ = close_ack_tx;
            let _ = close_ack_rx;

            // Single IO loop: poll read with short timeout, service writes
            // between reads, check close. One thread, one owner, no lock
            // contention: keystrokes go out within one read timeout (<=50ms),
            // usually instantly because read returns immediately when the
            // device has data.
            let mut buf = [0u8; 4096];
            let mut pending: VecDeque<Vec<u8>> = VecDeque::new();
            let reason;
            loop {
                // 1. Close?
                if close_rx.is_terminated() {
                    reason = "closed by user".to_string();
                    break;
                }
                // 2. Service queued writes (non-blocking).
                loop {
                    match write_rx.try_recv() {
                        Ok(data) => pending.push_back(data),
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => {}
                    }
                }
                let mut write_failed = None;
                while let Some(data) = pending.pop_front() {
                    if let Err(e) = port.write_all(&data).and_then(|_| port.flush()) {
                        write_failed = Some(format!("write error: {}", e));
                        break;
                    }
                }
                if let Some(r) = write_failed {
                    reason = r;
                    break;
                }
                // 3. Read (short timeout keeps the loop responsive).
                let n = match port.read(&mut buf) {
                    Ok(n) => n,
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => 0,
                    Err(e) => {
                        reason = format!("read error: {}", e);
                        break;
                    }
                };
                if n > 0 {
                    let msg = format!(
                        "{{\"event\":\"data\",\"bytes\":\"{}\"}}",
                        base64_encode(&buf[..n])
                    );
                    if tx.send(msg).is_err() {
                        reason = "frontend channel gone".to_string();
                        break;
                    }
                }
            }

            PORT_REGISTRY.lock().unwrap().remove(&id);
            let _ = tx.send(format!(
                "{{\"event\":\"state\",\"state\":\"closed\",\"reason\":\"{}\"}}",
                reason
            ));
        },
    );

    Ok(id)
}

/// base64 helpers shared by all transports.
pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Writer command: frontend sends base64 bytes; we enqueue to the session's
/// IO loop and return immediately (microseconds, no lock/port wait).
#[tauri::command]
pub fn serial_write(
    mgr: State<'_, SessionManager>,
    id: u32,
    data_base64: String,
) -> Result<(), String> {
    let _ = mgr;
    let data = base64_decode(&data_base64).ok_or("bad base64")?;
    let entry = PORT_REGISTRY
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("session not found")?;
    let entry = entry.lock().unwrap();
    entry
        .write_tx
        .try_send(data)
        .map_err(|e| format!("队列写入失败: {}", e))
}

#[tauri::command]
pub fn serial_close(id: u32) -> bool {
    let entry = PORT_REGISTRY.lock().unwrap().remove(&id);
    if let Some(e) = entry {
        if let Some(sender) = e.lock().unwrap().close.take() {
            let _ = sender.send(());
        }
        true
    } else {
        false
    }
}
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None, // '=' handled by the loop below
        }
    }
    let s: Vec<u8> = s.bytes().filter(|b| !b" \r\n\t".contains(b)).collect();
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    for chunk in s.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        let mut n = 0u32;
        let mut bits = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            if c == b'=' {
                break; // padding: rest of chunk contributes nothing
            }
            let v = val(c)?;
            n |= v << (18 - 6 * i);
            bits += 6;
        }
        let take = (bits / 8) as usize; // whole bytes decoded
        out.push((n >> 16) as u8);
        if take > 1 {
            out.push((n >> 8) as u8);
        }
        if take > 2 {
            out.push(n as u8);
        }
    }
    Some(out)
}
