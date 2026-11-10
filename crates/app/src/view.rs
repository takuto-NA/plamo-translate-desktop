//! The main translator window.

use std::collections::VecDeque;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use engine::StopReason;
use engine::llama::{Device, RuntimeOptions};
use engine::models::{self as catalog, CatalogEntry, ModelStore};
use engine::pfml::{GlossaryEntry, LangCode, TranslationOptions};
use engine::worker::{Event, JobId, LoadRequest, MeasureRequest, Worker};
use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{
    BufferPoint, DisplayPoint, InputEvent, RopeExt as _, Textarea, TextareaState,
};
use gpui_kit::component::searchable_list::SearchableVec;
use gpui_kit::component::select::{Select, SelectEvent, SelectState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, IconName, IndexPath, Selectable as _, Sizable as _,
    StyledExt as _, Theme, ThemeMode, TitleBar, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use rust_i18n::t;
use update::{CheckCache, Installation, Release, Version};

use crate::align::{Alignment, ChunkSpan, Side};
use crate::backend::{self, BackendEvent, BackendPanel};
use crate::browser;
use crate::glossary;
use crate::lang::{self, Choice, SourceChoice, StyleChoice, TargetChoice};
use crate::models::{ModelsEvent, ModelsPanel};
use crate::settings::{self, DeviceSetting, DocumentSettings, Settings, ThemeSetting, UiLanguage};

actions!(translator, [CopyTranslation]);

const KEY_CONTEXT: &str = "Translator";
/// Delay between the last keystroke and an automatic translation.
const DEBOUNCE: Duration = Duration::from_millis(500);
/// How long the copy button shows its confirmation.
const COPIED_FEEDBACK: Duration = Duration::from_millis(1500);
/// Number of finished translations kept for instant reuse.
const CACHE_SIZE: usize = 64;
/// While text streams in, the output is redrawn at most this often. A GPU produces 100+
/// tokens per second, and redrawing on every token starves input handling.
const STREAM_FRAME: Duration = Duration::from_millis(50);

#[cfg(target_os = "macos")]
const COPY_TRANSLATION_KEY: &str = "cmd-shift-c";
#[cfg(not(target_os = "macos"))]
const COPY_TRANSLATION_KEY: &str = "ctrl-shift-c";

/// Byte offset of the start of the first line visible in `state`.
fn top_offset(state: &TextareaState) -> Option<usize> {
    let line_height = state.line_height()?;
    let row = (-state.scroll_offset().y / line_height).max(0.0) as usize;
    let point = state
        .display_map()
        .display_pos_to_buffer_pos(DisplayPoint::new(row, 0));
    let text = state.text();
    Some((text.line_start_offset(point.line) + point.col).min(text.len()))
}

/// The display row (after wrapping) of byte `offset` in `state`.
fn display_row(state: &TextareaState, offset: usize) -> usize {
    let point = state.text().offset_to_point(offset);
    state
        .display_map()
        .buffer_pos_to_display_pos(BufferPoint::new(point.row, point.column))
        .row
}

/// `n` with thousands separators, such as `12,345`.
fn group_digits(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Chunk and history size options for the settings dialog.
/// The model to load from `store`: the saved selection if it is there, else the default model,
/// else the first one there.
fn model_to_load(settings: &Settings, store: &ModelStore) -> Option<&'static CatalogEntry> {
    let usable = |e: &&CatalogEntry| store.state(e).is_usable();
    settings
        .model
        .as_deref()
        .and_then(catalog::find_entry)
        .filter(usable)
        .or_else(|| Some(catalog::default_entry()).filter(usable))
        .or_else(|| catalog::entries().into_iter().find(usable))
}

fn token_choices(document: &DocumentSettings) -> (Vec<Choice<usize>>, Vec<Choice<usize>>) {
    let defaults = DocumentSettings::default();
    (
        lang::token_choices(
            lang::CHUNK_TOKEN_PRESETS,
            document.chunk_tokens,
            defaults.chunk_tokens,
        ),
        lang::token_choices(
            lang::HISTORY_TOKEN_PRESETS,
            document.history_tokens,
            defaults.history_tokens,
        ),
    )
}

/// This build's version, the settings' Check now button, and what it found.
fn update_check_row(
    check: UpdateCheck,
    muted: Hsla,
    view: WeakEntity<TranslatorView>,
) -> AnyElement {
    let checking = check == UpdateCheck::Checking;
    let result = match check {
        UpdateCheck::Idle => None,
        UpdateCheck::Checking => Some(t!("settings.update_checking")),
        UpdateCheck::UpToDate(version) => {
            Some(t!("settings.update_latest", version = version.to_string()))
        }
        UpdateCheck::Found(version) => Some(t!("update.available", version = version.to_string())),
        UpdateCheck::Failed(error) => Some(t!("settings.update_failed", error = error)),
    };
    h_flex()
        .gap_3()
        .items_center()
        .child(
            div().text_sm().child(
                t!("settings.version", version = Version::current().to_string()).into_owned(),
            ),
        )
        .child(
            Button::new("check-now")
                .small()
                .label(t!("settings.check_now").into_owned())
                .loading(checking)
                .disabled(checking)
                .on_click(move |_, window, cx| {
                    let _ = view.update(cx, |this, cx| this.check_for_update(true, cx));
                    window.refresh();
                }),
        )
        .children(result.map(|text| {
            div()
                .text_xs()
                .text_color(muted)
                .min_w_0()
                .child(text.into_owned())
        }))
        .into_any_element()
}

/// The browser extension section of the settings dialog.
fn browser_settings(
    registration: browser::Registration,
    error: Option<String>,
    muted: Hsla,
    view: WeakEntity<TranslatorView>,
) -> AnyElement {
    let host = browser::host_executable();
    let status = match (&registration, &host) {
        (_, None) => t!("settings.browser_no_host").into_owned(),
        (browser::Registration::NotRegistered, _) => {
            t!("settings.browser_not_registered").into_owned()
        }
        (browser::Registration::Registered, _) => t!("settings.browser_registered").into_owned(),
        (browser::Registration::Elsewhere(_), _) => t!("settings.browser_elsewhere").into_owned(),
    };
    // A long path goes on its own line, so it cannot push the buttons out of the dialog.
    let elsewhere = match &registration {
        browser::Registration::Elsewhere(path) => Some(path.display().to_string()),
        _ => None,
    };
    // Connect while this copy is not the one registered (it needs the host next to it);
    // disconnect whenever any registration exists, even one of a copy that is gone.
    let connect = match registration {
        browser::Registration::Registered => None,
        browser::Registration::Elsewhere(_) => Some(t!("settings.browser_reconnect")),
        browser::Registration::NotRegistered => Some(t!("settings.browser_register")),
    }
    .map(|label| {
        let view = view.clone();
        Button::new("browser-register")
            .small()
            .label(label.into_owned())
            .disabled(host.is_none())
            .on_click(move |_, window, cx| {
                let _ = view.update(cx, |this, _| this.set_browser_registration(true));
                window.refresh();
            })
    });
    let disconnect = (registration != browser::Registration::NotRegistered).then(|| {
        let view = view.clone();
        Button::new("browser-unregister")
            .small()
            .label(t!("settings.browser_unregister").into_owned())
            .on_click(move |_, window, cx| {
                let _ = view.update(cx, |this, _| this.set_browser_registration(false));
                window.refresh();
            })
    });
    let open_folder = browser::extension_dir().map(|dir| {
        Button::new("browser-folder")
            .small()
            .ghost()
            .label(t!("settings.browser_open_folder").into_owned())
            .on_click(move |_, _, cx| cx.open_with_system(&dir))
    });
    v_flex()
        .gap_2()
        .pt_2()
        .child(
            // The label, then the status, the path of another copy, and the buttons stacked
            // beside it, so the buttons never take the status's width.
            h_flex()
                .gap_3()
                .items_start()
                .text_sm()
                .child(
                    div()
                        .w(scaled(140.))
                        .flex_none()
                        .child(t!("settings.browser").into_owned()),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap_1()
                        .child(div().child(status))
                        .children(
                            elsewhere.map(|path| div().text_xs().text_color(muted).child(path)),
                        )
                        .child(
                            h_flex()
                                .gap_2()
                                .flex_wrap()
                                .children(connect)
                                .children(disconnect)
                                .children(open_folder),
                        ),
                ),
        )
        .children(error.map(|e| {
            div()
                .text_xs()
                .text_color(gpui_kit::red())
                .child(t!("settings.browser_error", message = e).into_owned())
        }))
        .child(
            div()
                .text_xs()
                .text_color(muted)
                .child(t!("settings.browser_note").into_owned()),
        )
        .into_any_element()
}

/// The theme's font sizes at 100%. The theme's font size is also the rem size, so lengths in rems
/// follow the UI size.
const FONT_SIZE: f32 = 16.;
const MONO_FONT_SIZE: f32 = 13.;

/// A length of `px` pixels at 100%, in rems, so it follows the UI size.
pub fn scaled(px: f32) -> Rems {
    rems(px / FONT_SIZE)
}

/// [`scaled`] in pixels, for what takes no rems (dialog widths, scroll offsets).
pub fn scaled_px(px: f32, cx: &App) -> Pixels {
    cx.theme().font_size * (px / FONT_SIZE)
}

/// Applies the theme (light or dark, following the OS for [`ThemeSetting::System`]) and the UI
/// size of `settings`.
pub fn apply_appearance(settings: &Settings, window: &mut Window, cx: &mut App) {
    match settings.theme {
        ThemeSetting::System => Theme::sync_system_appearance(Some(window), cx),
        ThemeSetting::Light => Theme::change(ThemeMode::Light, Some(window), cx),
        ThemeSetting::Dark => Theme::change(ThemeMode::Dark, Some(window), cx),
    }
    // After the theme, which could bring its own sizes.
    let scale = settings.ui_scale_factor();
    Theme::update(cx, |theme| {
        theme.font_size = px(FONT_SIZE * scale);
        theme.mono_font_size = px(MONO_FONT_SIZE * scale);
    });
    window.refresh();
}

/// How the window opens again while the app stays resident.
const RESIDENT_NOTE: &str = if cfg!(windows) {
    "settings.resident_note_windows"
} else if cfg!(target_os = "macos") {
    "settings.resident_note_macos"
} else {
    "settings.resident_note_linux"
};

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(
        COPY_TRANSLATION_KEY,
        CopyTranslation,
        Some(KEY_CONTEXT),
    )]);
}

type SourceSelect = SelectState<SearchableVec<Choice<SourceChoice>>>;
type TargetSelect = SelectState<SearchableVec<Choice<TargetChoice>>>;
type StyleSelect = SelectState<Vec<Choice<StyleChoice>>>;
type UiLanguageSelect = SelectState<Vec<Choice<UiLanguage>>>;
type ThemeSelect = SelectState<Vec<Choice<ThemeSetting>>>;
type ScaleSelect = SelectState<Vec<Choice<u16>>>;
type TokensSelect = SelectState<Vec<Choice<usize>>>;

/// A finished translation, kept to show it again without translating.
struct Cached {
    request: Request,
    translation: String,
    chunks: Vec<ChunkSpan>,
    cuts: Vec<CutMark>,
}

/// A passage whose translation kept looping and was cut: the source sentence and what was kept
/// of its translation, as byte ranges.
#[derive(Debug, Clone)]
struct CutMark {
    source: Range<usize>,
    output: Range<usize>,
}

/// What synchronized scrolling last saw of each pane (indexed by `Side as usize`).
#[derive(Default)]
struct SyncState {
    scroll_y: [Pixels; 2],
    selection: [Range<usize>; 2],
    /// When a pane was last scrolled to follow the other; its own changes are ignored briefly,
    /// so the two do not chase each other.
    followed_at: [Option<Instant>; 2],
}

/// How long a pane's changes are ignored after it was scrolled to follow the other.
const FOLLOW_SETTLE: Duration = Duration::from_millis(150);

/// The chunk of a long text being translated: its byte range in the source, and how many
/// tokens had been generated when it started.
#[derive(Debug, Clone, Copy)]
struct ChunkMark {
    start: usize,
    end: usize,
    tokens_before: usize,
}

/// What the window shows about the source text. Computing it scans the whole text, which is
/// too slow to do on every frame for a long document.
#[derive(Debug, Clone, Copy)]
struct SourceInfo {
    chars: usize,
    looks_japanese: bool,
}

/// One translation request: the text and every option that affects its output.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Request {
    options: TranslationOptions,
    document: DocumentSettings,
    text: String,
}

/// The model to run.
#[derive(Debug, Clone, PartialEq)]
pub enum ModelChoice {
    Catalog(&'static CatalogEntry),
    /// A GGUF file given on the command line.
    Custom(PathBuf),
}

impl ModelChoice {
    fn label(&self) -> String {
        match self {
            Self::Catalog(entry) => entry.to_string(),
            Self::Custom(path) => model_label(path),
        }
    }
}

enum Status {
    NoModel,
    Unloaded,
    Loading(f32),
    /// Measuring device `step` of `count` before a load: on the first start (`first`), or
    /// because the settings asked.
    Measuring {
        first: bool,
        step: usize,
        count: usize,
    },
    Ready,
    Translating {
        target: &'static str,
        /// (current, total) when a long text was split.
        chunk: Option<(usize, usize)>,
    },
    Done {
        /// Generated tokens, including output that was withdrawn and translated again.
        tokens: usize,
        /// From the request to the end of the translation.
        elapsed: Duration,
        tokens_per_second: f64,
        /// Passages whose output kept looping and was cut.
        cut: usize,
    },
    Cached {
        /// Passages of the cached translation that were cut.
        cut: usize,
    },
    Stopped,
    Truncated,
    Error(String),
}

/// The settings' Check now, while its result shows there.
#[derive(Debug, Clone, PartialEq)]
enum UpdateCheck {
    Idle,
    Checking,
    /// No newer release; the newest one's version.
    UpToDate(Version),
    Found(Version),
    Failed(String),
}

/// Installing a newer release from the app.
#[derive(Debug, Clone, PartialEq)]
enum InstallState {
    Idle,
    Downloading {
        version: Version,
        done: u64,
        total: u64,
    },
    /// Unpacked next to the app: a restart swaps it in.
    Ready(Version),
    Failed(String),
}

pub struct TranslatorView {
    source: Entity<TextareaState>,
    output: Entity<TextareaState>,
    source_select: Entity<SourceSelect>,
    target_select: Entity<TargetSelect>,
    style_select: Entity<StyleSelect>,
    ui_language_select: Entity<UiLanguageSelect>,
    theme_select: Entity<ThemeSelect>,
    ui_scale_select: Entity<ScaleSelect>,
    chunk_select: Entity<TokensSelect>,
    history_select: Entity<TokensSelect>,
    source_choice: SourceChoice,
    target_choice: TargetChoice,
    style_choice: StyleChoice,
    auto_translate: bool,
    context_input: Entity<TextareaState>,
    glossary_input: Entity<TextareaState>,
    show_options: bool,
    context: String,
    glossary: Vec<GlossaryEntry>,

    worker: Worker,
    models: Entity<ModelsPanel>,
    backend: Entity<BackendPanel>,
    /// Compute devices, once llama.cpp has started.
    devices: Option<Vec<Device>>,
    /// Device label of the loaded (or loading) model.
    loaded_on: Option<String>,
    /// A model to delete once the worker confirms it released the file.
    pending_delete: Option<&'static CatalogEntry>,
    /// The model to update once the worker has released it (see [`ModelsEvent::ReplaceActive`]).
    pending_replace: Option<&'static CatalogEntry>,
    settings: Settings,
    active_model: Option<ModelChoice>,
    model_ready: bool,
    status: Status,
    /// The job whose output is streaming into the output pane.
    current_job: Option<JobId>,
    /// The request whose result is shown (or being produced) in the output pane.
    shown: Option<Request>,
    translation: String,
    /// Length of `translation` in UTF-16 code units, the unit of text input ranges.
    translation_utf16: usize,
    /// Derived from the source text when it last changed, instead of on every frame.
    source_info: Option<SourceInfo>,
    cache: VecDeque<Cached>,
    /// Chunks of the shown translation, for synchronized scrolling.
    chunks: Vec<ChunkSpan>,
    /// Passages of the shown translation that kept looping and were cut, and the one the status
    /// bar shows next.
    cuts: Vec<CutMark>,
    next_cut: usize,
    /// The alignment of the shown translation, keyed by its length, its chunk count, and whether
    /// it is complete.
    alignment: Option<((usize, usize, bool), Alignment)>,
    /// Incremented when the source text changes; the alignment holds only while it matches
    /// `shown_version`.
    source_version: u64,
    shown_version: u64,
    sync: SyncState,
    /// Tokens received for the current job, and when the first one arrived (for the live rate).
    stream_tokens: usize,
    stream_started: Option<Instant>,
    /// When the current job was submitted.
    job_started: Option<Instant>,
    /// The chunk being translated, for the remaining-time estimate.
    current_chunk: Option<ChunkMark>,

    /// Set by the paste hook so the following change translates without debouncing.
    paste_pending: bool,
    /// A translation was asked for while the model was loading: it runs once the model is
    /// ready, also with Auto off (Auto on translates then anyway).
    translate_on_load: bool,
    /// Loads sent to the worker whose result has not arrived. Each load ends in exactly one
    /// `Loaded` or `LoadFailed`; only the last one's events describe the model in use.
    pending_loads: usize,
    /// Set when llama.cpp could not start; nothing can load after that.
    runtime_error: Option<String>,
    /// A device measurement is running: `Some(true)` for the first start's. Loads wait for it.
    measuring: Option<bool>,
    /// The settings asked to measure the devices with the next load.
    measure_requested: bool,
    /// The shown translation was stopped or failed part-way, so it neither satisfies a repeated
    /// request nor goes into the cache.
    shown_partial: bool,
    /// Browser host registration as last checked, and the error of the last change, if any.
    browser: (browser::Registration, Option<String>),
    /// A release newer than this build, shown in the status bar.
    newer_release: Option<Release>,
    update_check: UpdateCheck,
    _update_task: Task<()>,
    /// This copy's package, if it came from one: it can then install a newer release itself.
    installation: Option<Installation>,
    install: InstallState,
    /// The start-up clean-up of the staging folder, which an install waits for.
    clean_up: Option<Task<()>>,
    _install_task: Task<()>,
    copied: bool,
    debounce: Task<()>,
    copied_reset: Task<()>,
    _subscriptions: Vec<Subscription>,
    _events: Task<()>,
}

impl TranslatorView {
    /// `custom_model` (from the command line) takes precedence over the saved selection.
    pub fn new(
        custom_model: Option<PathBuf>,
        settings: Settings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        // Development aid (debug builds only): start with the contents of a file as the source.
        let initial_source = std::env::var_os("PLAMO_DEBUG_SOURCE")
            .filter(|_| cfg!(debug_assertions))
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default();
        let source = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(t!("source.placeholder").into_owned())
                .default_value(initial_source)
        });
        let output = cx.new(|cx| TextareaState::new(window, cx));
        let context_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(t!("options.context_placeholder").into_owned())
        });
        let glossary_text = settings.glossary.clone();
        let glossary_text_for_parse = glossary_text.clone();
        let glossary_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(t!("options.glossary_placeholder").into_owned())
                .default_value(glossary_text)
        });

        let source_choice = SourceChoice::Detect;
        let target_choice = TargetChoice::JapaneseEnglish;
        let style_choice = StyleChoice::Default;
        let source_select = {
            let choices = lang::source_choices();
            let selected = lang::position(&choices, &source_choice).map(IndexPath::new);
            cx.new(|cx| {
                SelectState::new(SearchableVec::new(choices), selected, window, cx).searchable(true)
            })
        };
        let target_select = {
            let choices = lang::target_choices();
            let selected = lang::position(&choices, &target_choice).map(IndexPath::new);
            cx.new(|cx| {
                SelectState::new(SearchableVec::new(choices), selected, window, cx).searchable(true)
            })
        };
        let style_select = {
            let choices = lang::style_choices();
            let selected = lang::position(&choices, &style_choice).map(IndexPath::new);
            cx.new(|cx| SelectState::new(choices, selected, window, cx))
        };
        let ui_language_select = {
            let choices = lang::ui_language_choices();
            let selected = lang::position(&choices, &settings.ui_language).map(IndexPath::new);
            cx.new(|cx| SelectState::new(choices, selected, window, cx))
        };
        let theme_select = {
            let choices = lang::theme_choices();
            let selected = lang::position(&choices, &settings.theme).map(IndexPath::new);
            cx.new(|cx| SelectState::new(choices, selected, window, cx))
        };
        let ui_scale_select = {
            let choices = lang::ui_scale_choices(settings.ui_scale);
            let selected = lang::position(&choices, &settings.ui_scale).map(IndexPath::new);
            cx.new(|cx| SelectState::new(choices, selected, window, cx))
        };
        let (chunk_choices, history_choices) = token_choices(&settings.document);
        let chunk_select = {
            let selected = lang::position(&chunk_choices, &settings.document.chunk_tokens);
            cx.new(|cx| SelectState::new(chunk_choices, selected.map(IndexPath::new), window, cx))
        };
        let history_select = {
            let selected = lang::position(&history_choices, &settings.document.history_tokens);
            cx.new(|cx| SelectState::new(history_choices, selected.map(IndexPath::new), window, cx))
        };

        let backend = cx.new(|cx| BackendPanel::new(settings.backend.clone(), window, cx));
        let store = ModelStore::new(settings.models_dir());
        let models = cx.new(|cx| {
            ModelsPanel::new(
                store.clone(),
                catalog::default_entry(),
                settings.license_accepted,
                settings::catalog_cache_path(),
                cx,
            )
        });

        let subscriptions = vec![
            cx.subscribe_in(&source, window, Self::on_source_event),
            // Scrolling and caret moves notify the pane; the other pane may follow.
            cx.observe_in(&source, window, |this, _, window, cx| {
                this.on_pane_changed(Side::Source, window, cx)
            }),
            cx.observe_in(&output, window, |this, _, window, cx| {
                this.on_pane_changed(Side::Output, window, cx)
            }),
            cx.subscribe_in(&context_input, window, |this, input, event, window, cx| {
                if let InputEvent::Change = event {
                    this.context = input.read(cx).value().to_string();
                    this.options_edited(window, cx);
                }
            }),
            cx.subscribe_in(&glossary_input, window, |this, input, event, window, cx| {
                if let InputEvent::Change = event {
                    let text = input.read(cx).value().to_string();
                    this.glossary = glossary::parse(&text);
                    this.settings.glossary = text;
                    this.settings.save();
                    this.options_edited(window, cx);
                }
            }),
            cx.subscribe_in(&models, window, Self::on_models_event),
            cx.subscribe_in(&backend, window, Self::on_backend_event),
            cx.subscribe_in(&source_select, window, |this, _, event, window, cx| {
                if let SelectEvent::Confirm(Some(choice)) = event {
                    this.source_choice = *choice;
                    this.options_changed(window, cx);
                }
            }),
            cx.subscribe_in(&target_select, window, |this, _, event, window, cx| {
                if let SelectEvent::Confirm(Some(choice)) = event {
                    this.target_choice = *choice;
                    this.options_changed(window, cx);
                }
            }),
            cx.subscribe_in(&ui_language_select, window, |this, _, event, window, cx| {
                if let SelectEvent::Confirm(Some(language)) = event {
                    this.set_ui_language(*language, window, cx);
                }
            }),
            cx.subscribe_in(&theme_select, window, |this, _, event, window, cx| {
                if let SelectEvent::Confirm(Some(theme)) = event {
                    this.set_theme(*theme, window, cx);
                }
            }),
            cx.subscribe_in(&ui_scale_select, window, |this, _, event, window, cx| {
                if let SelectEvent::Confirm(Some(scale)) = event {
                    this.set_ui_scale(*scale, window, cx);
                }
            }),
            cx.subscribe_in(&chunk_select, window, |this, _, event, window, cx| {
                if let SelectEvent::Confirm(Some(tokens)) = event {
                    this.set_document(
                        DocumentSettings {
                            chunk_tokens: *tokens,
                            ..this.settings.document
                        },
                        window,
                        cx,
                    );
                }
            }),
            cx.subscribe_in(&history_select, window, |this, _, event, window, cx| {
                if let SelectEvent::Confirm(Some(tokens)) = event {
                    this.set_document(
                        DocumentSettings {
                            history_tokens: *tokens,
                            ..this.settings.document
                        },
                        window,
                        cx,
                    );
                }
            }),
            cx.observe_window_appearance(window, |this, window, cx| {
                if this.settings.theme == ThemeSetting::System {
                    apply_appearance(&this.settings, window, cx);
                }
            }),
            cx.subscribe_in(&style_select, window, |this, _, event, window, cx| {
                if let SelectEvent::Confirm(Some(choice)) = event {
                    this.style_choice = *choice;
                    this.options_changed(window, cx);
                }
            }),
        ];

        let (tx, rx) = async_channel::unbounded();
        let worker = Worker::spawn(RuntimeOptions::default(), move |event| {
            let _ = tx.send_blocking(event);
        });
        let events = cx.spawn_in(window, async move |this, cx| {
            while let Ok(first) = rx.recv().await {
                // Take everything that has arrived, so the UI handles a burst of tokens at once.
                let mut batch = vec![first];
                while let Ok(event) = rx.try_recv() {
                    batch.push(event);
                }
                let streaming = batch.iter().any(|e| matches!(e, Event::Token { .. }));
                if this
                    .update_in(cx, |this, window, cx| {
                        this.on_worker_events(batch, window, cx)
                    })
                    .is_err()
                {
                    break;
                }
                if streaming {
                    // Let tokens accumulate; the next batch picks them up.
                    cx.background_executor().timer(STREAM_FRAME).await;
                }
            }
        });

        source.update(cx, |state, cx| state.focus(window, cx));

        let initial = match custom_model {
            Some(path) => Some(ModelChoice::Custom(path)),
            None => model_to_load(&settings, &store).map(ModelChoice::Catalog),
        };

        let mut this = Self {
            source,
            output,
            source_select,
            target_select,
            style_select,
            ui_language_select,
            theme_select,
            ui_scale_select,
            chunk_select,
            history_select,
            source_choice,
            target_choice,
            style_choice,
            auto_translate: true,
            context_input,
            glossary_input,
            show_options: false,
            context: String::new(),
            glossary: glossary::parse(&glossary_text_for_parse),
            worker,
            models,
            backend,
            devices: None,
            loaded_on: None,
            pending_delete: None,
            pending_replace: None,
            settings,
            active_model: None,
            model_ready: false,
            status: Status::NoModel,
            current_job: None,
            shown: None,
            translation: String::new(),
            translation_utf16: 0,
            source_info: None,
            cache: VecDeque::new(),
            chunks: Vec::new(),
            cuts: Vec::new(),
            next_cut: 0,
            alignment: None,
            source_version: 0,
            shown_version: 0,
            sync: SyncState::default(),
            stream_tokens: 0,
            stream_started: None,
            job_started: None,
            current_chunk: None,
            paste_pending: false,
            translate_on_load: false,
            pending_loads: 0,
            runtime_error: None,
            measuring: None,
            measure_requested: false,
            shown_partial: false,
            browser: (browser::Registration::NotRegistered, None),
            newer_release: None,
            update_check: UpdateCheck::Idle,
            _update_task: Task::ready(()),
            installation: Installation::current().ok(),
            install: InstallState::Idle,
            clean_up: None,
            _install_task: Task::ready(()),
            copied: false,
            debounce: Task::ready(()),
            copied_reset: Task::ready(()),
            _subscriptions: subscriptions,
            _events: events,
        };
        this.link_selection_focus(cx);
        this.clean_up_update(cx);
        if this.settings.check_updates {
            this.check_for_update(false, cx);
        }
        // Development aid (debug builds only): open the settings at start, for screenshots.
        if cfg!(debug_assertions) && std::env::var_os("PLAMO_DEBUG_OPEN_SETTINGS").is_some() {
            cx.defer_in(window, |this, window, cx| this.open_settings(window, cx));
        }
        let needs_model = initial.is_none();
        if let Some(choice) = initial {
            this.load_model(choice, cx);
        }
        if !this.settings.license_accepted {
            cx.defer_in(window, move |this, window, cx| {
                this.open_license(needs_model, window, cx)
            });
        } else if needs_model {
            cx.defer_in(window, |this, window, cx| this.open_models(window, cx));
        }
        this
    }

    /// Shows the PLaMo Community License. Accepting it enables downloads, and on the first run
    /// (`then_open_models`) continues to the Models dialog when no model is available yet.
    fn open_license(
        &mut self,
        then_open_models: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let view = cx.entity().downgrade();
        let url = crate::models::license_url();
        window.open_dialog(cx, move |dialog, _, cx| {
            let accept_view = view.clone();
            dialog
                .title(t!("license.title").into_owned())
                .w(scaled_px(560., cx))
                .overlay_closable(false)
                .close_button(false)
                .child(
                    v_flex()
                        .gap_3()
                        .text_sm()
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Built with PLaMo"),
                        )
                        .child(t!("license.body").into_owned())
                        .child(
                            v_flex()
                                .gap_1()
                                .pl_2()
                                .child(t!("license.point_personal").into_owned())
                                .child(t!("license.point_commercial").into_owned())
                                .child(t!("license.point_output").into_owned()),
                        )
                        .child(
                            Button::new("read-license")
                                .link()
                                .label(t!("models.license_link").into_owned())
                                .on_click(move |_, _, cx| cx.open_url(url)),
                        ),
                )
                .footer(
                    h_flex()
                        .w_full()
                        .justify_end()
                        .gap_2()
                        .child(
                            Button::new("license-later")
                                .label(t!("license.later").into_owned())
                                .on_click(|_, window, cx| window.close_dialog(cx)),
                        )
                        .child(
                            Button::new("license-accept")
                                .primary()
                                .label(t!("license.accept").into_owned())
                                .on_click(move |_, window, cx| {
                                    window.close_dialog(cx);
                                    let _ = accept_view.update(cx, |this, cx| {
                                        this.accept_license(then_open_models, window, cx)
                                    });
                                }),
                        ),
                )
        });
    }

    fn accept_license(
        &mut self,
        then_open_models: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.settings.license_accepted = true;
        self.settings.save();
        self.models
            .update(cx, |models, cx| models.set_license_accepted(true, cx));
        if then_open_models && self.active_model.is_none() {
            self.open_models(window, cx);
        }
    }

    /// Makes `choice` the active model and loads it.
    fn load_model(&mut self, choice: ModelChoice, cx: &mut Context<Self>) {
        let entry = match &choice {
            ModelChoice::Catalog(entry) => Some(*entry),
            ModelChoice::Custom(_) => None,
        };
        self.models
            .update(cx, |models, cx| models.set_active(entry, cx));
        if let Some(entry) = entry {
            self.settings.model = Some(entry.id().to_owned());
            self.settings.save();
        }
        self.active_model = Some(choice);
        self.start_load(cx);
    }

    /// Releases the active model. The saved selection stays, so the next start loads it again.
    fn unload_model(&mut self, cx: &mut Context<Self>) {
        crate::app_log!("unloading the active model");
        self.worker.unload();
        self.active_model = None;
        self.model_ready = false;
        self.translate_on_load = false;
        self.current_job = None;
        self.shown = None;
        self.loaded_on = None;
        self.cache.clear();
        self.status = Status::Unloaded;
        self.models
            .update(cx, |models, cx| models.set_active(None, cx));
        self.backend
            .update(cx, |backend, cx| backend.set_model_bytes(None, cx));
        cx.notify();
    }

    /// (Re)loads the active model with the current backend settings. Before llama.cpp has
    /// reported its devices this only marks the model as loading; the devices event retries.
    fn start_load(&mut self, cx: &mut Context<Self>) {
        let Some(choice) = self.active_model.clone() else {
            return;
        };
        self.current_job = None;
        self.shown = None;
        self.model_ready = false;
        // Cached results belong to the previous model or settings.
        self.cache.clear();
        self.status = Status::Loading(0.0);
        cx.notify();

        let path = match &choice {
            ModelChoice::Catalog(entry) => self.models.read(cx).store().path(entry),
            ModelChoice::Custom(path) => path.clone(),
        };
        if !path.is_file() {
            self.worker.unload();
            self.loaded_on = None;
            self.status = Status::Error(
                t!("status.model_missing", path = path.display().to_string()).into_owned(),
            );
            return;
        }
        let bytes = std::fs::metadata(&path).ok().map(|m| m.len());
        self.backend
            .update(cx, |backend, cx| backend.set_model_bytes(bytes, cx));
        if let Some(error) = &self.runtime_error {
            self.status = Status::Error(error.clone());
            return;
        }
        let Some(devices) = &self.devices else {
            return;
        };
        // The measurement's result decides the device; it loads the model afterwards.
        if let Some(first) = self.measuring {
            self.status = Status::Measuring {
                first,
                step: 0,
                count: 0,
            };
            return;
        }
        let measure = if self.measure_requested {
            Some((false, backend::candidates(devices)))
        } else {
            backend::first_measurement(&self.settings.backend, devices).map(|c| (true, c))
        };
        if let Some((first, candidates)) = measure {
            crate::app_log!(
                "measuring {} device(s) with {}",
                candidates.len(),
                path.display()
            );
            self.measure_requested = false;
            self.measuring = Some(first);
            self.status = Status::Measuring {
                first,
                step: 0,
                count: candidates.len(),
            };
            self.backend
                .update(cx, |backend, cx| backend.set_measuring(true, cx));
            self.worker.measure(MeasureRequest {
                path,
                devices: candidates,
            });
            return;
        }
        let device = backend::resolve(
            &self.settings.backend.device,
            self.settings.backend.measured.as_ref(),
            devices,
        );
        self.loaded_on = Some(backend::device_label(device));
        crate::app_log!(
            "loading {} on {}",
            path.display(),
            backend::device_label(device)
        );
        self.pending_loads += 1;
        self.worker.load(LoadRequest {
            path,
            model: backend::model_options(device),
            session: backend::session_options(device),
        });
    }

    /// Updates the recommended model for the memory of the selected device.
    fn update_recommendation(&mut self, cx: &mut Context<Self>) {
        let Some(devices) = &self.devices else {
            return;
        };
        let device = backend::resolve(
            &self.settings.backend.device,
            self.settings.backend.measured.as_ref(),
            devices,
        );
        let recommended = catalog::recommend(backend::available_memory(device, devices));
        self.models
            .update(cx, |models, cx| models.set_recommended(recommended, cx));
    }

    fn on_backend_event(
        &mut self,
        _: &Entity<BackendPanel>,
        event: &BackendEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            BackendEvent::Changed(device) => {
                self.settings.backend.device = device.clone();
                self.settings.save();
                self.update_recommendation(cx);
            }
            BackendEvent::Measure => self.measure_requested = true,
        }
        self.start_load(cx);
    }

    fn on_models_event(
        &mut self,
        _: &Entity<ModelsPanel>,
        event: &ModelsEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ModelsEvent::Use(entry) => {
                self.load_model(ModelChoice::Catalog(entry), cx);
                if window.has_active_dialog(cx) {
                    window.close_dialog(cx);
                }
            }
            ModelsEvent::Unload => self.unload_model(cx),
            ModelsEvent::DeleteActive(entry) => {
                // The file stays open until the worker drops the model (and cannot be deleted
                // on Windows before that), so delete it when `Event::Unloaded` arrives.
                self.pending_delete = Some(entry);
                self.unload_model(cx);
            }
            ModelsEvent::ReplaceActive(entry) => {
                // As for deleting: Windows cannot replace the file while it is loaded.
                self.pending_replace = Some(entry);
                self.unload_model(cx);
            }
            ModelsEvent::ChangeFolder(dir) => self.change_models_folder(dir.clone(), cx),
            ModelsEvent::ReviewLicense => self.open_license(false, window, cx),
            ModelsEvent::CatalogUpdated => self.update_recommendation(cx),
        }
    }

    /// Keeps models in `dir` (the default folder for `None`). The files stay where they are. The
    /// model loaded from the old folder gives way to what the new one has, chosen as at start.
    fn change_models_folder(&mut self, dir: Option<PathBuf>, cx: &mut Context<Self>) {
        // The default folder, picked, stays the default (wherever the data directory moves).
        let dir = dir.filter(|dir| *dir != settings::default_models_dir());
        if self.settings.models_dir == dir {
            return;
        }
        self.settings.models_dir = dir;
        self.settings.save();
        let store = ModelStore::new(self.settings.models_dir());
        crate::app_log!("models folder set to {}", store.dir().display());
        self.models
            .update(cx, |models, cx| models.set_store(store.clone(), cx));
        if matches!(self.active_model, Some(ModelChoice::Custom(_))) {
            return;
        }
        match model_to_load(&self.settings, &store) {
            Some(entry) => self.load_model(ModelChoice::Catalog(entry), cx),
            None if self.active_model.is_some() => self.unload_model(cx),
            None => {}
        }
    }

    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.browser = (browser::registration(), None);
        // A result shows only after Check now, not from the check at start.
        if self.update_check != UpdateCheck::Checking {
            self.update_check = UpdateCheck::Idle;
        }
        let language = self.ui_language_select.clone();
        let theme = self.theme_select.clone();
        let ui_scale = self.ui_scale_select.clone();
        let chunk = self.chunk_select.clone();
        let history = self.history_select.clone();
        let view = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, cx| {
            // Read on every render: the theme can change from this dialog.
            let muted = cx.theme().muted_foreground;
            let (sync_scroll, check_updates, update_check, (registration, browser_error)) = view
                .upgrade()
                .map(|view| {
                    let this = view.read(cx);
                    (
                        this.settings.sync_scroll,
                        this.settings.check_updates,
                        this.update_check.clone(),
                        this.browser.clone(),
                    )
                })
                .unwrap_or((
                    false,
                    false,
                    UpdateCheck::Idle,
                    (browser::Registration::NotRegistered, None),
                ));
            let (double_copy, resident) = view
                .upgrade()
                .map(|view| {
                    let settings = &view.read(cx).settings;
                    (settings.double_copy, settings.resident)
                })
                .unwrap_or_default();
            let watch_error = crate::shell::watch_error(cx);
            let toggle_view = view.clone();
            let double_copy_view = view.clone();
            let resident_view = view.clone();
            let updates_view = view.clone();
            let check_view = view.clone();
            let browser_view = view.clone();
            let row = |label: &str, select: AnyElement| {
                h_flex()
                    .gap_3()
                    .text_sm()
                    .child(div().w(scaled(140.)).child(t!(label).into_owned()))
                    .child(select)
            };
            let select = |state: &Entity<_>| Select::new(state).w(scaled(260.)).into_any_element();
            dialog
                .title(t!("settings.title").into_owned())
                .w(scaled_px(600., cx))
                .child(
                    v_flex()
                        .gap_3()
                        .child(row(
                            "settings.language",
                            Select::new(&language).w(scaled(260.)).into_any_element(),
                        ))
                        .child(row(
                            "settings.theme",
                            Select::new(&theme).w(scaled(260.)).into_any_element(),
                        ))
                        .child(row(
                            "settings.ui_scale",
                            Select::new(&ui_scale).w(scaled(260.)).into_any_element(),
                        ))
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(t!("settings.ui_scale_note").into_owned()),
                        )
                        .child(row("settings.chunk", select(&chunk)))
                        .child(row("settings.history", select(&history)))
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(t!("settings.document_note").into_owned()),
                        )
                        .child(
                            Switch::new("sync-scroll")
                                .checked(sync_scroll)
                                .label(t!("settings.sync_scroll").into_owned())
                                .on_click(move |checked: &bool, window, cx| {
                                    let _ = toggle_view
                                        .update(cx, |this, cx| this.set_sync_scroll(*checked, cx));
                                    window.refresh();
                                }),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(t!("settings.sync_scroll_note").into_owned()),
                        )
                        .child(
                            Switch::new("double-copy")
                                .checked(double_copy)
                                .label(t!("settings.double_copy").into_owned())
                                .on_click(move |checked: &bool, window, cx| {
                                    let _ = double_copy_view
                                        .update(cx, |this, cx| this.set_double_copy(*checked, cx));
                                    window.refresh();
                                }),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(t!("settings.double_copy_note").into_owned()),
                        )
                        .children(watch_error.map(|message| {
                            div().text_xs().text_color(cx.theme().danger).child(message)
                        }))
                        .child(
                            Switch::new("resident")
                                .checked(resident)
                                .label(t!("settings.resident").into_owned())
                                .on_click(move |checked: &bool, window, cx| {
                                    let _ = resident_view
                                        .update(cx, |this, cx| this.set_resident(*checked, cx));
                                    window.refresh();
                                }),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(t!(RESIDENT_NOTE).into_owned()),
                        )
                        .child(
                            Switch::new("check-updates")
                                .checked(check_updates)
                                .label(t!("settings.check_updates").into_owned())
                                .on_click(move |checked: &bool, window, cx| {
                                    let _ = updates_view.update(cx, |this, cx| {
                                        this.set_check_updates(*checked, cx)
                                    });
                                    window.refresh();
                                }),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(t!("settings.check_updates_note").into_owned()),
                        )
                        .child(update_check_row(update_check, muted, check_view))
                        .child(browser_settings(
                            registration,
                            browser_error,
                            muted,
                            browser_view,
                        )),
                )
        });
    }

    /// Registers the browser host, or removes the registration.
    fn set_browser_registration(&mut self, register: bool) {
        let result = if register {
            browser::register().map(|browsers| {
                crate::app_log!("browser host registered with {}", browsers.join(", "));
            })
        } else {
            browser::unregister().map(|()| crate::app_log!("browser host unregistered"))
        };
        let error = result.err().map(|e| {
            crate::app_log!("browser host registration failed: {e}");
            e.to_string()
        });
        self.browser = (browser::registration(), error);
    }

    fn set_document(
        &mut self,
        document: DocumentSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.document == document {
            return;
        }
        self.settings.document = document;
        self.settings.save();
        crate::app_log!(
            "long texts: chunks of {} tokens, history of {} tokens",
            document.chunk_tokens,
            document.history_tokens
        );
        self.options_changed(window, cx);
    }

    fn set_theme(&mut self, theme: ThemeSetting, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings.theme == theme {
            return;
        }
        self.settings.theme = theme;
        self.settings.save();
        crate::app_log!("theme set to {theme:?}");
        apply_appearance(&self.settings, window, cx);
    }

    fn set_ui_scale(&mut self, scale: u16, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings.ui_scale == scale {
            return;
        }
        self.settings.ui_scale = scale;
        self.settings.save();
        crate::app_log!("UI size set to {scale}%");
        apply_appearance(&self.settings, window, cx);
    }

    fn set_ui_language(
        &mut self,
        language: UiLanguage,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.ui_language == language {
            return;
        }
        self.settings.ui_language = language;
        self.settings.save();
        let locale = language.locale();
        crate::app_log!("UI language set to {language:?} ({locale})");
        rust_i18n::set_locale(locale);
        self.refresh_locale(window, cx);
        crate::shell::refresh_tray(cx);
    }

    /// Rebuilds the strings that were baked into child components when they were created.
    /// Everything else is translated at render time.
    fn refresh_locale(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (source, target, style) = (self.source_choice, self.target_choice, self.style_choice);
        self.source_select.update(cx, |state, cx| {
            state.set_items(SearchableVec::new(lang::source_choices()), window, cx);
            state.set_selected_value(&source, window, cx);
        });
        self.target_select.update(cx, |state, cx| {
            state.set_items(SearchableVec::new(lang::target_choices()), window, cx);
            state.set_selected_value(&target, window, cx);
        });
        self.style_select.update(cx, |state, cx| {
            state.set_items(lang::style_choices(), window, cx);
            state.set_selected_value(&style, window, cx);
        });
        let language = self.settings.ui_language;
        self.ui_language_select.update(cx, |state, cx| {
            state.set_items(lang::ui_language_choices(), window, cx);
            state.set_selected_value(&language, window, cx);
        });
        let theme = self.settings.theme;
        self.theme_select.update(cx, |state, cx| {
            state.set_items(lang::theme_choices(), window, cx);
            state.set_selected_value(&theme, window, cx);
        });
        let ui_scale = self.settings.ui_scale;
        self.ui_scale_select.update(cx, |state, cx| {
            state.set_items(lang::ui_scale_choices(ui_scale), window, cx);
            state.set_selected_value(&ui_scale, window, cx);
        });
        let document = self.settings.document;
        let (chunk_choices, history_choices) = token_choices(&document);
        self.chunk_select.update(cx, |state, cx| {
            state.set_items(chunk_choices, window, cx);
            state.set_selected_value(&document.chunk_tokens, window, cx);
        });
        self.history_select.update(cx, |state, cx| {
            state.set_items(history_choices, window, cx);
            state.set_selected_value(&document.history_tokens, window, cx);
        });
        for (input, key) in [
            (&self.source, "source.placeholder"),
            (&self.context_input, "options.context_placeholder"),
            (&self.glossary_input, "options.glossary_placeholder"),
        ] {
            let text = t!(key).into_owned();
            input.update(cx, |state, cx| state.set_placeholder(text, window, cx));
        }
        self.backend
            .update(cx, |backend, cx| backend.refresh_locale(window, cx));
        self.models.update(cx, |_, cx| cx.notify());
        cx.notify();
    }

    fn open_models(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let panel = self.models.clone();
        let backend = self.backend.clone();
        window.open_dialog(cx, move |dialog, _, cx| {
            dialog
                .title(t!("models.title").into_owned())
                .w(scaled_px(900., cx))
                .child(v_flex().gap_4().child(backend.clone()).child(panel.clone()))
        });
    }

    fn source_text(&self, cx: &App) -> String {
        self.source.read(cx).value().to_string()
    }

    fn on_source_event(
        &mut self,
        _: &Entity<TextareaState>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Change => {
                self.source_info = None;
                self.source_version += 1;
                let pasted = std::mem::take(&mut self.paste_pending);
                if self.auto_translate {
                    if pasted {
                        self.translate_now(window, cx);
                    } else {
                        self.schedule_translation(window, cx);
                    }
                }
                // The character count and the style selector depend on the text.
                cx.notify();
            }
            InputEvent::PressEnter {
                secondary: true, ..
            } => self.translate_now(window, cx),
            _ => {}
        }
    }

    fn options_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.auto_translate {
            self.translate_now(window, cx);
        }
        cx.notify();
    }

    /// Context or glossary text changed: re-translate after a pause, like typing in the source.
    fn options_edited(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.auto_translate {
            self.schedule_translation(window, cx);
        }
        cx.notify();
    }

    fn schedule_translation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.debounce = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(DEBOUNCE).await;
            let _ = this.update_in(cx, |this, window, cx| this.translate_now(window, cx));
        });
    }

    fn build_request(&self, text: String, source_is_japanese: bool) -> Request {
        let target = self.target_choice.resolve_for(source_is_japanese);
        let mut options = TranslationOptions::new(LangCode::new(target).expect("built-in code"));
        options.source = self
            .source_choice
            .code()
            .map(|c| LangCode::new(c).expect("built-in code"));
        if options.target.is_japanese() {
            options.form = self.style_choice.form();
        }
        options.context = self.context.clone();
        options.glossary = self.glossary.clone();
        Request {
            options,
            document: self.settings.document,
            text,
        }
    }

    fn translate_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.debounce = Task::ready(());
        if !self.model_ready {
            self.translate_on_load = self.active_model.is_some();
            return;
        }
        let text = self.source_text(cx);
        if text.trim().is_empty() {
            self.worker.cancel();
            self.current_job = None;
            self.shown = None;
            self.set_translation(String::new(), window, cx);
            self.status = Status::Ready;
            cx.notify();
            return;
        }

        let source_is_japanese = self.source_info(cx).looks_japanese;
        let request = self.build_request(text, source_is_japanese);
        if self.shown.as_ref() == Some(&request) && !self.shown_partial {
            return;
        }
        if let Some(hit) = self.cache.iter().find(|c| c.request == request) {
            let (hit, chunks, cuts) = (
                hit.translation.clone(),
                hit.chunks.clone(),
                hit.cuts.clone(),
            );
            self.worker.cancel();
            self.current_job = None;
            self.shown = Some(request);
            self.shown_version = self.source_version;
            self.set_translation(hit, window, cx);
            self.chunks = chunks;
            self.status = Status::Cached { cut: cuts.len() };
            self.cuts = cuts;
            cx.notify();
            return;
        }

        let target = self.target_choice.resolve_for(source_is_japanese);
        self.set_translation(String::new(), window, cx);
        // The marker is in the UI language, so it is chosen now rather than kept in the request
        // (where it would make a cached result miss after a language change).
        let document = request
            .document
            .options(appdata::cut_marker(&rust_i18n::locale()).to_owned());
        self.current_job = Some(self.worker.translate(
            request.options.clone(),
            document,
            request.text.clone(),
        ));
        self.stream_tokens = 0;
        self.stream_started = None;
        self.job_started = Some(Instant::now());
        self.current_chunk = None;
        self.shown = Some(request);
        self.shown_version = self.source_version;
        self.status = Status::Translating {
            target,
            chunk: None,
        };
        cx.notify();
    }

    /// Replaces the output and scrolls it back to the top.
    fn set_translation(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.chunks.clear();
        self.alignment = None;
        self.shown_partial = false;
        self.cuts.clear();
        self.next_cut = 0;
        self.translation_utf16 = text.encode_utf16().count();
        self.translation = text;
        let text = SharedString::from(self.translation.clone());
        self.output
            .update(cx, |state, cx| state.set_value(text, window, cx));
    }

    /// Shows newly streamed text, keeping the reader's scroll position and selection.
    fn append_translation(&mut self, piece: &str, window: &mut Window, cx: &mut Context<Self>) {
        let end = self.translation_utf16;
        self.translation.push_str(piece);
        self.translation_utf16 += piece.encode_utf16().count();
        self.edit_output(end..end, piece, window, cx);
    }

    /// Withdraws streamed text after `len` bytes: output that ran away is being retried.
    fn rewind_translation(&mut self, len: usize, window: &mut Window, cx: &mut Context<Self>) {
        if len >= self.translation.len() || !self.translation.is_char_boundary(len) {
            return;
        }
        let removed = self.translation[len..].encode_utf16().count();
        let end = self.translation_utf16;
        self.translation.truncate(len);
        self.translation_utf16 = end - removed;
        self.edit_output(end - removed..end, "", window, cx);
    }

    /// Replaces `range_utf16` of the output pane with `text`.
    ///
    /// Only the changed range is edited. Setting the whole value instead lays out the entire
    /// translation again, which takes longer the longer it grows and eventually stalls the UI.
    fn edit_output(
        &mut self,
        range_utf16: Range<usize>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.output.update(cx, |state, cx| {
            let offset = state.scroll_offset();
            let selected = state.selected_range();
            let reversed = state.is_selection_reversed();
            // The pane is read-only for the user; programmatic edits go through the input
            // handler, which honours that flag.
            state.set_readonly(false, cx);
            state.replace_text_in_range(Some(range_utf16), text, window, cx);
            state.set_readonly(true, cx);
            // An edit moves the caret to its end; put the reader's selection back.
            let len = state.text().len();
            let selected = selected.start.min(len)..selected.end.min(len);
            state.set_selected_range_with_direction(selected, reversed, cx);
            state.set_scroll_offset(offset, cx);
        });
    }

    /// The source text's character count and language, computed once per change.
    fn source_info(&mut self, cx: &App) -> SourceInfo {
        *self.source_info.get_or_insert_with(|| {
            let text = self.source.read(cx).value();
            SourceInfo {
                chars: text.chars().count(),
                looks_japanese: lang::looks_japanese(&text),
            }
        })
    }

    /// Stops the running translation, keeping what has been translated so far.
    fn stop_translation(&mut self, cx: &mut Context<Self>) {
        if self.current_job.take().is_some() {
            self.worker.cancel();
            // The partial result must not satisfy a later identical request.
            self.shown_partial = true;
            self.status = Status::Stopped;
            cx.notify();
        }
    }

    /// Handles a batch of worker events, appending consecutive tokens to the output in one go.
    fn on_worker_events(
        &mut self,
        events: Vec<Event>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut pending = String::new();
        for event in events {
            match event {
                Event::Token { job, text } => {
                    if self.current_job == Some(job) {
                        pending.push_str(&text);
                        self.stream_tokens += 1;
                        self.stream_started.get_or_insert_with(Instant::now);
                    }
                }
                other => {
                    // Later events (Finished in particular) must see the text before them.
                    if !pending.is_empty() {
                        self.append_translation(&std::mem::take(&mut pending), window, cx);
                    }
                    self.on_worker_event(other, window, cx);
                }
            }
        }
        if !pending.is_empty() {
            self.append_translation(&pending, window, cx);
            cx.notify();
        }
    }

    fn on_worker_event(&mut self, event: Event, window: &mut Window, cx: &mut Context<Self>) {
        let is_current = |job| self.current_job == Some(job);
        match event {
            Event::Devices(devices) => {
                // Logged so reports of an unused GPU show whether it was detected at all.
                for d in &devices {
                    crate::app_log!(
                        "device {}: {} ({}, {:?}) {} — {} MiB free of {}",
                        d.index,
                        d.name,
                        d.backend,
                        d.kind,
                        d.description,
                        d.memory_free >> 20,
                        d.memory_total >> 20
                    );
                }
                self.backend.update(cx, |backend, cx| {
                    backend.set_devices(devices.clone(), window, cx)
                });
                self.devices = Some(devices);
                self.update_recommendation(cx);
                if !self.model_ready && self.active_model.is_some() {
                    self.start_load(cx);
                }
            }
            // Progress of a load that a newer one already replaces, or of one unloaded since,
            // says nothing.
            Event::LoadProgress(p) if self.pending_loads <= 1 && self.active_model.is_some() => {
                self.status = Status::Loading(p)
            }
            Event::LoadProgress(_) => return,
            Event::Unloaded => {
                crate::app_log!("model released by the worker");
                if let Some(entry) = self.pending_replace.take() {
                    // Loaded again whether or not the newer file is in place: the older one
                    // stays if it is not.
                    self.models
                        .update(cx, |models, cx| models.replace(entry, cx));
                    self.load_model(ModelChoice::Catalog(entry), cx);
                }
                if let Some(entry) = self.pending_delete.take() {
                    let deleted = self.models.update(cx, |models, cx| {
                        models.delete(entry, "the active model, after unloading", cx)
                    });
                    // A file that could not be deleted (the browser host may still hold it on
                    // Windows) stays the selection; its row shows the error.
                    if deleted && self.settings.model.as_deref() == Some(entry.id()) {
                        self.settings.model = None;
                        self.settings.save();
                    }
                }
            }
            Event::Measuring { index, count } => {
                if let Some(first) = self.measuring {
                    self.status = Status::Measuring {
                        first,
                        step: index + 1,
                        count,
                    };
                }
            }
            Event::Measured(results) => {
                let requested = self.measuring.take() == Some(false);
                self.backend
                    .update(cx, |backend, cx| backend.set_measuring(false, cx));
                let Some(devices) = &self.devices else {
                    return;
                };
                let choice = backend::choose(&results, devices);
                for (result, measured) in results.iter().zip(&choice.results) {
                    match &result.result {
                        Ok(speed) => crate::app_log!(
                            "measured {}: prompt {:.0} tok/s, generation {:.1} tok/s",
                            measured.name,
                            speed.prompt_tokens_per_second,
                            speed.generation_tokens_per_second
                        ),
                        Err(e) => crate::app_log!("measured {}: failed: {e}", measured.name),
                    }
                }
                crate::app_log!(
                    "automatic device: {}",
                    choice.device.as_deref().unwrap_or("CPU")
                );
                self.settings.backend.measured = Some(choice);
                // Measuring from the settings asks for the fastest: automatic selection.
                if requested {
                    self.settings.backend.device = DeviceSetting::Auto;
                }
                self.settings.save();
                let settings = self.settings.backend.clone();
                self.backend
                    .update(cx, |backend, cx| backend.set_settings(settings, window, cx));
                self.update_recommendation(cx);
                self.start_load(cx);
            }
            // A load sent before the measurement: the model is released for it, and loaded
            // again after it.
            Event::Loaded(_) | Event::LoadFailed(_) if self.measuring.is_some() => {
                self.pending_loads = self.pending_loads.saturating_sub(1);
                return;
            }
            Event::Loaded(_) | Event::LoadFailed(_) if self.pending_loads > 1 => {
                // A newer load follows.
                self.pending_loads -= 1;
                return;
            }
            Event::Loaded(_) => {
                self.pending_loads = 0;
                // Unloaded while loading: the worker releases it next.
                if self.active_model.is_none() {
                    return;
                }
                self.model_ready = true;
                self.status = Status::Ready;
                // With Auto off, only a translation asked for while loading runs now.
                if std::mem::take(&mut self.translate_on_load) || self.auto_translate {
                    self.translate_now(window, cx);
                }
            }
            Event::LoadFailed(e) => {
                self.pending_loads = 0;
                self.translate_on_load = false;
                // A load unloaded since failing says nothing about the model in use (none).
                if self.active_model.is_some() {
                    self.status = Status::Error(e);
                }
            }
            Event::RuntimeFailed(e) => {
                crate::app_log!("inference runtime failed: {e}");
                self.runtime_error = Some(e.clone());
                self.measuring = None;
                self.backend
                    .update(cx, |backend, cx| backend.set_measuring(false, cx));
                self.model_ready = false;
                self.current_job = None;
                self.status = Status::Error(e);
            }
            Event::Chunk {
                job,
                index,
                count,
                source: (start, end),
            } if is_current(job) => {
                if let Status::Translating { chunk, .. } = &mut self.status {
                    *chunk = (count > 1).then_some((index + 1, count));
                }
                self.current_chunk = Some(ChunkMark {
                    start,
                    end,
                    tokens_before: self.stream_tokens,
                });
                self.chunks.push(ChunkSpan {
                    source: start..end,
                    output_start: self.translation.len(),
                });
            }
            Event::Rewind { job, len } if is_current(job) => {
                self.rewind_translation(len, window, cx);
            }
            // Logged without any text, so reports of odd output show whether loops occurred.
            Event::Retry { job, index, reason } if is_current(job) => {
                crate::app_log!(
                    "chunk {}: output ran away ({reason:?}); retrying in smaller pieces",
                    index + 1
                );
                return;
            }
            Event::Cut {
                job,
                index,
                reason,
                source: (start, end),
                output: (output_start, output_end),
            } if is_current(job) => {
                let char_position = self
                    .shown
                    .as_ref()
                    .and_then(|r| r.text.get(..start))
                    .map_or(0, |before| before.chars().count());
                crate::app_log!(
                    "chunk {}: output ran away again ({reason:?}) and was cut; source characters \
                     from {char_position}",
                    index + 1
                );
                self.cuts.push(CutMark {
                    source: start..end,
                    output: output_start..output_end,
                });
                return;
            }
            Event::Finished { job, stats } if is_current(job) => {
                self.current_job = None;
                self.status = match stats.stop_reason {
                    StopReason::Finished => {
                        if let Some(request) = self.shown.clone() {
                            self.remember(Cached {
                                request,
                                translation: self.translation.clone(),
                                chunks: self.chunks.clone(),
                                cuts: self.cuts.clone(),
                            });
                        }
                        Status::Done {
                            tokens: stats.generated_tokens,
                            elapsed: self.job_started.map_or(Duration::ZERO, |t| t.elapsed()),
                            tokens_per_second: stats.generation_tokens_per_second(),
                            cut: stats.cut,
                        }
                    }
                    StopReason::ContextFull => Status::Truncated,
                    // Only superseded jobs are cancelled, and those are no longer current.
                    StopReason::Cancelled => Status::Ready,
                    // Documents resolve runaway output themselves; these end single requests only.
                    StopReason::Repetition { .. }
                    | StopReason::LengthLimit
                    | StopReason::Incomplete => Status::Ready,
                };
            }
            Event::Failed { job, error } if is_current(job) => {
                self.current_job = None;
                self.shown_partial = true;
                self.status = Status::Error(error);
            }
            // Output of superseded jobs.
            Event::Chunk { .. }
            | Event::Token { .. }
            | Event::Segment { .. }
            | Event::Rewind { .. }
            | Event::Retry { .. }
            | Event::Cut { .. }
            | Event::Finished { .. }
            | Event::Failed { .. } => return,
        }
        cx.notify();
    }

    fn remember(&mut self, entry: Cached) {
        if self.cache.len() == CACHE_SIZE {
            self.cache.pop_front();
        }
        self.cache.push_back(entry);
    }

    fn pane(&self, side: Side) -> &Entity<TextareaState> {
        match side {
            Side::Source => &self.source,
            Side::Output => &self.output,
        }
    }

    /// The alignment of the shown translation with the source, while the source is the text
    /// that was translated.
    fn alignment(&mut self) -> Option<&Alignment> {
        if self.source_version != self.shown_version || self.chunks.is_empty() {
            return None;
        }
        let complete = self.current_job.is_none();
        let key = (self.translation.len(), self.chunks.len(), complete);
        if self.alignment.as_ref().map(|(k, _)| *k) != Some(key) {
            let source = &self.shown.as_ref()?.text;
            let alignment = Alignment::new(source, &self.translation, &self.chunks, complete);
            self.alignment = Some((key, alignment));
        }
        self.alignment.as_ref().map(|(_, a)| a)
    }

    /// A pane notified a change: if the reader scrolled it or moved its caret, the other pane
    /// follows.
    fn on_pane_changed(&mut self, side: Side, window: &mut Window, cx: &mut Context<Self>) {
        let (scroll_y, selection, focused) = {
            let state = self.pane(side).read(cx);
            (
                state.scroll_offset().y,
                state.selected_range(),
                state.focus_handle(cx).is_focused(window),
            )
        };
        let i = side as usize;
        let scrolled = scroll_y != self.sync.scroll_y[i];
        let moved = selection != self.sync.selection[i];
        self.sync.scroll_y[i] = scroll_y;
        self.sync.selection[i] = selection.clone();
        let following = self.sync.followed_at[i].is_some_and(|t| t.elapsed() < FOLLOW_SETTLE);
        if !self.settings.sync_scroll || following {
            return;
        }
        if moved && focused {
            self.follow_caret(side, selection.start, cx);
        } else if scrolled {
            self.follow_scroll(side, cx);
        }
    }

    /// Scrolls the other pane so the counterpart of `side`'s first visible line is at its top.
    fn follow_scroll(&mut self, side: Side, cx: &mut Context<Self>) {
        let Some(top) = top_offset(self.pane(side).read(cx)) else {
            return;
        };
        let other = side.other();
        let Some(target) = self.map_offset(side, top) else {
            return;
        };
        self.scroll_pane(other, target, px(0.), cx);
    }

    /// Selects the counterpart of the paragraph holding `side`'s caret in the other pane, and
    /// scrolls it level with the caret.
    fn follow_caret(&mut self, side: Side, offset: usize, cx: &mut Context<Self>) {
        let other = side.other();
        let Some(range) = self.alignment().and_then(|a| a.counterpart(side, offset)) else {
            return;
        };
        let Some(target) = self.map_offset(side, offset) else {
            return;
        };
        let caret_y = {
            let state = self.pane(side).read(cx);
            match state.line_height() {
                Some(line_height) => {
                    line_height * display_row(state, offset) as f32 + state.scroll_offset().y
                }
                None => px(0.),
            }
        };
        self.pane(other)
            .clone()
            .update(cx, |state, cx| state.set_selected_range(range, cx));
        self.scroll_pane(other, target, caret_y, cx);
    }

    /// The position in the other pane corresponding to `offset` in `side`.
    fn map_offset(&mut self, side: Side, offset: usize) -> Option<usize> {
        self.alignment()?;
        let alignment = &self.alignment.as_ref()?.1;
        let other_text = match side.other() {
            Side::Source => self.shown.as_ref()?.text.as_str(),
            Side::Output => self.translation.as_str(),
        };
        alignment.map(side, offset, other_text)
    }

    /// Scrolls `side` so that `offset` is `y` below the top of the pane.
    fn scroll_pane(&mut self, side: Side, offset: usize, y: Pixels, cx: &mut Context<Self>) {
        self.sync.followed_at[side as usize] = Some(Instant::now());
        self.pane(side).clone().update(cx, |state, cx| {
            let Some(line_height) = state.line_height() else {
                return;
            };
            let row = display_row(state, offset.min(state.text().len()));
            let mut scroll = state.scroll_offset();
            scroll.y = y - line_height * row as f32;
            if scroll.y > px(0.) {
                scroll.y = px(0.);
            }
            state.set_scroll_offset(scroll, cx);
        });
    }

    /// Selects the next passage that was cut in both panes and scrolls to it.
    fn show_next_cut(&mut self, cx: &mut Context<Self>) {
        let Some(cut) = self
            .cuts
            .get(self.next_cut % self.cuts.len().max(1))
            .cloned()
        else {
            return;
        };
        self.next_cut += 1;
        // A few lines below the top, so the text before it is in view too.
        let y = scaled_px(48., cx);
        self.scroll_pane(Side::Output, cut.output.start, y, cx);
        self.output
            .update(cx, |state, cx| state.set_selected_range(cut.output, cx));
        if self.source_version == self.shown_version {
            self.scroll_pane(Side::Source, cut.source.start, y, cx);
            self.source
                .update(cx, |state, cx| state.set_selected_range(cut.source, cx));
        }
    }

    /// Shows a newer release found before, and asks GitHub again once a day has passed since the
    /// last check; at once with `now` (the settings' Check now).
    fn check_for_update(&mut self, now: bool, cx: &mut Context<Self>) {
        let path = settings::update_check_path();
        let current = Version::current();
        if now {
            self.update_check = UpdateCheck::Checking;
        } else {
            let cache = CheckCache::load(&path);
            self.newer_release = cache.newer_than(current).cloned();
            if !cache.is_due(SystemTime::now()) {
                cx.notify();
                return;
            }
        }
        cx.notify();
        self._update_task = cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    let release = update::latest()?;
                    if let Err(e) =
                        CheckCache::checked(SystemTime::now(), release.clone()).save(&path)
                    {
                        crate::app_log!("cannot save the update check: {e}");
                    }
                    Ok::<_, update::UpdateError>(release)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.update_check = match result {
                    Ok(release) => {
                        crate::app_log!(
                            "update check: the newest release is {}, this build {current}",
                            release.version
                        );
                        let version = release.version;
                        let newer = version > current;
                        // Unless the checks were turned off meanwhile.
                        if now || this.settings.check_updates {
                            this.newer_release = newer.then_some(release);
                        }
                        // A version prepared earlier is superseded: the next install
                        // prepares this one.
                        if matches!(this.install, InstallState::Ready(ready) if ready < version) {
                            this.install = InstallState::Idle;
                        }
                        if newer {
                            UpdateCheck::Found(version)
                        } else {
                            UpdateCheck::UpToDate(version)
                        }
                    }
                    Err(e) => {
                        crate::app_log!("update check failed: {e}");
                        UpdateCheck::Failed(e.to_string())
                    }
                };
                cx.notify();
            });
        });
    }

    /// Removes what an update left next to the app, and picks up one prepared earlier or the
    /// failure of the last one.
    fn clean_up_update(&mut self, cx: &mut Context<Self>) {
        let Some(installation) = self.installation.clone() else {
            return;
        };
        let current = Version::current();
        self.clean_up = Some(cx.spawn(async move |this, cx| {
            let (failed, prepared) = cx
                .background_spawn(async move {
                    let failed = installation.clean_up(current);
                    (failed, installation.prepared(current))
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if let Some(error) = &failed {
                    crate::app_log!("the last update failed: {error}");
                }
                // An install started meanwhile tells its own outcome.
                if this.install != InstallState::Idle {
                    return;
                }
                if let Some(error) = failed {
                    this.install = InstallState::Failed(error);
                } else if let Some(version) = prepared {
                    // Unless a newer release is known (from the last check): installing then
                    // prepares that one.
                    if this
                        .newer_release
                        .as_ref()
                        .is_none_or(|release| release.version <= version)
                    {
                        crate::app_log!("the update to {version} is ready to install");
                        this.install = InstallState::Ready(version);
                    }
                }
                cx.notify();
            });
        }));
    }

    /// Downloads the newest release and unpacks it next to the app.
    fn install_update(&mut self, cx: &mut Context<Self>) {
        let (Some(installation), Some(release)) =
            (self.installation.clone(), self.newer_release.as_ref())
        else {
            return;
        };
        if matches!(self.install, InstallState::Downloading { .. }) {
            return;
        }
        self.install = InstallState::Downloading {
            version: release.version,
            done: 0,
            total: 0,
        };
        cx.notify();
        let clean_up = self.clean_up.take();
        self._install_task = cx.spawn(async move |this, cx| {
            // The start-up clean-up works in the same folder.
            if let Some(clean_up) = clean_up {
                clean_up.await;
            }
            let (progress_tx, progress) = async_channel::unbounded();
            let job = cx.background_spawn(async move {
                // The check's answer may be a day old: the files are taken as they are now.
                let release = update::latest()?;
                let current = Version::current();
                if release.version <= current {
                    return Err(update::UpdateError::Format(format!(
                        "the newest release, {}, is not newer than {current}",
                        release.version
                    )));
                }
                let version = release.version;
                crate::app_log!(
                    "downloading {} for the update to {version}",
                    installation.asset_name(version)
                );
                let mut last: Option<Instant> = None;
                installation.prepare(&release, &mut |done, total| {
                    // Ten times a second is enough for the status bar.
                    if done == total
                        || last.is_none_or(|t| t.elapsed() >= Duration::from_millis(100))
                    {
                        last = Some(Instant::now());
                        let _ = progress_tx.try_send((version, done, total));
                    }
                })?;
                Ok(version)
            });
            // Ends when the job does: it holds the sender.
            while let Ok((version, done, total)) = progress.recv().await {
                let _ = this.update(cx, |this, cx| {
                    if let InstallState::Downloading { .. } = this.install {
                        this.install = InstallState::Downloading {
                            version,
                            done,
                            total,
                        };
                        cx.notify();
                    }
                });
            }
            let result = job.await;
            let _ = this.update(cx, |this, cx| {
                this.install = match result {
                    Ok(version) => {
                        crate::app_log!("the update to {version} is ready to install");
                        InstallState::Ready(version)
                    }
                    Err(e) => {
                        crate::app_log!("the update failed: {e}");
                        InstallState::Failed(e.to_string())
                    }
                };
                cx.notify();
            });
        });
    }

    /// Quits, and has the prepared version swap itself in and start.
    fn restart_to_update(&mut self, cx: &mut Context<Self>) {
        let InstallState::Ready(version) = self.install else {
            return;
        };
        let Some(installation) = &self.installation else {
            return;
        };
        match update::apply::start(installation) {
            Ok(()) => {
                crate::app_log!("quitting to install the update to {version}");
                cx.quit();
            }
            Err(e) => {
                crate::app_log!("cannot start the update to {version}: {e}");
                self.install = InstallState::Failed(e.to_string());
                cx.notify();
            }
        }
    }

    /// The newer release: what installing it does, its notes, and the button that starts it.
    fn open_update(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(release) = self.newer_release.clone() else {
            return;
        };
        let installable = self.installation.is_some();
        let failure = match &self.install {
            InstallState::Failed(error) => Some(error.clone()),
            _ => None,
        };
        let view = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, cx| {
            let muted = cx.theme().muted_foreground;
            let page = release.page.clone();
            let notes_page = page.clone();
            let install_view = view.clone();
            let primary = if installable {
                Button::new("update-install")
                    .primary()
                    .label(t!("update.download").into_owned())
                    .on_click(move |_, window, cx| {
                        window.close_dialog(cx);
                        let _ = install_view.update(cx, |this, cx| this.install_update(cx));
                    })
            } else {
                Button::new("update-page")
                    .primary()
                    .label(t!("update.open_page").into_owned())
                    .on_click(move |_, window, cx| {
                        window.close_dialog(cx);
                        cx.open_url(&page);
                    })
            };
            dialog
                .title(t!("update.title", version = release.version.to_string()).into_owned())
                .w(scaled_px(520., cx))
                .child(
                    v_flex()
                        .gap_3()
                        .text_sm()
                        .child(if installable {
                            t!("update.body", version = release.version.to_string()).into_owned()
                        } else {
                            t!("update.manual").into_owned()
                        })
                        .children(failure.clone().map(|error| {
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(t!("update.last_failed", error = error).into_owned())
                        }))
                        .child(
                            Button::new("update-notes")
                                .link()
                                .label(t!("update.notes").into_owned())
                                .on_click(move |_, _, cx| cx.open_url(&notes_page)),
                        ),
                )
                .footer(
                    h_flex()
                        .w_full()
                        .justify_end()
                        .gap_2()
                        .child(
                            Button::new("update-later")
                                .label(t!("update.later").into_owned())
                                .on_click(|_, window, cx| window.close_dialog(cx)),
                        )
                        .child(primary),
                )
        });
    }

    fn set_check_updates(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.settings.check_updates == enabled {
            return;
        }
        self.settings.check_updates = enabled;
        self.settings.save();
        crate::app_log!("update checks {}", if enabled { "on" } else { "off" });
        if enabled {
            self.check_for_update(false, cx);
        } else {
            self.newer_release = None;
            cx.notify();
        }
    }

    fn set_sync_scroll(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.settings.sync_scroll == enabled {
            return;
        }
        self.settings.sync_scroll = enabled;
        self.settings.save();
        crate::app_log!(
            "synchronized scrolling {}",
            if enabled { "on" } else { "off" }
        );
        self.link_selection_focus(cx);
        cx.notify();
    }

    fn set_double_copy(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.settings.double_copy == enabled {
            return;
        }
        self.settings.double_copy = enabled;
        self.settings.save();
        crate::app_log!("double copy {}", if enabled { "on" } else { "off" });
        crate::shell::set_double_copy(enabled, cx);
        cx.notify();
    }

    fn set_resident(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.settings.resident == enabled {
            return;
        }
        self.settings.resident = enabled;
        self.settings.save();
        crate::app_log!("staying resident {}", if enabled { "on" } else { "off" });
        crate::shell::set_resident(enabled, cx);
        cx.notify();
    }

    /// Puts `text` in the source and translates it, with Auto off too: a double copy in another
    /// application asks for it.
    pub fn translate_text(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.source.update(cx, |state, cx| {
            state.set_value(SharedString::from(text), window, cx)
        });
        self.source_info = None;
        self.source_version += 1;
        self.translate_now(window, cx);
        cx.notify();
    }

    /// While scrolling is synchronized, each pane keeps its selection (the counterpart of the
    /// other pane's caret) visible while the other pane has focus.
    fn link_selection_focus(&self, cx: &mut Context<Self>) {
        let enabled = self.settings.sync_scroll;
        let source_focus = self.source.read(cx).focus_handle(cx);
        let output_focus = self.output.read(cx).focus_handle(cx);
        self.source.update(cx, |state, cx| {
            state.set_selection_focus(enabled.then_some(output_focus), cx)
        });
        self.output.update(cx, |state, cx| {
            state.set_selection_focus(enabled.then_some(source_focus), cx)
        });
    }

    fn can_swap(&self) -> bool {
        // While translating, the output is still partial.
        self.current_job.is_none()
            && matches!(
                (self.source_choice, self.target_choice),
                (SourceChoice::Lang(_), TargetChoice::Lang(_)) | (_, TargetChoice::JapaneseEnglish)
            )
    }

    /// Swaps the languages and moves the translation into the source. With Japanese ⇄ English
    /// as the target, an explicit source becomes the translation's language (the target stays).
    fn swap(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Easy Japanese is a target only: its text is Japanese as a source.
        let as_source = |code: &'static str| {
            if code == engine::pfml::JA_EASY {
                "ja"
            } else {
                code
            }
        };
        let swapped = match (self.source_choice, self.target_choice) {
            (SourceChoice::Lang(s), TargetChoice::Lang(t)) => {
                Some((SourceChoice::Lang(as_source(t)), TargetChoice::Lang(s)))
            }
            (SourceChoice::Lang(s), TargetChoice::JapaneseEnglish) => Some((
                SourceChoice::Lang(TargetChoice::JapaneseEnglish.resolve_for(s == "ja")),
                TargetChoice::JapaneseEnglish,
            )),
            _ => None,
        };
        if let Some((source, target)) = swapped {
            self.source_choice = source;
            self.target_choice = target;
            let (source_choice, target_choice) = (self.source_choice, self.target_choice);
            self.source_select.update(cx, |state, cx| {
                state.set_selected_value(&source_choice, window, cx)
            });
            self.target_select.update(cx, |state, cx| {
                state.set_selected_value(&target_choice, window, cx)
            });
        }
        if !self.translation.is_empty() {
            let text = SharedString::from(self.translation.clone());
            self.source
                .update(cx, |state, cx| state.set_value(text, window, cx));
            self.source_info = None;
            self.source_version += 1;
        }
        self.translate_now(window, cx);
        cx.notify();
    }

    fn copy_translation(
        &mut self,
        _: &CopyTranslation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.translation.is_empty() {
            return;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(self.translation.clone()));
        self.copied = true;
        self.copied_reset = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(COPIED_FEEDBACK).await;
            let _ = this.update(cx, |this, cx| {
                this.copied = false;
                cx.notify();
            });
        });
        cx.notify();
    }

    fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.source.update(cx, |state, cx| {
            state.set_value("", window, cx);
            state.focus(window, cx);
        });
        self.source_info = None;
        self.source_version += 1;
        self.translate_now(window, cx);
    }

    /// Estimated time until the running job finishes, once a chunk of a long text is done.
    ///
    /// Progress is measured in source bytes. The chunk in progress counts in proportion to its
    /// output so far, against what the finished chunks produced per source byte.
    fn remaining_time(&self) -> Option<Duration> {
        let chunk = self.current_chunk?;
        let total = self.shown.as_ref()?.text.len();
        let elapsed = self.job_started?.elapsed().as_secs_f64();
        // Nothing to go by before a chunk has been translated.
        if chunk.tokens_before == 0 || chunk.start == 0 || total == 0 || elapsed < 1.0 {
            return None;
        }
        let tokens_per_byte = chunk.tokens_before as f64 / chunk.start as f64;
        let chunk_len = (chunk.end - chunk.start) as f64;
        let chunk_tokens = (self.stream_tokens - chunk.tokens_before) as f64;
        // Never count the chunk as finished before it is.
        let chunk_done = (chunk_tokens / (chunk_len * tokens_per_byte).max(1.0)).min(0.95);
        let done = chunk.start as f64 + chunk_len * chunk_done;
        let remaining = (total as f64 - done).max(0.0) * elapsed / done;
        Some(Duration::from_secs_f64(remaining))
    }

    /// Generation rate of the running job, measured from the first received token.
    /// It includes prompt processing between chunks of a long text.
    fn live_tokens_per_second(&self) -> Option<f64> {
        let elapsed = self.stream_started?.elapsed().as_secs_f64();
        (elapsed >= 0.3 && self.stream_tokens > 1)
            .then(|| (self.stream_tokens - 1) as f64 / elapsed)
    }

    fn status_text(&self) -> String {
        match &self.status {
            Status::NoModel => t!("status.no_model").into_owned(),
            Status::Unloaded => t!("status.unloaded").into_owned(),
            Status::Loading(p) => {
                t!("status.loading", percent = format!("{:.0}", p * 100.0)).into_owned()
            }
            Status::Measuring { first, step, count } => {
                let key = if *first {
                    "status.measuring_first"
                } else {
                    "status.measuring"
                };
                t!(key, step = step.max(&1), count = count.max(&1)).into_owned()
            }
            Status::Ready => t!("status.ready").into_owned(),
            Status::Translating { target, chunk } => {
                let mut text =
                    t!("status.translating", lang = lang::language_name(target)).into_owned();
                if let Some((current, total)) = chunk {
                    text.push_str(&format!(" ({current}/{total})"));
                }
                if self.stream_tokens > 0 {
                    let tokens = t!("status.tokens", count = group_digits(self.stream_tokens));
                    text.push_str(&format!(" · {tokens}"));
                }
                if let Some(rate) = self.live_tokens_per_second() {
                    text.push_str(&format!(" · {rate:.1} tok/s"));
                }
                if let Some(eta) = self.remaining_time() {
                    let eta = t!("status.remaining", time = lang::format_duration(eta));
                    text.push_str(&format!(" · {eta}"));
                }
                text
            }
            Status::Done {
                tokens,
                elapsed,
                tokens_per_second,
                cut,
            } => {
                let speed = format!("{tokens_per_second:.1}");
                let tokens = group_digits(*tokens);
                let time = lang::format_duration(*elapsed);
                if *cut > 0 {
                    t!(
                        "status.done_cut",
                        tokens = tokens,
                        speed = speed,
                        time = time,
                        count = cut
                    )
                    .into_owned()
                } else {
                    t!("status.done", tokens = tokens, speed = speed, time = time).into_owned()
                }
            }
            Status::Cached { cut: 0 } => t!("status.cached").into_owned(),
            Status::Cached { cut } => t!("status.cached_cut", count = cut).into_owned(),
            Status::Stopped => t!("status.stopped").into_owned(),
            Status::Truncated => t!("status.truncated").into_owned(),
            Status::Error(message) => t!("status.error", message = message).into_owned(),
        }
    }
}

impl Render for TranslatorView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let source = self.source_info(cx);
        let char_count = source.chars;
        let shows_style = self.target_choice.resolve_for(source.looks_japanese) == "ja";
        let view = cx.entity().downgrade();
        let theme = cx.theme();
        let muted = theme.muted_foreground;

        let model_button_label = self.active_model.as_ref().map_or_else(
            || t!("models.choose").into_owned(),
            |model| match &self.loaded_on {
                Some(device) => format!("{} · {device}", model.label()),
                None => model.label(),
            },
        );
        // Only the title lives in the title bar: on Linux its drag-to-move handling can swallow
        // clicks on controls placed there, so buttons go in the toolbar and status bar.
        let title_bar = TitleBar::new().child(
            div()
                .text_sm()
                .font_semibold()
                .child(t!("app.title").into_owned()),
        );
        let model_button = Button::new("models")
            .xsmall()
            .icon(IconName::HardDrive)
            .label(model_button_label)
            .tooltip(t!("models.title").into_owned())
            .map(|button| {
                // Without a model, make the way to choose one stand out.
                if self.active_model.is_none() {
                    button.primary()
                } else {
                    button.ghost()
                }
            })
            .on_click(cx.listener(|this, _, window, cx| this.open_models(window, cx)));
        let settings_button = Button::new("settings")
            .ghost()
            .xsmall()
            .icon(IconName::Settings)
            .tooltip(t!("settings.title").into_owned())
            .on_click(cx.listener(|this, _, window, cx| this.open_settings(window, cx)));
        let update_button = match (&self.install, &self.newer_release) {
            (InstallState::Ready(version), _) => Some(
                Button::new("update")
                    .primary()
                    .xsmall()
                    .icon(Lucide::CircleArrowUp)
                    .label(t!("update.restart", version = version.to_string()).into_owned())
                    .on_click(cx.listener(|this, _, _, cx| this.restart_to_update(cx))),
            ),
            (
                InstallState::Downloading {
                    version,
                    done,
                    total,
                },
                _,
            ) => {
                let percent = (*done * 100).checked_div(*total).unwrap_or(0);
                Some(
                    Button::new("update").ghost().xsmall().loading(true).label(
                        t!(
                            "update.downloading",
                            version = version.to_string(),
                            percent = percent.to_string()
                        )
                        .into_owned(),
                    ),
                )
            }
            (state, Some(release)) => {
                let version = release.version.to_string();
                let label = if matches!(state, InstallState::Failed(_)) {
                    t!("update.failed", version = version)
                } else {
                    t!("update.available", version = version)
                };
                Some(
                    Button::new("update")
                        .ghost()
                        .xsmall()
                        .icon(Lucide::CircleArrowUp)
                        .label(label.into_owned())
                        .on_click(cx.listener(|this, _, window, cx| this.open_update(window, cx))),
                )
            }
            (_, None) => None,
        };

        let toolbar = h_flex()
            .px_3()
            .py_2()
            .gap_2()
            .child(
                Select::new(&self.source_select)
                    .w(scaled(210.))
                    .menu_width(scaled(260.))
                    .search_placeholder(t!("search.language").into_owned()),
            )
            .child(
                Button::new("swap")
                    .ghost()
                    .icon(Lucide::ArrowLeftRight)
                    .tooltip(t!("action.swap").into_owned())
                    .disabled(!self.can_swap())
                    .on_click(cx.listener(|this, _, window, cx| this.swap(window, cx))),
            )
            .child(
                Select::new(&self.target_select)
                    .w(scaled(230.))
                    .menu_width(scaled(260.))
                    .search_placeholder(t!("search.language").into_owned()),
            )
            .when(shows_style, |this| {
                this.child(Select::new(&self.style_select).w(scaled(190.)))
            })
            .child(div().flex_1())
            .child(
                Button::new("options")
                    .ghost()
                    .icon(IconName::Settings2)
                    .label(if self.glossary.is_empty() {
                        t!("options.toggle").into_owned()
                    } else {
                        t!("options.toggle_with_terms", count = self.glossary.len()).into_owned()
                    })
                    .selected(self.show_options)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_options = !this.show_options;
                        cx.notify();
                    })),
            )
            .child(
                Switch::new("auto-translate")
                    .checked(self.auto_translate)
                    .label(t!("action.auto_translate").into_owned())
                    .on_click(cx.listener(|this, checked: &bool, window, cx| {
                        this.auto_translate = *checked;
                        if this.auto_translate {
                            this.translate_now(window, cx);
                        } else {
                            this.debounce = Task::ready(());
                        }
                        cx.notify();
                    })),
            )
            .child(if self.current_job.is_some() {
                Button::new("stop")
                    .danger()
                    .label(t!("action.stop").into_owned())
                    .on_click(cx.listener(|this, _, _, cx| this.stop_translation(cx)))
            } else {
                Button::new("translate")
                    .primary()
                    .label(t!("action.translate").into_owned())
                    .disabled(!self.model_ready)
                    .on_click(cx.listener(|this, _, window, cx| this.translate_now(window, cx)))
            });

        let source_pane = v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .gap_1()
            .child(
                Textarea::new(&self.source)
                    .flex_1()
                    .h_full()
                    .on_paste(move |_, _, cx| {
                        let _ = view.update(cx, |this, _| this.paste_pending = true);
                        // Let the textarea insert the text as usual.
                        false
                    }),
            )
            .child(
                h_flex()
                    .justify_between()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(t!("source.chars", count = char_count).into_owned())
                    .child(
                        Button::new("clear")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .label(t!("action.clear").into_owned())
                            .disabled(source.chars == 0)
                            .on_click(cx.listener(|this, _, window, cx| this.clear(window, cx))),
                    ),
            );

        let output_pane = v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .gap_1()
            .child(Textarea::new(&self.output).readonly(true).flex_1().h_full())
            .child(
                h_flex().justify_end().child(
                    Button::new("copy")
                        .ghost()
                        .xsmall()
                        .icon(if self.copied {
                            IconName::Check
                        } else {
                            IconName::Copy
                        })
                        .label(if self.copied {
                            t!("action.copied").into_owned()
                        } else {
                            t!("action.copy").into_owned()
                        })
                        .disabled(self.translation.is_empty())
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.copy_translation(&CopyTranslation, window, cx)
                        })),
                ),
            );

        let status_bar = h_flex()
            .px_3()
            .py_1()
            .border_t_1()
            .border_color(theme.border)
            .text_xs()
            .text_color(theme.muted_foreground)
            .gap_2()
            .child(
                div()
                    .id("status")
                    .flex_1()
                    .min_w_0()
                    .child(self.status_text())
                    .when(
                        matches!(self.status, Status::Done { .. } | Status::Cached { .. })
                            && !self.cuts.is_empty(),
                        |this| {
                            this.cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| this.show_next_cut(cx)))
                        },
                    ),
            )
            .children(update_button)
            .child(model_button)
            .child(settings_button)
            // Attribution required by the PLaMo Community License (Article 4).
            .child("Built with PLaMo");

        v_flex()
            .key_context(KEY_CONTEXT)
            .on_action(cx.listener(Self::copy_translation))
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(title_bar)
            .child(toolbar)
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .px_3()
                    .pb_2()
                    .gap_3()
                    .child(source_pane)
                    .child(output_pane),
            )
            .when(self.show_options, |this| {
                this.child(
                    h_flex()
                        .px_3()
                        .pb_2()
                        .gap_3()
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap_1()
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(muted)
                                        .child(t!("options.context").into_owned()),
                                )
                                .child(Textarea::new(&self.context_input).h(scaled(96.))),
                        )
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap_1()
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(muted)
                                        .child(t!("options.glossary").into_owned()),
                                )
                                .child(Textarea::new(&self.glossary_input).h(scaled(96.))),
                        ),
                )
            })
            .child(status_bar)
    }
}

/// A short label such as `2B · Q4_K_M` for the standard file names, else the file stem.
fn model_label(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match stem
        .strip_prefix("plamo-3-translate-")
        .and_then(|rest| rest.split_once('-'))
    {
        Some((size, quant)) => format!("{} · {quant}", size.to_uppercase()),
        None => stem,
    }
}

#[cfg(test)]
mod tests {
    // Import explicitly: `gpui_kit::*` exports a `test` macro that would shadow `#[test]`.
    use std::path::Path;

    use super::{group_digits, model_label};

    #[test]
    fn groups_digits() {
        assert_eq!(group_digits(0), "0");
        assert_eq!(group_digits(999), "999");
        assert_eq!(group_digits(1000), "1,000");
        assert_eq!(group_digits(1234567), "1,234,567");
    }

    #[test]
    fn labels_standard_model_files() {
        assert_eq!(
            model_label(Path::new("/m/plamo-3-translate-2b-Q4_K_M.gguf")),
            "2B · Q4_K_M"
        );
        assert_eq!(
            model_label(Path::new("plamo-3-translate-0.8b-Q2_K.gguf")),
            "0.8B · Q2_K"
        );
        assert_eq!(model_label(Path::new("custom.gguf")), "custom");
    }
}
