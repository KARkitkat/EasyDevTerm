mod cmds;
mod discover;
mod rsh;
mod serial;
mod session;
mod settings;
mod telnet;
mod tftp;
mod webview_check;

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("hello, {}", name)
}

/// App version from tauri.conf.json (package_info), for the sidebar badge
/// and the window title. Cheap: reads the info baked in at compile time.
#[tauri::command]
fn app_version(handle: tauri::AppHandle) -> String {
    handle.package_info().version.to_string()
}

/// Toggle WebView2 devtools (F12). The `devtools` cargo feature only makes
/// the API available; devtools stay closed until this is called.
#[tauri::command]
fn devtools_toggle(window: tauri::WebviewWindow) -> Result<String, String> {
    if window.is_devtools_open() {
        window.close_devtools();
        Ok("closed".into())
    } else {
        window.open_devtools();
        Ok("open".into())
    }
}

#[cfg(mobile)]
tauri::mobile_entry_point!(easydevterm_app_run);

pub fn run() {
    env_logger::init();
    // Before anything builds a webview: a machine without WebView2 gets our
    // native dialog (download/quit) instead of Tauri's late English error.
    webview_check::ensure_or_exit();
    tauri::Builder::default()
        .manage(session::SessionManager::new())
        .manage(settings::SettingsStore::load())
        .manage(tftp::TftpServer::default())
        .manage(std::sync::Arc::new(rsh::RshManager::default()))
        .setup(|app| {
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            app_version,
            devtools_toggle,
            session::session_list,
            session::session_close,
            serial::serial_list,
            serial::serial_open,
            serial::serial_write,
            serial::serial_close,
            telnet::telnet_open,
            telnet::telnet_write,
            telnet::telnet_close,
            discover::scan_subnet,
            discover::scan_gateways,
            discover::list_local_ips,
            discover::local_ip_toward,
            discover::pick_files,
            discover::pick_save_path,
            settings::settings_get,
            settings::settings_set,
            settings::history_add,
            tftp::tftp_server_start,
            tftp::tftp_server_stop,
            tftp::tftp_server_status,
            tftp::tftp_default_dir,
            tftp::tftp_get,
            tftp::tftp_put,
            tftp::tftp_list_dir,
            tftp::tftp_copy_in,
            tftp::tftp_export,
            tftp::read_file_base64,
            tftp::write_file_base64,
            rsh::rsh_exec,
            rsh::rsh_pwd,
            rsh::rsh_ls,
            cmds::cmds_list,
            cmds::cmds_save,
            cmds::cmds_path_str,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
