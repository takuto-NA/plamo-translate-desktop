//! Prints each double copy's text until interrupted: `cargo run -p desktop --example watch`.

fn main() -> std::io::Result<()> {
    let _watcher = desktop::clipboard::watch(|text| {
        println!("double copy: {text:?}");
    })?;
    println!("watching the clipboard; press Ctrl+C twice in any application");
    loop {
        std::thread::park();
    }
}
