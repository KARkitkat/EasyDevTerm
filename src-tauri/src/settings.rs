//! Persistent settings, stored as config.json next to the exe (portable app
//! convention: no %APPDATA%, everything travels with the program folder).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One remembered device for the connect panel's quick-reconnect list.
/// Internally tagged so the frontend can read `kind` directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DeviceRecord {
    Serial {
        port: String,
        baud_rate: u32,
        label: String,
        /// User-assigned display name for saved connections ("" = none).
        #[serde(default)]
        note: String,
    },
    Telnet {
        host: String,
        port: u16,
        label: String,
        #[serde(default)]
        note: String,
    },
}

impl DeviceRecord {
    /// Identity for dedup: same transport + same address (label may drift).
    fn same_as(&self, other: &DeviceRecord) -> bool {
        match (self, other) {
            (
                DeviceRecord::Serial { port: a, .. },
                DeviceRecord::Serial { port: b, .. },
            ) => a == b,
            (
                DeviceRecord::Telnet {
                    host: ha, port: pa, ..
                },
                DeviceRecord::Telnet {
                    host: hb, port: pb, ..
                },
            ) => ha == hb && pa == pb,
            _ => false,
        }
    }
}

/// One per-device auto-login rule: `target` is the serial port name ("COM4")
/// or "host:port" for telnet. Plaintext password: dev tool tradeoff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoLoginRule {
    pub target: String,
    pub user: String,
    pub pass: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Last scan port in the discover panel.
    #[serde(default = "default_scan_port")]
    pub scan_port: u16,
    /// Last selected local interface IP for scanning (empty = auto).
    #[serde(default)]
    pub scan_local_ip: String,
    /// Default serial baud rate.
    #[serde(default = "default_baud")]
    pub baud_rate: u32,
    /// Last TFTP directory.
    #[serde(default)]
    pub tftp_dir: String,
    /// TFTP server port.
    #[serde(default = "default_tftp_port")]
    pub tftp_port: u16,
    /// Command assistant: last NIC IP used by the upload card.
    #[serde(default)]
    pub cmd_upload_ip: String,
    /// Command assistant: last NIC IP used by the download card.
    #[serde(default)]
    pub cmd_download_ip: String,
    /// Command assistant: last download filename.
    #[serde(default = "default_download_name")]
    pub cmd_download_name: String,
    /// Hidden-shell telnet login user.
    #[serde(default = "default_telnet_user")]
    pub telnet_user: String,
    /// Hidden-shell telnet password (plaintext: dev tool tradeoff).
    #[serde(default)]
    pub telnet_password: String,
    /// UI list heights (JSON: {"rb_list": px, "tf_files": px, ...}).
    #[serde(default)]
    pub ui_heights: String,
    /// Recently and successfully connected devices, newest first (max 20).
    #[serde(default)]
    pub device_history: Vec<DeviceRecord>,
    /// User-pinned devices saved from the history list, newest first.
    #[serde(default)]
    pub saved_devices: Vec<DeviceRecord>,
    /// Master switch for auto-login (prompt-triggered credentials injection).
    #[serde(default)]
    pub auto_login_enabled: bool,
    /// "global" (one credential pair) or "per_device" (rules, fallback global).
    #[serde(default = "default_al_mode")]
    pub auto_login_mode: String,
    /// Global auto-login user.
    #[serde(default)]
    pub auto_login_user: String,
    /// Global auto-login password (plaintext: dev tool tradeoff).
    #[serde(default)]
    pub auto_login_pass: String,
    /// Per-device rules, matched by exact target ("COM4" / "host:port").
    #[serde(default)]
    pub auto_login_rules: Vec<AutoLoginRule>,
    /// Whole-UI zoom percent (100/125/150/175/200).
    #[serde(default = "default_ui_zoom")]
    pub ui_zoom: u32,
    /// Terminal font size (px).
    #[serde(default = "default_term_font_size")]
    pub term_font_size: u32,
    /// Terminal foreground color (hex like "#d4d4d4"; empty = built-in default).
    #[serde(default)]
    pub term_fg: String,
    /// Terminal background color (hex; empty = built-in default).
    #[serde(default)]
    pub term_bg: String,
    /// UI (chrome) font size in px; 0 = built-in default 13.
    #[serde(default)]
    pub ui_font_size: u32,
    /// UI (chrome) foreground color (hex; empty = built-in default).
    #[serde(default)]
    pub ui_fg: String,
}

fn default_ui_zoom() -> u32 {
    100
}
fn default_term_font_size() -> u32 {
    13
}

fn default_al_mode() -> String {
    "global".into()
}

fn default_tftp_port() -> u16 {
    69
}
fn default_download_name() -> String {
    String::new()
}
fn default_telnet_user() -> String {
    "root".into()
}

fn default_scan_port() -> u16 {
    23
}
fn default_baud() -> u32 {
    115200
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            scan_port: default_scan_port(),
            scan_local_ip: String::new(),
            baud_rate: default_baud(),
            tftp_dir: String::new(),
            tftp_port: default_tftp_port(),
            cmd_upload_ip: String::new(),
            cmd_download_ip: String::new(),
            cmd_download_name: default_download_name(),
            telnet_user: default_telnet_user(),
            telnet_password: String::new(),
            ui_heights: String::new(),
            device_history: Vec::new(),
            saved_devices: Vec::new(),
            auto_login_enabled: false,
            auto_login_mode: default_al_mode(),
            auto_login_user: String::new(),
            auto_login_pass: String::new(),
            auto_login_rules: Vec::new(),
            ui_zoom: default_ui_zoom(),
            term_font_size: default_term_font_size(),
            term_fg: String::new(),
            term_bg: String::new(),
            ui_font_size: 0,
            ui_fg: String::new(),
        }
    }
}

pub struct SettingsStore(pub Mutex<Settings>);

fn config_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    exe.parent().unwrap_or(&exe).join("config.json")
}

impl SettingsStore {
    pub fn load() -> Self {
        let settings = std::fs::read_to_string(config_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self(Mutex::new(settings))
    }

    pub fn save(&self) -> Result<(), String> {
        let s = self.0.lock().unwrap();
        let path = config_path();
        let json = serde_json::to_string_pretty(&*s).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("写配置失败: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
pub fn settings_get(store: tauri::State<'_, SettingsStore>) -> Settings {
    store.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn settings_set(
    store: tauri::State<'_, SettingsStore>,
    settings: Settings,
) -> Result<(), String> {
    *store.0.lock().unwrap() = settings;
    store.save()
}

/// Record a successful connection. Dedup (same transport + address) is a
/// no-op returning false; new records go to the head, list capped at 20.
/// All of dedup+insert+save happens under one lock hold.
#[tauri::command]
pub fn history_add(
    store: tauri::State<'_, SettingsStore>,
    record: DeviceRecord,
) -> Result<bool, String> {
    let mut s = store.0.lock().unwrap();
    if s.device_history.iter().any(|r| r.same_as(&record)) {
        return Ok(false);
    }
    s.device_history.insert(0, record);
    s.device_history.truncate(20);
    drop(s); // save() re-locks the same mutex - must not hold it here
    store.save()?;
    Ok(true)
}
