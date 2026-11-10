//! One running instance per user.
//!
//! The first instance holds a lock file while it runs (the system releases it when the process
//! ends, also after a crash) and listens for requests. Starting the app again finds the lock
//! taken, asks the running instance to show its window, and exits: a second instance would load a
//! second model and watch the clipboard twice.
//!
//! - Windows: a hidden window, found by its class, receives the request. It also owns the
//!   notification-area icon ([`Instance::set_tray`]).
//! - Linux and macOS: a Unix socket next to the lock file. On macOS, opening the app bundle again
//!   reaches the running instance through the system anyway; this covers the executable started
//!   directly.

use std::fs::{File, TryLockError};
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// What the running instance is asked to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    /// Show the window, opening it if it is closed.
    Show,
    /// Quit (from the notification-area icon's menu).
    Quit,
}

pub enum Claim {
    /// This is the first instance. Requests arrive while the value lives.
    First(Instance),
    /// Another instance runs, and was asked to show its window.
    Running,
}

/// The notification-area icon's texts, in the UI language.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tray {
    pub tooltip: String,
    pub open: String,
    pub quit: String,
}

/// How long a new instance tries to reach the running one, which may be starting itself.
const REACH_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Instance {
    _lock: File,
    listener: imp::Listener,
}

impl Instance {
    /// Shows the notification-area icon with `tray`'s texts, or removes it with `None`. Its click
    /// and menu send [`Request::Show`] and [`Request::Quit`]. Windows only: elsewhere this does
    /// nothing.
    pub fn set_tray(&self, tray: Option<Tray>) {
        self.listener.set_tray(tray);
    }
}

/// Becomes the running instance, or hands over to the one that runs. `on_request` is called on a
/// thread of the instance's.
pub fn claim(app_id: &str, on_request: impl FnMut(Request) + Send + 'static) -> io::Result<Claim> {
    let base = base_path(app_id);
    let lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(base.with_extension("lock"))?;
    match lock.try_lock() {
        Ok(()) => Ok(Claim::First(Instance {
            listener: imp::listen(app_id, &base, Box::new(on_request))?,
            _lock: lock,
        })),
        Err(TryLockError::WouldBlock) => {
            let deadline = Instant::now() + REACH_TIMEOUT;
            loop {
                match imp::request_show(app_id, &base) {
                    Ok(()) => return Ok(Claim::Running),
                    Err(e) if Instant::now() >= deadline => return Err(e),
                    Err(_) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        }
        Err(TryLockError::Error(e)) => Err(e),
    }
}

/// The lock file and socket, without an extension: in a directory of the user's own.
fn base_path(app_id: &str) -> PathBuf {
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir).join(app_id);
    }
    // Per user on Windows (%TEMP%) and macOS ($TMPDIR); shared on Linux without a runtime
    // directory, hence the user name.
    let name = if cfg!(all(unix, not(target_os = "macos"))) {
        let user = std::env::var("USER").unwrap_or_default();
        format!("{app_id}-{user}")
    } else {
        app_id.to_owned()
    };
    std::env::temp_dir().join(name)
}

type Callback = Box<dyn FnMut(Request) + Send>;

#[cfg(unix)]
mod imp {
    use std::io::{self, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::thread;
    use std::time::Duration;

    use super::{Callback, Request, Tray};

    pub struct Listener;

    impl Listener {
        pub fn set_tray(&self, _tray: Option<Tray>) {}
    }

    fn socket(base: &Path) -> PathBuf {
        base.with_extension("sock")
    }

    pub fn listen(_app_id: &str, base: &Path, mut on_request: Callback) -> io::Result<Listener> {
        let path = socket(base);
        // Left by an instance that ended: the lock says that none runs.
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path)?;
        thread::Builder::new()
            .name("instance".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else {
                        continue;
                    };
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                    let mut buf = [0u8; 16];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if buf[..n].starts_with(b"show") {
                        on_request(Request::Show);
                    }
                }
            })?;
        Ok(Listener)
    }

    pub fn request_show(_app_id: &str, base: &Path) -> io::Result<()> {
        UnixStream::connect(socket(base))?.write_all(b"show\n")
    }
}

#[cfg(windows)]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::io;
    use std::path::Path;
    use std::ptr;
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::{
        NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
        Shell_NotifyIconW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, AppendMenuW, CreatePopupMenu, DefWindowProcW, DestroyMenu,
        FindWindowW, GetCursorPos, GetSystemMetrics, GetWindowThreadProcessId, HICON,
        IDI_APPLICATION, IMAGE_ICON, LR_DEFAULTCOLOR, LoadIconW, LoadImageW, MF_SEPARATOR,
        MF_STRING, PostMessageW, PostQuitMessage, RegisterWindowMessageW, SM_CXSMICON, SM_CYSMICON,
        SendMessageW, SetForegroundWindow, SetMenuDefaultItem, TPM_NONOTIFY, TPM_RETURNCMD,
        TPM_RIGHTBUTTON, TrackPopupMenu, WM_APP, WM_CONTEXTMENU, WM_DESTROY, WM_LBUTTONUP, WM_NULL,
        WM_RBUTTONUP,
    };

    use super::{Callback, Request, Tray};
    use crate::win::{self, wide};

    /// From a new instance: show the window.
    const WM_SHOW: u32 = WM_APP + 1;
    /// From the notification-area icon.
    const WM_TRAY: u32 = WM_APP + 2;
    /// From [`Listener::set_tray`]: apply the wanted icon.
    const WM_SET_TRAY: u32 = WM_APP + 3;
    const ICON_ID: u32 = 1;
    const MENU_OPEN: usize = 1;
    const MENU_QUIT: usize = 2;
    /// The application icon's resource ID (see the app's `build.rs`).
    const APP_ICON: usize = 1;

    struct State {
        on_request: Callback,
        /// The icon wanted by [`Listener::set_tray`].
        wanted: Arc<Mutex<Option<Tray>>>,
        /// The icon shown, with its texts.
        shown: Option<Tray>,
        icon: HICON,
    }

    thread_local! {
        static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
        /// Broadcast when Explorer (re)starts: icons must be added again.
        static TASKBAR_CREATED: Cell<u32> = const { Cell::new(0) };
    }

    pub struct Listener {
        hwnd: isize,
        wanted: Arc<Mutex<Option<Tray>>>,
    }

    impl Listener {
        pub fn set_tray(&self, tray: Option<Tray>) {
            *self.wanted.lock().unwrap_or_else(|e| e.into_inner()) = tray;
            // Synchronous, so the icon is gone before the process exits.
            // SAFETY: a message to the instance's window, which ignores the arguments.
            unsafe { SendMessageW(self.hwnd as HWND, WM_SET_TRAY, 0, 0) };
        }
    }

    fn class(app_id: &str) -> String {
        format!("{app_id}.instance")
    }

    pub fn listen(app_id: &str, _base: &Path, on_request: Callback) -> io::Result<Listener> {
        let class = class(app_id);
        let wanted = Arc::new(Mutex::new(None));
        let thread_wanted = wanted.clone();
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("instance".into())
            .spawn(move || {
                // A top-level window, which `FindWindow` finds and broadcasts reach.
                let hwnd = match win::hidden_window(&class, Some(window_proc), false) {
                    Ok(hwnd) => hwnd,
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        return;
                    }
                };
                let name = wide("TaskbarCreated");
                // SAFETY: a NUL-terminated name.
                TASKBAR_CREATED.set(unsafe { RegisterWindowMessageW(name.as_ptr()) });
                STATE.with_borrow_mut(|state| {
                    *state = Some(State {
                        on_request,
                        wanted: thread_wanted,
                        shown: None,
                        icon: load_icon(),
                    })
                });
                let _ = tx.send(Ok(hwnd as isize));
                win::run_message_loop();
            })?;
        let hwnd = rx
            .recv()
            .map_err(|_| io::Error::other("the instance thread ended"))??;
        Ok(Listener { hwnd, wanted })
    }

    pub fn request_show(app_id: &str, _base: &Path) -> io::Result<()> {
        let class = wide(&class(app_id));
        // SAFETY: a NUL-terminated class name, and a window handle from `FindWindowW`.
        unsafe {
            let hwnd = FindWindowW(class.as_ptr(), ptr::null());
            if hwnd.is_null() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "the running instance has no window yet",
                ));
            }
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            // This process was started by the user, so it may hand the foreground on: the
            // running instance can then bring its window to the front.
            AllowSetForegroundWindow(pid);
            if PostMessageW(hwnd, WM_SHOW, 0, 0) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    /// The application icon at the size of notification-area icons.
    fn load_icon() -> HICON {
        // SAFETY: loads a resource of this executable, or a system icon.
        unsafe {
            let icon = LoadImageW(
                GetModuleHandleW(ptr::null()),
                APP_ICON as *const u16,
                IMAGE_ICON,
                GetSystemMetrics(SM_CXSMICON),
                GetSystemMetrics(SM_CYSMICON),
                LR_DEFAULTCOLOR,
            );
            if icon.is_null() {
                LoadIconW(ptr::null_mut(), IDI_APPLICATION)
            } else {
                icon
            }
        }
    }

    fn icon_data(hwnd: HWND, icon: HICON, tray: &Tray) -> NOTIFYICONDATAW {
        // SAFETY: NOTIFYICONDATAW is plain data, valid when zeroed.
        let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
        data.hWnd = hwnd;
        data.uID = ICON_ID;
        data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        data.uCallbackMessage = WM_TRAY;
        data.hIcon = icon;
        let tip: Vec<u16> = tray.tooltip.encode_utf16().collect();
        let len = tip.len().min(data.szTip.len() - 1);
        data.szTip[..len].copy_from_slice(&tip[..len]);
        data
    }

    /// Adds, changes, or removes the icon to match what is wanted. `again` adds it anew, after
    /// Explorer restarted.
    fn apply_tray(hwnd: HWND, again: bool) {
        STATE.with_borrow_mut(|state| {
            let Some(state) = state else {
                return;
            };
            let wanted = state
                .wanted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            // SAFETY: the data describes this thread's window and an icon handle.
            unsafe {
                match (&wanted, &state.shown) {
                    (Some(tray), None) => {
                        Shell_NotifyIconW(NIM_ADD, &icon_data(hwnd, state.icon, tray));
                    }
                    (Some(tray), Some(_)) if again => {
                        Shell_NotifyIconW(NIM_ADD, &icon_data(hwnd, state.icon, tray));
                    }
                    (Some(tray), Some(shown)) if tray != shown => {
                        Shell_NotifyIconW(NIM_MODIFY, &icon_data(hwnd, state.icon, tray));
                    }
                    (None, Some(shown)) => {
                        Shell_NotifyIconW(NIM_DELETE, &icon_data(hwnd, state.icon, shown));
                    }
                    _ => {}
                }
            }
            state.shown = wanted;
        });
    }

    fn send(request: Request) {
        STATE.with_borrow_mut(|state| {
            if let Some(state) = state {
                (state.on_request)(request);
            }
        });
    }

    /// Shows the icon's menu at the pointer and returns the chosen item, if any.
    fn show_menu(hwnd: HWND, tray: &Tray) -> usize {
        let (open, quit) = (wide(&tray.open), wide(&tray.quit));
        // SAFETY: the menu is this function's, and the strings outlive it.
        unsafe {
            let menu = CreatePopupMenu();
            if menu.is_null() {
                return 0;
            }
            AppendMenuW(menu, MF_STRING, MENU_OPEN, open.as_ptr());
            AppendMenuW(menu, MF_SEPARATOR, 0, ptr::null());
            AppendMenuW(menu, MF_STRING, MENU_QUIT, quit.as_ptr());
            SetMenuDefaultItem(menu, MENU_OPEN as u32, 0);
            let mut point = POINT { x: 0, y: 0 };
            GetCursorPos(&mut point);
            // Without this, the menu stays open when clicking elsewhere.
            SetForegroundWindow(hwnd);
            let chosen = TrackPopupMenu(
                menu,
                TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                point.x,
                point.y,
                0,
                hwnd,
                ptr::null(),
            );
            PostMessageW(hwnd, WM_NULL, 0, 0);
            DestroyMenu(menu);
            chosen as usize
        }
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_SHOW => send(Request::Show),
            WM_SET_TRAY => apply_tray(hwnd, false),
            WM_TRAY => match lparam as u32 {
                WM_LBUTTONUP => send(Request::Show),
                WM_RBUTTONUP | WM_CONTEXTMENU => {
                    // The menu runs its own message loop: the state is not borrowed meanwhile.
                    let shown =
                        STATE.with_borrow(|state| state.as_ref().and_then(|s| s.shown.clone()));
                    if let Some(tray) = shown {
                        match show_menu(hwnd, &tray) {
                            MENU_OPEN => send(Request::Show),
                            MENU_QUIT => send(Request::Quit),
                            _ => {}
                        }
                    }
                }
                _ => {}
            },
            WM_DESTROY => {
                // SAFETY: ends this thread's message loop.
                unsafe { PostQuitMessage(0) };
            }
            _ if message != 0 && message == TASKBAR_CREATED.get() => apply_tray(hwnd, true),
            // SAFETY: the arguments are the ones this procedure received.
            _ => return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
        0
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    #[test]
    fn a_second_instance_reaches_the_first() {
        let app_id = format!("desktop-instance-test-{}", std::process::id());
        let (tx, rx) = mpsc::channel();
        let first = claim(&app_id, move |request| {
            let _ = tx.send(request);
        })
        .expect("first claim");
        assert!(matches!(first, Claim::First(_)));
        let second = claim(&app_id, |_| {}).expect("second claim");
        assert!(matches!(second, Claim::Running));
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)),
            Ok(Request::Show),
            "the first instance is asked to show its window"
        );
        drop(first);
        let _ = std::fs::remove_file(base_path(&app_id).with_extension("lock"));
        let _ = std::fs::remove_file(base_path(&app_id).with_extension("sock"));
    }
}
