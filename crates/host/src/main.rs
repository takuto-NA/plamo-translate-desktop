//! Native messaging host for the PLaMo Translate browser extension.
//!
//! The browser starts this program when the extension connects (Settings in the desktop app
//! registers it), and it runs for as long as the connection is open. It translates with the
//! model and device selected in the desktop app, reading the app's settings again before each
//! request, and streams the translation back. [`protocol`] describes the messages.
//!
//! `--check` starts llama.cpp, prints the compute devices, and exits; packaging uses it as a
//! smoke test.
//!
//! This is a console program on Windows too: Chrome starts hosts through `cmd.exe` with the
//! window hidden and waits on them, which a GUI-subsystem program would not support.

mod protocol;

use std::io::{self, Stdout};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use appdata::settings::{self, DeviceSetting, Settings};
use appdata::{app_log, applog, devices, glossary};
use engine::StopReason;
use engine::llama::{Device, DeviceKind, Runtime, RuntimeOptions};
use engine::models::{self as catalog, ModelStore};
use engine::pfml::{Form, LangCode, TranslationOptions};
use engine::worker::{Event, JobId, LoadRequest, Worker};

use crate::protocol::{DeviceChoice, ModelChoice, Request, Response, read_message, write_message};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    // SAFETY: first thing in main, before any thread starts.
    unsafe {
        appdata::devices::configure_openvino();
        engine::llama::configure_metal();
    }
    if std::env::args().any(|arg| arg == "--check") {
        std::process::exit(check());
    }
    applog::init(&settings::host_log_path());
    // The browser passes the extension's origin as the first argument.
    app_log!(
        "host {VERSION} started for {}",
        std::env::args().nth(1).unwrap_or_default()
    );
    let cached = engine::discovery::load_cache(&settings::catalog_cache_path());
    catalog::register(cached.into_iter().map(|d| d.into_entry()));

    // The model loads on the first request: the extension sends its choices (`configure`)
    // first, so the app's selection is not loaded only to be replaced.
    let mut host = Host::start();

    let mut input = io::stdin().lock();
    loop {
        let message = match read_message(&mut input) {
            Ok(Some(message)) => message,
            Ok(None) => break,
            Err(e) => {
                app_log!("cannot read from the browser: {e}");
                break;
            }
        };
        match serde_json::from_slice::<Request>(&message) {
            Ok(request) => host.handle(request),
            Err(e) => host.send(&Response::Error {
                id: None,
                code: "bad_request",
                message: e.to_string(),
            }),
        }
    }
    app_log!("host exiting: the browser closed the connection");
}

/// Starts llama.cpp and prints its devices. Returns the exit code.
fn check() -> i32 {
    match Runtime::init(RuntimeOptions::default()) {
        Ok(runtime) => {
            for d in runtime.devices() {
                println!("{} {} {:?} {}", d.index, d.name, d.kind, d.description);
            }
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// What the extension is told about the model.
#[derive(Debug, Clone)]
struct Status {
    state: &'static str,
    model: Option<String>,
    device: Option<String>,
    message: Option<String>,
}

/// State shared with the worker's event callback.
struct Shared {
    devices: Option<Vec<Device>>,
    /// Set when llama.cpp could not start; nothing can load after that.
    runtime_error: Option<String>,
    status: Status,
    /// The job whose output goes to the extension, with the extension's request id.
    job: Option<(JobId, u64)>,
    /// The translation sent so far, to convert rewinds into UTF-16 lengths.
    output: String,
    /// Loads and unloads sent to the worker whose result (`Loaded`, `LoadFailed`, or
    /// `Unloaded`) has not arrived; only the last one's result describes the model in use.
    pending_loads: usize,
}

type Output = Arc<Mutex<Stdout>>;

fn send(out: &Output, response: &Response) {
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    // A closed pipe means the browser is gone; reading stdin will end the process.
    let _ = write_message(&mut *out, response);
}

fn status_message(status: &Status) -> Response {
    Response::Status {
        state: status.state,
        model: status.model.clone(),
        device: status.device.clone(),
        message: status.message.clone(),
        version: VERSION,
    }
}

/// What a translation request translates.
enum Input {
    Text(String),
    Segments(Vec<String>),
}

struct Host {
    worker: Worker,
    shared: Arc<(Mutex<Shared>, Condvar)>,
    out: Output,
    /// The model file and device setting last sent to the worker (`Some(None)`: no model), or
    /// `None` before the first check.
    loaded: Option<Option<(PathBuf, DeviceSetting)>>,
    /// The extension's choices; `None` follows the app.
    model_choice: Option<String>,
    device_choice: Option<DeviceSetting>,
}

impl Host {
    /// Starts the worker and waits until llama.cpp reports its devices (or fails).
    fn start() -> Self {
        let out: Output = Arc::new(Mutex::new(io::stdout()));
        let shared = Arc::new((
            Mutex::new(Shared {
                devices: None,
                runtime_error: None,
                status: Status {
                    state: "starting",
                    model: None,
                    device: None,
                    message: None,
                },
                job: None,
                output: String::new(),
                pending_loads: 0,
            }),
            Condvar::new(),
        ));
        let worker = {
            let (shared, out) = (shared.clone(), out.clone());
            Worker::spawn(RuntimeOptions::default(), move |event| {
                on_event(&shared, &out, event)
            })
        };
        let host = Self {
            worker,
            shared,
            out,
            loaded: None,
            model_choice: None,
            device_choice: None,
        };
        {
            let (lock, ready) = &*host.shared;
            let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            let _guard = ready
                .wait_while(guard, |s| s.devices.is_none() && s.runtime_error.is_none())
                .unwrap_or_else(|e| e.into_inner());
        }
        host
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn send(&self, response: &Response) {
        send(&self.out, response);
    }

    fn send_status(&self) {
        let status = self.lock().status.clone();
        self.send(&status_message(&status));
    }

    fn set_status(&self, status: Status) {
        self.lock().status = status.clone();
        self.send(&status_message(&status));
    }

    fn handle(&mut self, request: Request) {
        match request {
            Request::Translate {
                id,
                text,
                target,
                source,
                style,
            } => self.translate(id, Input::Text(text), target, source, style),
            Request::TranslateSegments {
                id,
                segments,
                target,
                source,
                style,
            } => self.translate(id, Input::Segments(segments), target, source, style),
            Request::Cancel => self.worker.cancel(),
            Request::Status => {
                // Nothing loads for it before the first request that uses a model: the
                // extension asks for the status to tell whether the host starts at all.
                if self.loaded.is_some() {
                    self.refresh_model();
                }
                self.send_status();
            }
            Request::Options => {
                let settings = self.refresh_model();
                self.send_options(&settings);
            }
            Request::Configure { model, device } => {
                self.model_choice = model.filter(|m| !m.is_empty());
                self.device_choice = device.filter(|d| !d.is_empty()).map(|d| match d.as_str() {
                    "auto" => DeviceSetting::Auto,
                    "cpu" => DeviceSetting::Cpu,
                    _ => DeviceSetting::Device(d),
                });
                let before = self.loaded.clone();
                let settings = self.refresh_model();
                // An unchanged selection sends no status of its own.
                if self.loaded == before {
                    self.send_status();
                }
                self.send_options(&settings);
            }
        }
    }

    fn send_options(&self, settings: &Settings) {
        let store = ModelStore::new(settings.models_dir());
        let models = catalog::entries()
            .into_iter()
            .filter(|entry| store.state(entry).is_usable())
            .map(|entry| ModelChoice {
                id: entry.id().to_owned(),
                label: entry.to_string(),
                bytes: entry.bytes,
            })
            .collect();
        let auto_device = self.lock().devices.as_deref().map(|devices| {
            devices::device_label(devices::resolve(
                &DeviceSetting::Auto,
                settings.backend.measured.as_ref(),
                devices,
            ))
        });
        let devices = self
            .lock()
            .devices
            .iter()
            .flatten()
            .filter(|d| d.kind != DeviceKind::Cpu)
            .map(|d| DeviceChoice {
                name: d.name.clone(),
                description: d.description.clone(),
                kind: match d.kind {
                    DeviceKind::Gpu => "gpu",
                    DeviceKind::IntegratedGpu => "integrated_gpu",
                    DeviceKind::Npu => "npu",
                    _ => "other",
                },
                memory_free: d.memory_free,
            })
            .collect();
        self.send(&Response::Options {
            models,
            devices,
            app_model: settings
                .model
                .as_deref()
                .and_then(catalog::find_entry)
                .map(|entry| entry.to_string()),
            app_device: device_setting_name(&settings.backend.device),
            auto_device,
            model: self.model_choice.clone(),
            device: self.device_choice.as_ref().map(device_setting_name),
        });
    }

    /// Loads the model selected in the app's settings, unless it is already loaded. Returns the
    /// settings.
    fn refresh_model(&mut self) -> Settings {
        let settings = Settings::read();
        let selected = self.selected_model(&settings);
        let device = self
            .device_choice
            .clone()
            .unwrap_or_else(|| settings.backend.device.clone());
        let model = selected.as_ref().map(|(_, label)| label.clone());
        let wanted = selected.map(|(path, _)| (path, device));
        // After an error (a missing file, a failed load) the same selection is tried again:
        // the model may have been downloaded since, or memory freed.
        if self.loaded.as_ref() == Some(&wanted) && self.lock().status.state != "error" {
            return settings;
        }
        self.loaded = Some(wanted.clone());
        let (devices, runtime_error) = {
            let shared = self.lock();
            (shared.devices.clone(), shared.runtime_error.clone())
        };
        if let Some(error) = runtime_error {
            self.set_status(Status {
                state: "error",
                model,
                device: None,
                message: Some(error),
            });
            return settings;
        }
        let Some((path, device_setting)) = wanted else {
            self.lock().pending_loads += 1;
            self.worker.unload();
            self.set_status(Status {
                state: "no_model",
                model: None,
                device: None,
                message: None,
            });
            return settings;
        };
        if !path.is_file() {
            self.set_status(Status {
                state: "error",
                model,
                device: None,
                message: Some(format!("model file not found: {}", path.display())),
            });
            return settings;
        }
        // The host does not measure devices; it uses what the app measured.
        let device = devices::resolve(
            &device_setting,
            settings.backend.measured.as_ref(),
            devices.as_deref().unwrap_or_default(),
        );
        let device_label = devices::device_label(device);
        app_log!("loading {} on {device_label}", path.display());
        self.set_status(Status {
            state: "loading",
            model,
            device: Some(device_label),
            message: None,
        });
        self.lock().pending_loads += 1;
        self.worker.load(LoadRequest {
            path,
            model: devices::model_options(device),
            session: devices::session_options(device),
        });
        settings
    }

    fn translate(
        &mut self,
        id: u64,
        input: Input,
        target: Option<String>,
        source: Option<String>,
        style: Option<String>,
    ) {
        let settings = self.refresh_model();
        let error = |code, message: String| Response::Error {
            id: Some(id),
            code,
            message,
        };
        let status = self.lock().status.clone();
        match status.state {
            "no_model" => {
                return self.send(&error("no_model", "no model is selected in the app".into()));
            }
            "error" => {
                let code = if self
                    .loaded
                    .as_ref()
                    .and_then(Option::as_ref)
                    .is_some_and(|(path, _)| !path.is_file())
                {
                    "model_missing"
                } else if self.lock().runtime_error.is_some() {
                    "runtime_failed"
                } else {
                    "load_failed"
                };
                return self.send(&error(code, status.message.unwrap_or_default()));
            }
            _ => {}
        }

        let target = match target.as_deref() {
            None | Some("auto") => {
                let japanese = match &input {
                    Input::Text(text) => appdata::looks_japanese(text),
                    Input::Segments(segments) => appdata::looks_japanese(&segments.concat()),
                };
                if japanese { "en" } else { "ja" }
            }
            Some(code) => code,
        };
        let options = match translation_options(target, source.as_deref(), style.as_deref()) {
            Ok(mut options) => {
                options.glossary = glossary::parse(&settings.glossary);
                options
            }
            Err(e) => return self.send(&error("bad_request", e)),
        };
        let target = options.target.to_string();
        let document = settings
            .document
            .options(appdata::cut_marker(settings.ui_language.locale()).to_owned());

        // Hold the lock while submitting, so the job's events wait until it is recorded.
        let mut shared = self.lock();
        if let Some((_, previous)) = shared.job.take() {
            self.send(&Response::Done {
                id: previous,
                tokens: 0,
                cut: 0,
                stopped: true,
                cancelled: true,
            });
        }
        shared.output.clear();
        let job = match input {
            Input::Text(text) => self.worker.translate(options, document, text),
            Input::Segments(segments) => {
                self.worker.translate_segments(options, document, segments)
            }
        };
        shared.job = Some((job, id));
        self.send(&Response::Started { id, target });
    }
}

impl Host {
    /// The model file to use and its label: `PLAMO_MODEL` (for development), else the
    /// extension's choice while it is downloaded, else the app's selection.
    fn selected_model(&self, settings: &Settings) -> Option<(PathBuf, String)> {
        if let Some(path) = std::env::var_os("PLAMO_MODEL") {
            let path = PathBuf::from(path);
            let label = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            return Some((path, label));
        }
        let store = ModelStore::new(settings.models_dir());
        let chosen = self
            .model_choice
            .as_deref()
            .and_then(catalog::find_entry)
            .filter(|entry| store.state(entry).is_usable());
        let entry = chosen.or_else(|| catalog::find_entry(settings.model.as_deref()?))?;
        Some((store.path(entry), entry.to_string()))
    }
}

/// A device setting as the protocol names it: `auto`, `cpu`, or the device name.
fn device_setting_name(setting: &DeviceSetting) -> String {
    match setting {
        DeviceSetting::Auto => "auto".into(),
        DeviceSetting::Cpu => "cpu".into(),
        DeviceSetting::Device(name) => name.clone(),
    }
}

fn translation_options(
    target: &str,
    source: Option<&str>,
    style: Option<&str>,
) -> Result<TranslationOptions, String> {
    let target = LangCode::new(target).map_err(|e| e.to_string())?;
    let mut options = TranslationOptions::new(target);
    options.source = source
        .filter(|s| !s.is_empty() && *s != "auto")
        .map(LangCode::new)
        .transpose()
        .map_err(|e| e.to_string())?;
    if options.target.is_japanese() {
        options.form = match style {
            Some("polite") => Some(Form::Polite),
            Some("plain") => Some(Form::Plain),
            _ => None,
        };
    }
    Ok(options)
}

/// Handles a worker event on the worker's thread.
fn on_event(shared: &(Mutex<Shared>, Condvar), out: &Output, event: Event) {
    let (lock, ready) = shared;
    let mut s = lock.lock().unwrap_or_else(|e| e.into_inner());
    let current = |s: &Shared, job: JobId| s.job.filter(|(j, _)| *j == job).map(|(_, id)| id);
    match event {
        Event::RuntimeFailed(error) => {
            app_log!("inference runtime failed: {error}");
            s.runtime_error = Some(error.clone());
            s.status = Status {
                state: "error",
                model: s.status.model.clone(),
                device: None,
                message: Some(error.clone()),
            };
            send(out, &status_message(&s.status));
            if let Some((_, id)) = s.job.take() {
                send(
                    out,
                    &Response::Error {
                        id: Some(id),
                        code: "runtime_failed",
                        message: error,
                    },
                );
            }
            ready.notify_all();
        }
        Event::Devices(devices) => {
            s.devices = Some(devices);
            ready.notify_all();
        }
        Event::Loaded(_) | Event::LoadFailed(_) | Event::Unloaded if s.pending_loads > 1 => {
            // A newer load or unload follows.
            s.pending_loads -= 1;
        }
        Event::Unloaded => {
            // The status says no_model already.
            s.pending_loads = 0;
        }
        Event::Loaded(_) => {
            s.pending_loads = 0;
            app_log!("model loaded");
            s.status.state = "ready";
            s.status.message = None;
            send(out, &status_message(&s.status));
        }
        Event::LoadFailed(error) => {
            s.pending_loads = 0;
            app_log!("loading the model failed: {error}");
            s.status.state = "error";
            s.status.message = Some(error);
            send(out, &status_message(&s.status));
        }
        Event::Chunk {
            job, index, count, ..
        } => {
            if let Some(id) = current(&s, job) {
                send(out, &Response::Progress { id, index, count });
            }
        }
        Event::Segment { job, index, text } => {
            if let Some(id) = current(&s, job) {
                send(out, &Response::Segment { id, index, text });
            }
        }
        Event::Token { job, text } => {
            if let Some(id) = current(&s, job) {
                s.output.push_str(&text);
                send(out, &Response::Text { id, text });
            }
        }
        Event::Rewind { job, len } => {
            if let Some(id) = current(&s, job)
                && s.output.is_char_boundary(len)
            {
                s.output.truncate(len);
                let length = s.output.encode_utf16().count();
                send(out, &Response::Rewind { id, length });
            }
        }
        Event::Cut { index, source, .. } => {
            app_log!(
                "chunk {}: output kept repeating and was cut (source bytes {}..{})",
                index + 1,
                source.0,
                source.1
            );
        }
        Event::Finished { job, stats } => {
            if let Some(id) = current(&s, job) {
                s.job = None;
                send(
                    out,
                    &Response::Done {
                        id,
                        tokens: stats.generated_tokens,
                        cut: stats.cut,
                        stopped: stats.stop_reason != StopReason::Finished,
                        cancelled: stats.stop_reason == StopReason::Cancelled,
                    },
                );
            }
        }
        Event::Failed { job, error } => {
            if let Some(id) = current(&s, job) {
                s.job = None;
                send(
                    out,
                    &Response::Error {
                        id: Some(id),
                        code: "failed",
                        message: error,
                    },
                );
            }
        }
        Event::LoadProgress(_)
        | Event::Retry { .. }
        | Event::Measuring { .. }
        | Event::Measured(_) => {}
    }
}
