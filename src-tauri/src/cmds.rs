//! Quick commands: stored as `cmds.json` next to the exe (portable, same dir
//! as config.json). Simple flat list with optional group field; the frontend
//! renders groups as sections.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickCmd {
    pub name: String,
    pub cmd: String,
    #[serde(default)]
    pub group: String,
    /// Marker for an EMPTY folder entry: renders a folder header with no
    /// commands. Name is stored in `group`; `name` is a reserved sentinel.
    #[serde(default)]
    pub folder: bool,
}

fn cmds_path() -> std::path::PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("."));
    exe.parent().unwrap_or(&exe).join("cmds.json")
}

#[tauri::command]
pub fn cmds_list() -> Vec<QuickCmd> {
    std::fs::read_to_string(cmds_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| {
            // sensible defaults on first run
            vec![
                QuickCmd {
                    name: "查看系统信息".into(),
                    cmd: "uname -a".into(),
                    group: "收藏".into(),
                    folder: false,
                },
                QuickCmd {
                    name: "内存占用".into(),
                    cmd: "free -m".into(),
                    group: "收藏".into(),
                    folder: false,
                },
            ]
        })
}

#[tauri::command]
pub fn cmds_save(cmds: Vec<QuickCmd>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&cmds).map_err(|e| e.to_string())?;
    std::fs::write(cmds_path(), json).map_err(|e| format!("写命令文件失败: {e}"))?;
    Ok(())
}

/// Path of cmds.json for the "open folder / hand-edit" workflow.
#[tauri::command]
pub fn cmds_path_str() -> String {
    cmds_path().to_string_lossy().to_string()
}
