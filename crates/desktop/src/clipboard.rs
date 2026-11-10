//! Double copy: the clipboard changing twice in quick succession, as Ctrl+C (⌘C) pressed twice in
//! any application does.
//!
//! Only the clipboard is watched, never the keyboard, so no permission is needed and copying
//! works as before. A second Ctrl+C with nothing selected leaves the clipboard as it was in most
//! applications, so an old clipboard is not taken for a new copy.
//!
//! - Windows: clipboard update notifications (`AddClipboardFormatListener`).
//! - macOS: the pasteboard's change count, polled while the watcher runs.
//! - Linux: selection owner notifications of the X server (XFixes). In a Wayland session this is
//!   Xwayland, which follows the Wayland clipboard; without `DISPLAY` nothing can be watched.
//!
//! Windows and macOS read the clipboard only when a double copy completes, which spares the
//! copying application from producing its text for every copy. Linux reads it at every change, as
//! bridged clipboards change more than once per copy (see `imp::run` there).

use std::io;
use std::time::{Duration, Instant};

/// Longest time from the first copy to the second.
pub const WITHIN: Duration = Duration::from_millis(500);

/// Changes this close to the previous one belong to the same copy: some applications write the
/// clipboard more than once per copy, and macOS is polled at a shorter interval.
pub const BURST: Duration = Duration::from_millis(60);

/// Tells double copies from clipboard changes.
#[derive(Debug, Default)]
pub struct DoubleCopy {
    state: State,
}

#[derive(Debug, Default)]
enum State {
    #[default]
    Idle,
    /// One copy, which started at `started` and last changed the clipboard at `last`.
    Copied { started: Instant, last: Instant },
    /// A double copy completed; its last change was at `last`. A third copy starts anew.
    Fired { last: Instant },
}

impl DoubleCopy {
    /// Records a clipboard change at `at` and returns whether it completes a double copy.
    pub fn change(&mut self, at: Instant) -> bool {
        match &mut self.state {
            State::Copied { last, .. } | State::Fired { last }
                if at.saturating_duration_since(*last) < BURST =>
            {
                *last = at;
                false
            }
            State::Copied { started, .. } if at.saturating_duration_since(*started) <= WITHIN => {
                self.state = State::Fired { last: at };
                true
            }
            _ => {
                self.state = State::Copied {
                    started: at,
                    last: at,
                };
                false
            }
        }
    }
}

/// Watches the clipboard until dropped.
pub struct Watcher {
    _imp: imp::Watcher,
}

/// Starts watching the clipboard. `on_double_copy` receives the clipboard's text after each
/// double copy, on a thread of the watcher's (a double copy of something other than text is
/// skipped).
///
/// Fails where the clipboard cannot be watched: on Linux without an X server, with
/// [`io::ErrorKind::Unsupported`].
pub fn watch(on_double_copy: impl FnMut(String) + Send + 'static) -> io::Result<Watcher> {
    Ok(Watcher {
        _imp: imp::watch(Box::new(on_double_copy))?,
    })
}

type Callback = Box<dyn FnMut(String) + Send>;

#[cfg(windows)]
mod imp {
    use std::cell::RefCell;
    use std::io;
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, RemoveClipboardFormatListener,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, DestroyWindow, PostMessageW, PostQuitMessage, WM_CLIPBOARDUPDATE, WM_CLOSE,
        WM_DESTROY,
    };

    use super::{Callback, DoubleCopy};
    use crate::win;

    const CLASS: &str = "plamo-translate-desktop.clipboard";

    struct State {
        detector: DoubleCopy,
        on_double_copy: Callback,
    }

    thread_local! {
        static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    }

    pub struct Watcher {
        /// The listening window, as an integer: a window handle is not `Send`.
        hwnd: isize,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for Watcher {
        fn drop(&mut self) {
            // SAFETY: posting to a window that may already be gone only fails.
            unsafe { PostMessageW(self.hwnd as HWND, WM_CLOSE, 0, 0) };
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    pub fn watch(on_double_copy: Callback) -> io::Result<Watcher> {
        let (tx, rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("clipboard".into())
            .spawn(move || {
                let hwnd = match win::hidden_window(CLASS, Some(window_proc), true) {
                    Ok(hwnd) => hwnd,
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        return;
                    }
                };
                // SAFETY: `hwnd` is this thread's window.
                if unsafe { AddClipboardFormatListener(hwnd) } == 0 {
                    let e = io::Error::last_os_error();
                    unsafe { DestroyWindow(hwnd) };
                    let _ = tx.send(Err(e));
                    return;
                }
                STATE.with_borrow_mut(|state| {
                    *state = Some(State {
                        detector: DoubleCopy::default(),
                        on_double_copy,
                    })
                });
                let _ = tx.send(Ok(hwnd as isize));
                win::run_message_loop();
                STATE.with_borrow_mut(|state| state.take());
            })?;
        let hwnd = rx
            .recv()
            .map_err(|_| io::Error::other("the clipboard thread ended"))??;
        Ok(Watcher {
            hwnd,
            thread: Some(thread),
        })
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_CLIPBOARDUPDATE => {
                let now = Instant::now();
                let fired = STATE.with_borrow_mut(|state| {
                    state
                        .as_mut()
                        .is_some_and(|state| state.detector.change(now))
                });
                if fired && let Some(text) = read_text(hwnd) {
                    STATE.with_borrow_mut(|state| {
                        if let Some(state) = state {
                            (state.on_double_copy)(text);
                        }
                    });
                }
                0
            }
            WM_CLOSE => {
                // SAFETY: this thread's window.
                unsafe {
                    RemoveClipboardFormatListener(hwnd);
                    DestroyWindow(hwnd);
                }
                0
            }
            WM_DESTROY => {
                // SAFETY: ends this thread's message loop.
                unsafe { PostQuitMessage(0) };
                0
            }
            // SAFETY: the arguments are the ones this procedure received.
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    /// The clipboard's text, if it has some.
    fn read_text(hwnd: HWND) -> Option<String> {
        let format = u32::from(CF_UNICODETEXT);
        // SAFETY: the clipboard is opened by this thread's window and closed before returning;
        // the data is read only while locked, within the size of its memory block.
        unsafe {
            if IsClipboardFormatAvailable(format) == 0 {
                return None;
            }
            // The application that copied may hold the clipboard a moment longer.
            let mut opened = false;
            for _ in 0..10 {
                if OpenClipboard(hwnd) != 0 {
                    opened = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if !opened {
                return None;
            }
            let handle = GetClipboardData(format);
            let mut text = None;
            if !handle.is_null() {
                let data = GlobalLock(handle).cast::<u16>();
                if !data.is_null() {
                    let len = GlobalSize(handle) / 2;
                    let units = std::slice::from_raw_parts(data, len);
                    let end = units.iter().position(|&u| u == 0).unwrap_or(len);
                    text = Some(String::from_utf16_lossy(&units[..end]));
                    GlobalUnlock(handle);
                }
            }
            CloseClipboard();
            text
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::io;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    use super::{Callback, DoubleCopy};

    /// Shorter than [`super::BURST`], so the polls that see one copy merge into it.
    const POLL: Duration = Duration::from_millis(40);

    pub struct Watcher {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for Watcher {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    pub fn watch(mut on_double_copy: Callback) -> io::Result<Watcher> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = thread::Builder::new()
            .name("clipboard".into())
            .spawn(move || {
                let mut detector = DoubleCopy::default();
                let mut count = NSPasteboard::generalPasteboard().changeCount();
                while !stopping.load(Ordering::Relaxed) {
                    thread::sleep(POLL);
                    let text = autoreleasepool(|_| {
                        let pasteboard = NSPasteboard::generalPasteboard();
                        let now = pasteboard.changeCount();
                        if now == count {
                            return None;
                        }
                        count = now;
                        if !detector.change(Instant::now()) {
                            return None;
                        }
                        // SAFETY: an AppKit constant, never mutated.
                        let kind = unsafe { NSPasteboardTypeString };
                        pasteboard.stringForType(kind).map(|text| text.to_string())
                    });
                    if let Some(text) = text {
                        on_double_copy(text);
                    }
                }
            })?;
        Ok(Watcher {
            stop,
            thread: Some(thread),
        })
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use std::collections::VecDeque;
    use std::io;
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use x11rb::connection::Connection;
    use x11rb::protocol::Event;
    use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEventMask};
    use x11rb::protocol::xproto::{
        Atom, AtomEnum, ClientMessageEvent, ConnectionExt as _, CreateWindowAux, EventMask, Window,
        WindowClass,
    };
    use x11rb::rust_connection::RustConnection;
    use x11rb::{CURRENT_TIME, NONE};

    use super::{Callback, DoubleCopy};

    /// How long the clipboard's owner has to hand over its text.
    const READ_TIMEOUT: Duration = Duration::from_secs(1);

    pub struct Watcher {
        conn: Arc<RustConnection>,
        window: Window,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for Watcher {
        fn drop(&mut self) {
            // Wakes the thread, which waits for events of its window.
            let event = ClientMessageEvent::new(32, self.window, AtomEnum::NOTICE, [0u32; 5]);
            let _ = self
                .conn
                .send_event(false, self.window, EventMask::NO_EVENT, event);
            let _ = self.conn.flush();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    struct Atoms {
        clipboard: Atom,
        utf8_string: Atom,
        incr: Atom,
        /// Where the owner puts the text for this window.
        property: Atom,
    }

    fn x11_error(e: impl std::fmt::Display) -> io::Error {
        io::Error::other(format!("X server: {e}"))
    }

    pub fn watch(on_double_copy: Callback) -> io::Result<Watcher> {
        if std::env::var_os("DISPLAY").is_none_or(|display| display.is_empty()) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "no X server (DISPLAY is not set)",
            ));
        }
        let (conn, screen) = RustConnection::connect(None).map_err(x11_error)?;
        let conn = Arc::new(conn);
        conn.xfixes_query_version(5, 0)
            .map_err(x11_error)?
            .reply()
            .map_err(x11_error)?;
        let root = conn.setup().roots[screen].root;
        let window = conn.generate_id().map_err(x11_error)?;
        conn.create_window(
            0,
            window,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            0,
            &CreateWindowAux::new(),
        )
        .map_err(x11_error)?;
        let intern = |name: &[u8]| -> io::Result<Atom> {
            Ok(conn
                .intern_atom(false, name)
                .map_err(x11_error)?
                .reply()
                .map_err(x11_error)?
                .atom)
        };
        let atoms = Atoms {
            clipboard: intern(b"CLIPBOARD")?,
            utf8_string: intern(b"UTF8_STRING")?,
            incr: intern(b"INCR")?,
            property: intern(b"PLAMO_TRANSLATE_CLIPBOARD")?,
        };
        conn.xfixes_select_selection_input(
            window,
            atoms.clipboard,
            SelectionEventMask::SET_SELECTION_OWNER,
        )
        .map_err(x11_error)?;
        conn.flush().map_err(x11_error)?;

        let thread_conn = conn.clone();
        let thread = thread::Builder::new()
            .name("clipboard".into())
            .spawn(move || run(&thread_conn, window, &atoms, on_double_copy))?;
        Ok(Watcher {
            conn,
            window,
            thread: Some(thread),
        })
    }

    /// Whether `event` is the watcher's own message to stop.
    fn is_stop(event: &Event, window: Window) -> bool {
        matches!(event, Event::ClientMessage(e) if e.window == window)
    }

    /// Unlike on the other systems, the clipboard is read at every change: a change without text
    /// is not a copy, and the two copies must hold the same text. A bridged clipboard changes
    /// more than once per copy, first without text: WSLg announces a copy made in Windows before
    /// its text arrives, a few hundred milliseconds later.
    fn run(conn: &RustConnection, window: Window, atoms: &Atoms, mut on_double_copy: Callback) {
        let mut detector = DoubleCopy::default();
        let mut previous: Option<String> = None;
        // Server time (milliseconds, wrapping) of the first change, and when it was seen: the
        // changes are timed by the server, not by when this thread gets to them.
        let mut epoch: Option<(u32, Instant)> = None;
        // Events that arrived while the clipboard was being read.
        let mut pending = VecDeque::new();
        loop {
            let event = match pending.pop_front() {
                Some(event) => event,
                None => match conn.wait_for_event() {
                    Ok(event) => event,
                    Err(_) => return,
                },
            };
            if is_stop(&event, window) {
                return;
            }
            let Event::XfixesSelectionNotify(notify) = event else {
                continue;
            };
            if notify.selection != atoms.clipboard || notify.owner == NONE {
                continue;
            }
            let (server, seen) = *epoch.get_or_insert((notify.timestamp, Instant::now()));
            let at = seen + Duration::from_millis(u64::from(notify.timestamp.wrapping_sub(server)));
            let text = match read_text(conn, window, atoms, &mut pending) {
                Read::Text(text) if !text.is_empty() => text,
                Read::Text(_) | Read::Nothing => continue,
                Read::Stop => return,
            };
            if detector.change(at) && previous.as_deref() == Some(text.as_str()) {
                on_double_copy(text.clone());
            }
            previous = Some(text);
        }
    }

    enum Read {
        Text(String),
        Nothing,
        Stop,
    }

    /// Asks the clipboard's owner for its text as UTF-8 and waits for it; other events go to
    /// `pending`. Text too large for one transfer (INCR) is not read.
    fn read_text(
        conn: &RustConnection,
        window: Window,
        atoms: &Atoms,
        pending: &mut VecDeque<Event>,
    ) -> Read {
        let asked = conn
            .convert_selection(
                window,
                atoms.clipboard,
                atoms.utf8_string,
                atoms.property,
                CURRENT_TIME,
            )
            .is_ok()
            && conn.flush().is_ok();
        if !asked {
            return Read::Nothing;
        }
        let deadline = Instant::now() + READ_TIMEOUT;
        loop {
            match conn.poll_for_event() {
                Ok(Some(event)) if is_stop(&event, window) => return Read::Stop,
                Ok(Some(Event::SelectionNotify(e))) if e.requestor == window => {
                    if e.property == NONE {
                        return Read::Nothing;
                    }
                    break;
                }
                Ok(Some(event)) => pending.push_back(event),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Ok(None) | Err(_) => return Read::Nothing,
            }
        }
        let reply = conn
            .get_property(true, window, atoms.property, AtomEnum::ANY, 0, u32::MAX / 4)
            .ok()
            .and_then(|cookie| cookie.reply().ok());
        match reply {
            Some(reply) if reply.type_ != atoms.incr => match String::from_utf8(reply.value) {
                Ok(text) => Read::Text(text),
                Err(_) => Read::Nothing,
            },
            _ => Read::Nothing,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn two_copies_in_quick_succession_are_a_double_copy() {
        let start = Instant::now();
        let mut detector = DoubleCopy::default();
        assert!(!detector.change(start));
        assert!(detector.change(start + ms(250)));
    }

    #[test]
    fn copies_far_apart_are_not() {
        let start = Instant::now();
        let mut detector = DoubleCopy::default();
        assert!(!detector.change(start));
        assert!(!detector.change(start + WITHIN + ms(1)));
        // The late copy is a first copy itself.
        assert!(detector.change(start + WITHIN + ms(200)));
    }

    #[test]
    fn writes_of_one_copy_count_once() {
        let start = Instant::now();
        let mut detector = DoubleCopy::default();
        assert!(!detector.change(start));
        assert!(!detector.change(start + ms(10)));
        assert!(!detector.change(start + ms(40)));
        assert!(detector.change(start + ms(300)));
        // The second copy's own extra write does not start a new copy.
        assert!(!detector.change(start + ms(320)));
    }

    #[test]
    fn a_watcher_stops_when_dropped() {
        // Where the clipboard cannot be watched (Linux without an X server), there is nothing
        // to stop.
        let Ok(watcher) = watch(|_| {}) else {
            return;
        };
        let start = Instant::now();
        drop(watcher);
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_third_copy_starts_anew() {
        let start = Instant::now();
        let mut detector = DoubleCopy::default();
        assert!(!detector.change(start));
        assert!(detector.change(start + ms(200)));
        assert!(!detector.change(start + ms(400)));
        assert!(detector.change(start + ms(600)));
    }
}
