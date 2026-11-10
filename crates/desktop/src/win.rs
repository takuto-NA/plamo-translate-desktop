//! Hidden windows that receive messages on a thread of their own.

use std::io;
use std::ptr;

use windows_sys::Win32::Foundation::{ERROR_CLASS_ALREADY_EXISTS, GetLastError, HWND};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG, RegisterClassW,
    TranslateMessage, WNDCLASSW, WNDPROC,
};

/// `s` as a NUL-terminated UTF-16 string.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// Creates a window of class `class`, registered here with `proc`, that is never shown.
///
/// A message-only window is invisible to `FindWindow` and receives no broadcasts, such as the one
/// that asks notification-area icons to be added again: a window that needs either is a hidden
/// top-level window instead.
pub fn hidden_window(class: &str, proc: WNDPROC, message_only: bool) -> io::Result<HWND> {
    let class = wide(class);
    // SAFETY: the class name outlives both calls, and the window procedure is a valid function.
    unsafe {
        let instance = GetModuleHandleW(ptr::null());
        let wc = WNDCLASSW {
            lpfnWndProc: proc,
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        if RegisterClassW(&wc) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
            return Err(io::Error::last_os_error());
        }
        let parent = if message_only {
            HWND_MESSAGE
        } else {
            ptr::null_mut()
        };
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            parent,
            ptr::null_mut(),
            instance,
            ptr::null(),
        );
        if hwnd.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(hwnd)
        }
    }
}

/// Dispatches the thread's messages until `WM_QUIT`.
pub fn run_message_loop() {
    // SAFETY: `msg` is a valid, writable MSG for every call.
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
