//! The app outside its window: the one running instance, staying resident, and the double copy.
//!
//! With [`Settings::resident`], the app keeps running when its window closes, and the window
//! opens again from the notification-area icon (Windows), the Dock (macOS), or by starting the app
//! again. The window's view owns the model, which is released with it and loaded again by the
//! next window.

use std::path::PathBuf;

use desktop::clipboard::Watcher;
use desktop::instance::{Claim, Instance, Request, Tray};
use gpui_kit::component::TitleBar;
use gpui_kit::*;
use rust_i18n::t;

use crate::settings::Settings;
use crate::view::{self, TranslatorView};

actions!(plamo_translate, [Quit]);

/// Names the lock file, socket, and window class of the running instance.
const APP_ID: &str = "plamo-translate-desktop";

/// Sent from the instance's and the clipboard watcher's threads.
pub enum Message {
    Request(Request),
    DoubleCopy(String),
}

pub type Messages = (
    async_channel::Sender<Message>,
    async_channel::Receiver<Message>,
);

pub fn messages() -> Messages {
    async_channel::unbounded()
}

/// Becomes the running instance, or asks the one that runs to show its window (`Ok(None)`: this
/// process should then exit).
pub fn claim(messages: &async_channel::Sender<Message>) -> std::io::Result<Option<Instance>> {
    let tx = messages.clone();
    Ok(
        match desktop::instance::claim(APP_ID, move |request| {
            let _ = tx.try_send(Message::Request(request));
        })? {
            Claim::First(instance) => Some(instance),
            Claim::Running => None,
        },
    )
}

struct Shell {
    custom_model: Option<PathBuf>,
    /// The window and its view, while open.
    main: Option<(AnyWindowHandle, WeakEntity<TranslatorView>)>,
    instance: Option<Instance>,
    resident: bool,
    watcher: Option<Watcher>,
    /// Why the clipboard cannot be watched, shown in Settings.
    watch_error: Option<std::io::Error>,
    messages: async_channel::Sender<Message>,
}

impl Global for Shell {}

/// Sets up what outlives the window. `instance` is `None` when the check for a running instance
/// failed: the app then runs on its own, as before.
pub fn init(
    custom_model: Option<PathBuf>,
    instance: Option<Instance>,
    (tx, rx): Messages,
    settings: &Settings,
    cx: &mut App,
) {
    cx.set_global(Shell {
        custom_model,
        main: None,
        instance,
        resident: false,
        watcher: None,
        watch_error: None,
        messages: tx,
    });
    cx.spawn(async move |cx| {
        while let Ok(message) = rx.recv().await {
            cx.update(|cx| handle(message, cx));
        }
    })
    .detach();
    // The app decides itself whether the last window closing quits it (see `main`).
    cx.on_window_closed(|cx, _| {
        if cx.windows().is_empty() && !cx.global::<Shell>().resident {
            cx.quit();
        }
    })
    .detach();
    cx.on_app_quit(|cx| {
        // Synchronous: the icon is gone before the process exits.
        if let Some(instance) = &cx.global::<Shell>().instance {
            instance.set_tray(None);
        }
        async {}
    })
    .detach();
    cx.on_action(|_: &Quit, cx: &mut App| cx.quit());
    let quit = if cfg!(target_os = "macos") {
        "cmd-q"
    } else {
        "ctrl-q"
    };
    cx.bind_keys([KeyBinding::new(quit, Quit, None)]);
    set_resident(settings.resident, cx);
    if settings.double_copy {
        set_double_copy(true, cx);
    }
}

fn handle(message: Message, cx: &mut App) {
    match message {
        Message::Request(Request::Show) => show(None, cx),
        Message::Request(Request::Quit) => cx.quit(),
        Message::DoubleCopy(text) => {
            if text.trim().is_empty() {
                return;
            }
            // A double copy in the app itself, such as the copy button clicked twice.
            if main_window_active(cx) {
                crate::app_log!("double copy in the app's own window: ignored");
                return;
            }
            crate::app_log!(
                "double copy: translating {} characters",
                text.chars().count()
            );
            show(Some(text), cx);
        }
    }
}

fn main_window_active(cx: &mut App) -> bool {
    let Some((handle, _)) = cx.global::<Shell>().main.clone() else {
        return false;
    };
    handle
        .update(cx, |_, window, _| window.is_window_active())
        .unwrap_or(false)
}

/// Brings the window to the front, opening it if it is closed, and translates `text` there.
pub fn show(text: Option<String>, cx: &mut App) {
    cx.activate(true);
    if let Some((handle, view)) = cx.global::<Shell>().main.clone() {
        let shown = handle.update(cx, |_, window, cx| {
            window.activate_window();
            if let (Some(text), Some(view)) = (text.clone(), view.upgrade()) {
                view.update(cx, |view, cx| view.translate_text(text, window, cx));
            }
        });
        if shown.is_ok() {
            return;
        }
    }
    if let Err(e) = open_window(Settings::load(), text, cx) {
        crate::app_log!("cannot open the window: {e}");
    }
}

/// Opens the window, with `text` to translate in it.
pub fn open_window(settings: Settings, text: Option<String>, cx: &mut App) -> Result<(), String> {
    // A larger UI size opens a larger window too, within the screen.
    let scale = settings.ui_scale_factor();
    let screen = cx.primary_display().map(|d| d.bounds().size);
    let fit = |width: f32, height: f32| {
        let (max_width, max_height) = screen.map_or((f32::MAX, f32::MAX), |s| {
            (f32::from(s.width) * 0.9, f32::from(s.height) * 0.9)
        });
        size(
            px((width * scale).min(max_width)),
            px((height * scale).min(max_height)),
        )
    };
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            fit(1100., 720.),
            cx,
        ))),
        window_min_size: Some(fit(640., 400.)),
        // Matches the desktop entry name on Linux, so the window gets its icon.
        app_id: Some("plamo-translate-desktop".into()),
        ..TitleBar::window_options()
    };
    let custom_model = cx.global::<Shell>().custom_model.clone();
    let (handle, view) = gpui_kit::open_window(options, cx, |window, cx| {
        view::apply_appearance(&settings, window, cx);
        cx.new(|cx| TranslatorView::new(custom_model, settings, window, cx))
    })
    .map_err(|e| e.to_string())?;
    if let Some(text) = text {
        let _ = handle.update(cx, |_, window, cx| {
            view.update(cx, |view, cx| view.translate_text(text, window, cx));
        });
    }
    cx.global_mut::<Shell>().main = Some((handle, view.downgrade()));
    Ok(())
}

/// Keeps the app running without its window, or not. On Windows, the notification-area icon is
/// what opens it again.
pub fn set_resident(resident: bool, cx: &mut App) {
    let shell = cx.global_mut::<Shell>();
    shell.resident = resident;
    if let Some(instance) = &shell.instance {
        instance.set_tray(resident.then(tray_texts));
    }
}

/// The icon's texts follow the UI language.
pub fn refresh_tray(cx: &mut App) {
    let resident = cx.global::<Shell>().resident;
    set_resident(resident, cx);
}

fn tray_texts() -> Tray {
    Tray {
        tooltip: "PLaMo Translate".into(),
        open: t!("tray.open").into_owned(),
        quit: t!("tray.quit").into_owned(),
    }
}

/// Starts or stops watching the clipboard for double copies.
pub fn set_double_copy(enabled: bool, cx: &mut App) {
    let shell = cx.global_mut::<Shell>();
    shell.watch_error = None;
    if !enabled {
        shell.watcher = None;
        return;
    }
    if shell.watcher.is_some() {
        return;
    }
    let tx = shell.messages.clone();
    match desktop::clipboard::watch(move |text| {
        let _ = tx.try_send(Message::DoubleCopy(text));
    }) {
        Ok(watcher) => {
            crate::app_log!("watching the clipboard for double copies");
            shell.watcher = Some(watcher);
        }
        Err(e) => {
            crate::app_log!("cannot watch the clipboard: {e}");
            shell.watch_error = Some(e);
        }
    }
}

/// Why the clipboard cannot be watched, if it was tried and failed, in the UI language.
pub fn watch_error(cx: &App) -> Option<String> {
    let error = cx.global::<Shell>().watch_error.as_ref()?;
    Some(if error.kind() == std::io::ErrorKind::Unsupported {
        t!("settings.double_copy_no_x11").into_owned()
    } else {
        t!("settings.double_copy_failed", message = error.to_string()).into_owned()
    })
}
