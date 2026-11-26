//! LAN discovery: scan the local /24 for hosts with an open TCP port
//! (default 23 for telnet). Bounded-concurrency connect sweep. Findings are
//! streamed to the frontend as they're discovered (event: "found"), progress
//! as (event: "progress"), completion as (event: "done").

use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::session::SessionManager;

#[derive(Debug, Serialize, Clone)]
pub struct DiscoveredHost {
    pub ip: String,
    pub port: u16,
}

fn local_ipv4() -> Result<Ipv4Addr, String> {
    // UDP connect trick: find the primary outbound local address without
    // sending any packet.
    let s = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    s.connect("8.8.8.8:80").map_err(|e| e.to_string())?;
    match s.local_addr().map_err(|e| e.to_string())?.ip() {
        IpAddr::V4(v4) => Ok(v4),
        IpAddr::V6(_) => Err("IPv6 环境暂不支持自动扫描".into()),
    }
}

/// All local IPv4 addresses (one per interface), for multi-NIC machines.
#[tauri::command]
pub fn list_local_ips() -> Vec<String> {
    #[cfg(windows)]
    {
        windows_local_ips()
    }
    #[cfg(not(windows))]
    {
        hostname_local_ips()
    }
}

#[cfg(windows)]
fn windows_local_ips() -> Vec<String> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST,
    };
    use windows_sys::Win32::NetworkManagement::IpHelper::IP_ADAPTER_ADDRESSES_LH;
    unsafe {
        let mut size: u32 = 16 * 1024;
        let mut buf;
        loop {
            buf = vec![0u8; size as usize];
            let rc = GetAdaptersAddresses(
                2, // AF_INET: IPv4 only - simplest; one call per family
                GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut size,
            );
            if rc == 0 {
                break;
            }
            if rc != 111 && size > 1024 * 1024 {
                return vec![];
            }
        }
        let mut out = Vec::new();
        let mut adapter = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !adapter.is_null() {
            let a = &*adapter;
            // skip down interfaces
            if a.OperStatus == 1 {
                let mut ua = a.FirstUnicastAddress;
                while !ua.is_null() {
                    let sa = (*ua).Address.lpSockaddr;
                    if !sa.is_null() && (*sa).sa_family == 2 {
                        // sockaddr_in: family(2) + port(2) + addr(4);
                        // sa_data is i8, cast to u8 to avoid -64.-88.-103.1
                        let data = (*sa).sa_data;
                        let b = [data[2] as u8, data[3] as u8, data[4] as u8, data[5] as u8];
                        out.push(format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3]));
                    }
                    ua = (*ua).Next;
                }
            }
            adapter = a.Next;
        }
        out.sort();
        out.dedup();
        out
    }
}

#[cfg(not(windows))]
fn hostname_local_ips() -> Vec<String> {
    use std::net::ToSocketAddrs;
    let mut out = Vec::new();
    if let Ok(h) = std::env::var("HOSTNAME") {
        if let Ok(addrs) = (h.as_str(), 0u16).to_socket_addrs() {
            for a in addrs {
                if let IpAddr::V4(v4) = a.ip() {
                    out.push(v4.to_string());
                }
            }
        }
    }
    if let Ok(primary) = local_ipv4() {
        let p = primary.to_string();
        out.retain(|x| *x != p);
        out.insert(0, p);
    }
    out.sort();
    out.dedup();
    out
}

fn scan_port(ip: Ipv4Addr, port: u16, timeout: Duration) -> bool {
    TcpStream::connect_timeout(&SocketAddr::new(IpAddr::V4(ip), port), timeout).is_ok()
}

// Note on interface selection: the sweep targets the /24 of the chosen local
// IP; the OS routes these connects out of the owning interface automatically
// (RFC1918 destinations on a directly attached subnet never hit the default
// route), so no explicit source binding is needed.

#[tauri::command]
pub async fn scan_subnet(
    mgr: State<'_, SessionManager>,
    local_ip: Option<String>,
    port: u16,
    on_progress: Channel<String>,
) -> Result<(), String> {
    let _ = mgr;
    // Which interface's /24 to sweep: explicit selection, else the primary.
    let local: Ipv4Addr = match local_ip {
        Some(s) => s.parse().map_err(|_| format!("无效的本机 IP: {s}"))?,
        None => local_ipv4()?,
    };
    let o = local.octets();

    let timeout = Duration::from_millis(400);
    let next_ip = AtomicU32::new(1);
    let scanned = AtomicU32::new(0);
    let total: u32 = 254;

    // Gateways (.1) are by far the most likely telnet hosts: probe the four
    // most common addresses first (.1, .254, .2, .100) so they show up within
    // the first wave, then sweep the rest in order.
    let mut order: Vec<u32> = Vec::with_capacity(254);
    for n in [1u32, 254, 2, 100] {
        if n <= 254 && n != local.octets()[3] as u32 {
            order.push(n);
        }
    }
    for n in 1..=254u32 {
        if n != local.octets()[3] as u32 && !order.contains(&n) {
            order.push(n);
        }
    }

    let order = StdMutex::new(order);
    std::thread::scope(|scope| {
        for _ in 0..64 {
            scope.spawn(|| loop {
                let n = {
                    let mut ord = order.lock().unwrap();
                    if ord.is_empty() { break; }
                    ord.remove(0)
                };
                let target = Ipv4Addr::new(o[0], o[1], o[2], n as u8);
                if scan_port(target, port, timeout) {
                    // stream the hit immediately
                    let h = DiscoveredHost { ip: target.to_string(), port };
                    let _ = on_progress.send(format!(
                        "{{\"event\":\"found\",\"ip\":\"{}\",\"port\":{}}}",
                        h.ip, h.port
                    ));
                }
                let done = scanned.fetch_add(1, Ordering::Relaxed) + 1;
                if done % 16 == 0 || done == total {
                    let _ = on_progress.send(format!(
                        "{{\"event\":\"progress\",\"scanned\":{},\"total\":{}}}",
                        done, total
                    ));
                }
            });
        }
    });

    let _ = on_progress.send(format!("{{\"event\":\"done\",\"count\":{}}}", scanned.load(Ordering::Relaxed)));
    Ok(())
}

/// Probe the .1 gateway of EVERY local interface's subnet (multi-NIC machines
/// often have several router subnets attached) on the given port.
#[tauri::command]
pub async fn scan_gateways(
    mgr: State<'_, SessionManager>,
    port: u16,
    on_progress: Channel<String>,
) -> Result<Vec<DiscoveredHost>, String> {
    let _ = mgr;
    let ips = list_local_ips();
    let mut gateways = Vec::new();
    for s in &ips {
        if let Ok(ip) = s.parse::<Ipv4Addr>() {
            let o = ip.octets();
            gateways.push(Ipv4Addr::new(o[0], o[1], o[2], 1));
        }
    }
    gateways.dedup();

    let total = gateways.len() as u32;
    let found = StdMutex::new(Vec::<DiscoveredHost>::new());
    let scanned = AtomicU32::new(0);

    std::thread::scope(|scope| {
        for gw in gateways {
            let found = &found;
            let scanned = &scanned;
            let on_progress = &on_progress;
            scope.spawn(move || {
                if scan_port(gw, port, Duration::from_millis(800)) {
                    found.lock().unwrap().push(DiscoveredHost {
                        ip: gw.to_string(),
                        port,
                    });
                    let _ = on_progress.send(format!(
                        "{{\"event\":\"found\",\"ip\":\"{}\",\"port\":{}}}",
                        gw, port
                    ));
                }
                let done = scanned.fetch_add(1, Ordering::Relaxed) + 1;
                if done == total {
                    let _ = on_progress.send(format!("{{\"event\":\"done\",\"count\":{}}}", done));
                }
            });
        }
    });

    let mut found = found.into_inner().unwrap();
    found.sort_by_key(|h| h.ip.clone());
    Ok(found)
}

/// Source IP this machine would use to reach `dst` (no packet sent; UDP
/// connect trick). Used to build `tftp -g ... <pc-ip>` commands.
#[tauri::command]
pub fn local_ip_toward(dst: String) -> Result<String, String> {
    let dst_ip: Ipv4Addr = dst
        .parse()
        .map_err(|_| format!("无效的目标 IP: {dst}"))?;
    let s = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    s.connect((dst_ip, 9))
        .map_err(|e| format!("无法路由到 {dst}: {e}"))?;
    match s.local_addr().map_err(|e| e.to_string())?.ip() {
        IpAddr::V4(v4) => Ok(v4.to_string()),
        IpAddr::V6(_) => Err("非 IPv4 路由".into()),
    }
}

/// Native multi-select file picker (Windows common dialog). Returns full
/// paths; empty vec when the user cancels.
#[tauri::command]
pub fn pick_files() -> Vec<String> {
    pick_files_impl()
}

#[cfg(windows)]
fn pick_files_impl() -> Vec<String> {
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, OPENFILENAMEW, OFN_ALLOWMULTISELECT, OFN_EXPLORER, OFN_FILEMUSTEXIST,
        OFN_NOCHANGEDIR,
    };
    unsafe {
        // Wide (UTF-16) variant: OPENFILENAMEW fields are PWSTR/PCWSTR.
        let mut buf = vec![0u16; 32 * 1024]; // 64KB
        let mut ofn: OPENFILENAMEW = std::mem::zeroed();
        ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        ofn.hwndOwner = std::ptr::null_mut();
        // ASCII bytes are identical to UTF-16 for codepoints < 0x80, so the
        // literals below can be widened at compile time.
        let filter: Vec<u16> = "All files\0*.*\0\0".encode_utf16().collect();
        let title: Vec<u16> = "Select files\0".encode_utf16().collect();
        ofn.lpstrFilter = filter.as_ptr();
        ofn.lpstrFile = buf.as_mut_ptr();
        ofn.nMaxFile = buf.len() as u32;
        ofn.lpstrTitle = title.as_ptr();
        ofn.Flags = OFN_ALLOWMULTISELECT | OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR;
        if GetOpenFileNameW(&mut ofn) == 0 {
            return vec![];
        }
        // UTF-16 strings terminated by a double NUL:
        // single: "C:\dir\file\0"  multi: "C:\dir\0a.bin\0b.bin\0\0"
        let end = buf
            .windows(2)
            .position(|w| w[0] == 0 && w[1] == 0)
            .unwrap_or(buf.len());
        let s = String::from_utf16_lossy(&buf[..end]);
        let parts: Vec<&str> = s.split('\0').filter(|p| !p.is_empty()).collect();
        if parts.is_empty() {
            return vec![];
        }
        if parts.len() == 1 {
            return vec![parts[0].to_string()];
        }
        let dir_part = parts[0];
        parts[1..]
            .iter()
            .map(|f| format!("{}\\{}", dir_part, f))
            .collect()
    }
}

#[cfg(not(windows))]
fn pick_files_impl() -> Vec<String> {
    vec![]
}

/// Native save-as dialog. `default_name` prefills the filename; returns the
/// chosen full path or empty on cancel.
#[tauri::command]
pub fn pick_save_path(default_name: String) -> String {
    pick_save_path_impl(default_name)
}

#[cfg(windows)]
fn pick_save_path_impl(default_name: String) -> String {
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetSaveFileNameW, OPENFILENAMEW, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
    };
    unsafe {
        let mut buf = vec![0u16; 32 * 1024];
        // prefill filename (wide)
        let name_w: Vec<u16> = default_name.encode_utf16().collect();
        let n = name_w.len().min(buf.len() - 1);
        buf[..n].copy_from_slice(&name_w[..n]);

        let filter: Vec<u16> = "All files\0*.*\0\0".encode_utf16().collect();
        let title: Vec<u16> = "Save as\0".encode_utf16().collect();
        let mut ofn: OPENFILENAMEW = std::mem::zeroed();
        ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        ofn.hwndOwner = std::ptr::null_mut();
        ofn.lpstrFilter = filter.as_ptr();
        ofn.lpstrFile = buf.as_mut_ptr();
        ofn.nMaxFile = buf.len() as u32;
        ofn.lpstrTitle = title.as_ptr();
        ofn.Flags = OFN_OVERWRITEPROMPT | OFN_NOCHANGEDIR;
        if GetSaveFileNameW(&mut ofn) == 0 {
            return String::new();
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(0);
        String::from_utf16_lossy(&buf[..end])
    }
}

#[cfg(not(windows))]
fn pick_save_path_impl(_default_name: String) -> String {
    String::new()
}
