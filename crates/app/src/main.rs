//! PLaMo Translate Desktop.
//!
//! Models are picked and downloaded in the app. A GGUF path given as the first argument or in
//! `PLAMO_MODEL` overrides the saved selection, which is handy for development.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod align;
mod assets;
mod backend;
mod browser;
mod lang;
mod models;
mod shell;
mod view;

// Shared with the browser host; re-exported so the app refers to them as its own modules.
pub(crate) use appdata::{app_log, applog, glossary, settings};

use std::path::PathBuf;

use gpui_kit::*;

rust_i18n::i18n!("locales", fallback = "en");

fn custom_model() -> Option<PathBuf> {
    std::env::args_os()
        .nth(1)
        .or_else(|| std::env::var_os("PLAMO_MODEL"))
        .map(PathBuf::from)
}

/// What a macOS application has to set up itself: GPUI adds no menu bar (Cmd+Q is bound by
/// [`shell::init`] on every system).
#[cfg(target_os = "macos")]
mod macos {
    use gpui_kit::*;

    use crate::shell::Quit;

    pub fn init(cx: &mut App) {
        cx.set_menus(vec![Menu {
            name: "PLaMo Translate".into(),
            items: vec![MenuItem::action("Quit PLaMo Translate", Quit)],
            disabled: false,
        }]);
    }
}

fn main() {
    // A new version, started from the staging folder to swap itself in (see `update::apply`):
    // it does only that, without a window.
    if let Some(plan) = update::apply::requested() {
        applog::init(&settings::log_path());
        match update::apply::run(&plan) {
            Ok(()) => app_log!("update to {} installed", env!("CARGO_PKG_VERSION")),
            Err(e) => app_log!("update to {} failed: {e}", env!("CARGO_PKG_VERSION")),
        }
        return;
    }
    // SAFETY: first thing in main, before any thread starts.
    unsafe {
        appdata::devices::configure_openvino();
        engine::llama::configure_metal();
    }
    let custom_model = custom_model();
    applog::init(&settings::log_path());
    // The release build has no console on Windows: a panic is recorded in the log, then handled
    // as before (the message on stderr, and the thread unwinding).
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        app_log!("panic: {info}");
        default_hook(info);
    }));
    let settings = settings::Settings::load();
    app_log!(
        "starting {} {}; models in {}",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        settings.models_dir().display()
    );
    // Files found on Hugging Face by earlier runs; the Models dialog refreshes this list.
    let cached = engine::discovery::load_cache(&settings::catalog_cache_path());
    let added = engine::models::register(cached.into_iter().map(|d| d.into_entry()));
    if added > 0 {
        app_log!("catalog: {added} cached entries newer than the built-in list");
    }
    // Shared with gpui-component, so its built-in strings follow the same locale.
    rust_i18n::set_locale(settings.ui_language.locale());

    // Starting the app again shows the running one's window instead.
    let messages = shell::messages();
    let instance = match shell::claim(&messages.0) {
        Ok(Some(instance)) => Some(instance),
        Ok(None) => {
            app_log!("already running: asked that instance to show its window");
            return;
        }
        Err(e) => {
            app_log!("cannot reach the running instance, or become it: {e}");
            None
        }
    };

    // The shell decides whether the last window closing quits the app: not when it stays
    // resident (on macOS too, where the Dock opens the window again).
    let app = gpui_kit::application()
        .with_assets(assets::AppAssets)
        .with_quit_mode(QuitMode::Explicit);
    app.on_reopen(|cx| shell::show(None, cx));
    app.run(move |cx| {
        gpui_kit::init(cx);
        view::bind_keys(cx);
        shell::init(custom_model, instance, messages, &settings, cx);
        #[cfg(target_os = "macos")]
        macos::init(cx);
        shell::open_window(settings, None, cx).expect("failed to open the main window");
        cx.activate(true);
    });
}
