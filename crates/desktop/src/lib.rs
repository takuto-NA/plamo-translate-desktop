//! Integration with the desktop outside the app's window.
//!
//! - [`clipboard`]: a double copy (Ctrl+C or ⌘C pressed twice) in any application.
//! - [`instance`]: one running instance per user. Starting the app again shows the running one,
//!   and on Windows its notification-area icon opens or quits it.
//!
//! Nothing here needs a permission: no keyboard hook and no accessibility access.

pub mod clipboard;
pub mod instance;

#[cfg(windows)]
mod win;
