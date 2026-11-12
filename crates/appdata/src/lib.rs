//! What the desktop app and its browser host share: settings, file locations, logging, device
//! selection, and the few texts both produce.

pub mod applog;
pub mod devices;
pub mod glossary;
pub mod settings;

/// Whether `text` is written in Japanese: it has kana, and kana and kanji make up a tenth of
/// its letters or more. Kanji alone is ambiguous with Chinese, so it takes kana; a text in
/// another language that quotes a few Japanese words (an English manual with `こんにちは` in an
/// example) is not Japanese. A Japanese sentence full of Latin names still is: `npm install
/// --save-dev typescript を実行` is at the limit.
/// "Japanese ⇄ English" translates such text into English and everything else into Japanese.
/// `resolveTarget` in the extension's `translator.js` goes by the same rule.
pub fn looks_japanese(text: &str) -> bool {
    let (mut kana, mut kanji, mut other) = (0usize, 0usize, 0usize);
    for c in text.chars() {
        match c {
            '\u{3040}'..='\u{309f}' | '\u{30a0}'..='\u{30ff}' | '\u{31f0}'..='\u{31ff}' => {
                kana += 1
            }
            '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' => kanji += 1,
            c if c.is_alphabetic() => other += 1,
            _ => {}
        }
    }
    kana > 0 && (kana + kanji) * 9 >= other
}

/// Text marking where a translation was cut after it kept repeating, in the UI language
/// (`en` or `ja`, see [`settings::UiLanguage::locale`]).
pub fn cut_marker(locale: &str) -> &'static str {
    match locale {
        "ja" => "〔繰り返しが止まらなかったため、この文の訳を打ち切りました〕",
        _ => " [translation cut off here: it kept repeating]",
    }
}

#[cfg(test)]
mod tests {
    use super::looks_japanese;

    #[test]
    fn japanese_takes_kana_and_a_share_of_the_letters() {
        assert!(looks_japanese("会議は来週です"));
        assert!(looks_japanese("カタカナ"));
        assert!(!looks_japanese("Hello, world"));
        // Kanji only: could be Chinese.
        assert!(!looks_japanese("你好世界"));
        // Japanese with Latin names in it.
        assert!(looks_japanese("Rust と GPUI で実装する"));
        assert!(looks_japanese("npm install --save-dev typescript を実行"));
        // English that quotes Japanese.
        let manual = "Two command-line examples run the engine without the GUI. The first \
            translates a text into English, the second lists the models: translate --to en \
            \"こんにちは\"";
        assert!(!looks_japanese(manual));
        assert!(!looks_japanese(""));
    }
}
