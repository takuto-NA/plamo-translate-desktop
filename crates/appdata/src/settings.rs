//! Persistent settings and application directories.

use std::path::PathBuf;

use engine::document::DocumentOptions;
use serde::{Deserialize, Serialize};

fn project_dirs() -> Option<directories::ProjectDirs> {
    directories::ProjectDirs::from("", "", "plamo-translate-desktop")
}

/// The data directory: the default models folder, caches and logs.
fn data_dir() -> Option<PathBuf> {
    project_dirs().map(|dirs| dirs.data_local_dir().to_path_buf())
}

/// Where models are kept unless the settings name another folder (see [`Settings::models_dir`]).
pub fn default_models_dir() -> PathBuf {
    data_dir().map_or_else(|| PathBuf::from("models"), |dir| dir.join("models"))
}

/// Catalog entries found on Hugging Face, cached for offline starts.
pub fn catalog_cache_path() -> PathBuf {
    data_file("catalog.json")
}

/// What the last check for a newer release found (see the `update` crate).
pub fn update_check_path() -> PathBuf {
    data_file("update.json")
}

/// The application log, next to the models.
pub fn log_path() -> PathBuf {
    data_file("app.log")
}

/// The browser host's log, next to the app's.
pub fn host_log_path() -> PathBuf {
    data_file("host.log")
}

/// A file in the data directory.
pub fn data_file(name: &str) -> PathBuf {
    data_dir().map_or_else(|| PathBuf::from(name), |dir| dir.join(name))
}

/// Where the settings are saved.
pub fn settings_path() -> Option<PathBuf> {
    project_dirs().map(|dirs| dirs.config_dir().join("settings.json"))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Catalog id of the selected model.
    pub model: Option<String>,
    /// The folder models are downloaded to and loaded from, if not the default one.
    pub models_dir: Option<PathBuf>,
    /// Whether the user accepted the PLaMo Community License before downloading.
    pub license_accepted: bool,
    pub backend: BackendSettings,
    /// Glossary text, one `source = target` per line.
    pub glossary: String,
    pub ui_language: UiLanguage,
    pub theme: ThemeSetting,
    /// Size of the interface in percent, on top of the scaling the OS applies (some Linux
    /// desktops apply none on a high-DPI display).
    pub ui_scale: u16,
    pub document: DocumentSettings,
    /// Scroll the source and the translation together, and show the counterpart of the caret.
    pub sync_scroll: bool,
    /// Ask GitHub for a newer release, at most once a day.
    pub check_updates: bool,
    /// Translate the clipboard when it is copied to twice in quick succession, in any
    /// application (Ctrl+C or ⌘C pressed twice).
    pub double_copy: bool,
    /// Keep running when the window is closed: the notification-area icon (Windows), the Dock
    /// (macOS), or starting the app again opens it.
    pub resident: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model: None,
            models_dir: None,
            license_accepted: false,
            backend: BackendSettings::default(),
            glossary: String::new(),
            ui_language: UiLanguage::default(),
            theme: ThemeSetting::default(),
            ui_scale: 100,
            document: DocumentSettings::default(),
            sync_scroll: true,
            check_updates: true,
            double_copy: false,
            resident: false,
        }
    }
}

impl Settings {
    /// The folder models are downloaded to and loaded from.
    pub fn models_dir(&self) -> PathBuf {
        self.models_dir.clone().unwrap_or_else(default_models_dir)
    }

    /// [`Self::ui_scale`] as a factor, kept within 50–300% whatever settings.json says.
    pub fn ui_scale_factor(&self) -> f32 {
        f32::from(self.ui_scale.clamp(50, 300)) / 100.0
    }
}

/// How long texts are split (see `engine::document`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DocumentSettings {
    /// Upper bound for one chunk, in tokens.
    pub chunk_tokens: usize,
    /// Upper bound for the history sent with each chunk, in tokens.
    pub history_tokens: usize,
}

impl Default for DocumentSettings {
    fn default() -> Self {
        let defaults = DocumentOptions::default();
        Self {
            chunk_tokens: defaults.max_chunk_tokens,
            history_tokens: defaults.max_history_tokens,
        }
    }
}

impl DocumentSettings {
    /// The options for a translation; `cut_marker` marks passages that were cut.
    pub fn options(self, cut_marker: String) -> DocumentOptions {
        DocumentOptions {
            // A chunk of a few tokens would only split sentences apart.
            max_chunk_tokens: self.chunk_tokens.max(64),
            max_history_tokens: self.history_tokens,
            cut_marker,
        }
    }
}

/// Light or dark appearance.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeSetting {
    /// Follow the operating system, including later changes.
    #[default]
    System,
    Light,
    Dark,
}

/// Language of the user interface.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiLanguage {
    /// Follow the operating system.
    #[default]
    System,
    English,
    Japanese,
}

impl UiLanguage {
    /// The locale code to use. `PLAMO_LANG` overrides everything, for development.
    pub fn locale(self) -> &'static str {
        if let Some(code) = std::env::var("PLAMO_LANG")
            .ok()
            .and_then(|v| supported_locale(&v))
        {
            return code;
        }
        match self {
            Self::English => "en",
            Self::Japanese => "ja",
            Self::System => system_locale(),
        }
    }
}

/// The OS language if the UI is translated into it, else English.
pub fn system_locale() -> &'static str {
    sys_locale::get_locale()
        .and_then(|l| supported_locale(&l))
        .unwrap_or("en")
}

fn supported_locale(requested: &str) -> Option<&'static str> {
    let requested = requested.to_lowercase();
    if requested.starts_with("ja") {
        Some("ja")
    } else if requested.starts_with("en") {
        Some("en")
    } else {
        None
    }
}

/// Where and how the model runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BackendSettings {
    pub device: DeviceSetting,
    /// The fastest device measured on this machine, which [`DeviceSetting::Auto`] uses while
    /// the devices are the same (see `crate::devices`).
    pub measured: Option<MeasuredChoice>,
}

impl Default for BackendSettings {
    fn default() -> Self {
        Self {
            device: DeviceSetting::Auto,
            measured: None,
        }
    }
}

/// The result of measuring the devices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeasuredChoice {
    /// The devices measured, which the choice holds for (see `crate::devices::hardware`).
    pub hardware: String,
    /// The fastest: a device name such as `Vulkan0`, or `None` for the CPU.
    pub device: Option<String>,
    /// Each device's speed, for showing.
    pub results: Vec<MeasuredDevice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeasuredDevice {
    /// A device name, or `CPU`.
    pub name: String,
    /// Generation speed in tokens per second, or `None` if the model did not run there.
    pub tokens_per_second: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "name")]
pub enum DeviceSetting {
    /// The measured fastest device (see [`BackendSettings::measured`]), else the discrete GPU
    /// with the most free memory, else the CPU.
    #[default]
    Auto,
    Cpu,
    /// A ggml device by name, such as `Vulkan0`.
    Device(String),
}

impl Settings {
    /// Loads the settings, falling back to defaults if the file is missing or unreadable.
    ///
    /// A file that does not parse is renamed to `settings.json.invalid` rather than overwritten
    /// by the next save, so the license acceptance and the glossary in it can be recovered.
    pub fn load() -> Self {
        Self::read_from_disk(true)
    }

    /// Like [`Settings::load`], but leaves a file that does not parse where it is. For the
    /// browser host, which never saves: the file may be the app's, written by a newer version.
    pub fn read() -> Self {
        Self::read_from_disk(false)
    }

    fn read_from_disk(move_invalid: bool) -> Self {
        match settings_path() {
            Some(path) => Self::read_path(&path, move_invalid),
            None => Self::default(),
        }
    }

    fn read_path(path: &std::path::Path, move_invalid: bool) -> Self {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(e) => {
                crate::app_log!("cannot read the settings in {}: {e}", path.display());
                return Self::default();
            }
        };
        // Editors on Windows may save it with a byte order mark, or in another encoding; the
        // latter is kept aside like any file that does not parse, rather than overwritten.
        let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
        let parsed = std::str::from_utf8(bytes)
            .map_err(|e| format!("not UTF-8: {e}"))
            .and_then(|text| serde_json::from_str(text).map_err(|e| e.to_string()));
        parsed.unwrap_or_else(|e| {
            let aside = path.with_extension("json.invalid");
            let moved = move_invalid && std::fs::rename(path, &aside).is_ok();
            crate::app_log!(
                "ignoring invalid settings in {}: {e}{}",
                path.display(),
                if moved {
                    format!("; kept as {}", aside.display())
                } else {
                    String::new()
                }
            );
            Self::default()
        })
    }

    /// Saves the settings atomically. Failures are reported but not fatal.
    pub fn save(&self) {
        let Some(path) = settings_path() else {
            return;
        };
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
            std::fs::rename(&tmp, &path)
        })();
        if let Err(e) = result {
            crate::app_log!("failed to save settings to {}: {e}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn reads_a_byte_order_mark_and_keeps_other_encodings_aside() {
        let dir = std::env::temp_dir().join(format!("plamo-settings-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, b"\xEF\xBB\xBF{\"license_accepted\": true}").unwrap();
        assert!(Settings::read_path(&path, true).license_accepted);
        // Not UTF-8 (Shift_JIS): kept aside rather than read as garbage and saved over.
        std::fs::write(&path, b"{\"glossary\": \"\x93\xfa\x96\x7b\"}").unwrap();
        assert!(Settings::read_path(&path, true).glossary.is_empty());
        assert!(!path.exists());
        assert!(path.with_extension("json.invalid").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_fields_take_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
        assert_eq!(s.ui_scale_factor(), 1.0);
        let s: Settings = serde_json::from_str(r#"{"ui_scale":150}"#).unwrap();
        assert_eq!(s.ui_scale_factor(), 1.5);
        let s: Settings = serde_json::from_str(r#"{"ui_scale":1000}"#).unwrap();
        assert_eq!(s.ui_scale_factor(), 3.0);
        assert_eq!(s.models_dir(), super::default_models_dir());
        let s: Settings = serde_json::from_str(r#"{"models_dir":"/srv/models"}"#).unwrap();
        assert_eq!(s.models_dir(), std::path::Path::new("/srv/models"));
        let s: Settings = serde_json::from_str(r#"{"model":"x","unknown":1}"#).unwrap();
        assert_eq!(s.model.as_deref(), Some("x"));
        assert!(!s.license_accepted);
        // Settings from older versions with a context length still load.
        let s: Settings =
            serde_json::from_str(r#"{"backend":{"device":{"kind":"cpu"},"n_ctx":4096}}"#).unwrap();
        assert_eq!(s.backend.device, super::DeviceSetting::Cpu);
        assert_eq!(s.ui_language, super::UiLanguage::System);
        let s: Settings = serde_json::from_str(r#"{"ui_language":"japanese"}"#).unwrap();
        assert_eq!(s.ui_language, super::UiLanguage::Japanese);
        assert_eq!(s.theme, super::ThemeSetting::System);
        let s: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(s.theme, super::ThemeSetting::Dark);
        assert_eq!(s.document, super::DocumentSettings::default());
        assert!(s.sync_scroll);
        let s: Settings = serde_json::from_str(r#"{"document":{"chunk_tokens":512}}"#).unwrap();
        assert_eq!(s.document.chunk_tokens, 512);
        assert_eq!(
            s.document.history_tokens,
            super::DocumentSettings::default().history_tokens
        );
    }

    #[test]
    fn device_setting_round_trips() {
        use super::DeviceSetting;
        for d in [
            DeviceSetting::Auto,
            DeviceSetting::Cpu,
            DeviceSetting::Device("Vulkan0".into()),
        ] {
            let json = serde_json::to_string(&d).unwrap();
            assert_eq!(serde_json::from_str::<DeviceSetting>(&json).unwrap(), d);
        }
    }
}
