//! Pre-flight WebView2 runtime check. Runs before the Tauri builder so a
//! machine without WebView2 gets a native Chinese dialog with a download
//! action instead of Tauri's late English error (or a silent panic).

#![cfg(windows)]

use windows_sys::Win32::UI::Controls::{
    TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TD_ERROR_ICON,
    TDF_ALLOW_DIALOG_CANCELLATION,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, SW_SHOWNORMAL};

const DOWNLOAD_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
const BTN_DOWNLOAD: i32 = 1001;
const BTN_QUIT: i32 = 1002;

/// NUL-terminated UTF-16 for wide Win32 string parameters.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn exit_with_dialog() -> ! {
    let title = wide("EasyDevTerm");
    let main_instruction = wide("缺少 Microsoft WebView2 运行时");
    let content = wide(&format!(
        "EasyDevTerm 依赖 Microsoft WebView2。\n请到 {DOWNLOAD_URL} 下载安装后,重新运行本程序。"
    ));
    let download_label = wide("去下载");
    let quit_label = wide("退出");

    let buttons = [
        TASKDIALOG_BUTTON {
            nButtonID: BTN_DOWNLOAD,
            pszButtonText: download_label.as_ptr(),
        },
        TASKDIALOG_BUTTON {
            nButtonID: BTN_QUIT,
            pszButtonText: quit_label.as_ptr(),
        },
    ];

    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: std::ptr::null_mut(),
        hInstance: std::ptr::null_mut(),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION,
        dwCommonButtons: 0,
        pszWindowTitle: title.as_ptr(),
        Anonymous1: windows_sys::Win32::UI::Controls::TASKDIALOGCONFIG_0 {
            pszMainIcon: TD_ERROR_ICON,
        },
        pszMainInstruction: main_instruction.as_ptr(),
        pszContent: content.as_ptr(),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: BTN_DOWNLOAD,
        cRadioButtons: 0,
        pRadioButtons: std::ptr::null(),
        nDefaultRadioButton: 0,
        pszVerificationText: std::ptr::null(),
        pszExpandedInformation: std::ptr::null(),
        pszExpandedControlText: std::ptr::null(),
        pszCollapsedControlText: std::ptr::null(),
        Anonymous2: windows_sys::Win32::UI::Controls::TASKDIALOGCONFIG_1 {
            pszFooterIcon: std::ptr::null(),
        },
        pszFooter: std::ptr::null(),
        pfCallback: None,
        lpCallbackData: 0,
        cxWidth: 0,
    };

    let mut chosen: i32 = 0;
    let hr = unsafe { TaskDialogIndirect(&config, &mut chosen, std::ptr::null_mut(), std::ptr::null_mut()) };

    if hr == 0 && chosen == BTN_DOWNLOAD {
        // Open the download page in the default browser, then quit.
        let url = wide(DOWNLOAD_URL);
        let open = wide("open");
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                open.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    } else if hr != 0 {
        // TaskDialog unavailable (no comctl32 v6 context): plain MessageBox
        // fallback so the user still gets an explanation, never a silent exit.
        let text = wide(&format!(
            "依赖 Microsoft WebView2,请到 {DOWNLOAD_URL} 下载。"
        ));
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    std::process::exit(1);
}

/// Call first thing in run(): exits the process when WebView2 is missing,
/// returns normally (nothing happens) when it is installed.
pub fn ensure_or_exit() {
    if tauri::webview_version().is_err() {
        exit_with_dialog();
    }
}
