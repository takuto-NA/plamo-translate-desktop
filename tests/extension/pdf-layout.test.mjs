// Tests extension/pdf-layout.js: the paragraphs found from the positions of a page's text.
//
// usage: node tests/extension/pdf-layout.test.mjs
import { alignment, blocksOf, fontKind, isMath, linesOf, normalize, partsOf, worthTranslating } from "../../extension/pdf-layout.js";

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
};

// A page 600 points wide, with 10-point text on lines 12 points apart.
const PAGE = 600;
/** A piece of text from `x` to `right` on the baseline `y`. */
const piece = (str, x, right, y, more = {}) => {
  const size = more.size ?? 10;
  return { str, x, y, w: right - x, size, top: y - 0.8 * size, bottom: y + 0.2 * size, font: "f1", bold: false, italic: false, mono: false, serif: true, math: false, ...more };
};
/** The texts of the paragraphs found in `items`. */
const paragraphs = (items) => blocksOf(linesOf(items), PAGE).map((b) => partsOf(b).map((p) => p.text ?? "□").join(""));

check(
  "lines of a paragraph are joined; an indented line starts the next",
  paragraphs([
    piece("The first paragraph begins here and", 100, 500, 100),
    piece("ends on its second line.", 100, 300, 112),
    piece("The second one is indented and runs", 115, 500, 124),
    piece("on below it.", 100, 200, 136),
  ]),
  ["The first paragraph begins here and ends on its second line.", "The second one is indented and runs on below it."],
);

check(
  "a word hyphenated at the end of a line is joined again",
  paragraphs([piece("This is a rather compli-", 100, 500, 100), piece("cated sentence, a well-", 100, 500, 112), piece("Known one.", 100, 300, 124)]),
  ["This is a rather complicated sentence, a well- Known one."],
);

check(
  "no space between the lines of CJK text",
  paragraphs([piece("吾輩は猫である。名前はまだ", 100, 500, 100), piece("無い。", 100, 160, 112)]),
  ["吾輩は猫である。名前はまだ無い。"],
);

check(
  "a larger gap, another size, or a bold line starts a paragraph",
  paragraphs([
    piece("Results", 100, 160, 100, { bold: true }),
    piece("The text below the heading is", 100, 500, 112),
    piece("one paragraph.", 100, 200, 124),
    piece("After a gap comes another.", 100, 400, 150),
    piece("A note in small print.", 100, 300, 160, { size: 7 }),
  ]),
  ["Results", "The text below the heading is one paragraph.", "After a gap comes another.", "A note in small print."],
);

check(
  "columns side by side are apart: a wide gap ends a line",
  paragraphs([
    piece("Left column, line one", 50, 280, 100),
    piece("Right column, line one", 320, 550, 100),
    piece("left column, line two.", 50, 280, 112),
    piece("right column, line two.", 320, 550, 112),
  ]),
  // In the order of the PDF's text, which a real PDF gives column by column.
  ["Left column, line one", "Right column, line one", "left column, line two.", "right column, line two."],
);

check(
  "a centered paragraph is one, its short last line too",
  paragraphs([
    piece("Provided proper attribution is provided, Google hereby grants permission to", 120, 480, 100),
    piece("reproduce the tables and figures in this paper solely for use in journalistic or", 121, 479, 112),
    piece("scholarly works.", 260, 340, 124),
  ]),
  [
    "Provided proper attribution is provided, Google hereby grants permission to reproduce the tables and figures in this paper solely for use in journalistic or scholarly works.",
  ],
);

{
  const blocks = blocksOf(
    linesOf([piece("A Title That Is Long Enough to Need", 150, 450, 100, { size: 14 }), piece("Two Lines", 260, 340, 116, { size: 14 })]),
    PAGE,
  );
  check("a centered title of two lines is one paragraph, centered", [blocks.length, alignment(blocks[0], PAGE)], [1, "center"]);
}

check(
  "short centered lines below one another stay apart (a name, a place)",
  paragraphs([piece("Google Brain", 270, 330, 100), piece("Department of Computer Science, Toronto", 190, 410, 112)]),
  ["Google Brain", "Department of Computer Science, Toronto"],
);

check(
  "numbered headings below one another are each their own",
  paragraphs([piece("3. Deep Residual Learning", 100, 300, 100, { bold: true, size: 12 }), piece("3.1. Residual Learning", 100, 280, 116, { bold: true, size: 11 })]),
  ["3. Deep Residual Learning", "3.1. Residual Learning"],
);

check(
  "a list item starts a paragraph",
  paragraphs([piece("Two things matter:", 100, 300, 100), piece("• the first, and", 100, 300, 112), piece("• the second.", 100, 300, 124)]),
  ["Two things matter:", "• the first, and", "• the second."],
);

check(
  "a formula on a line of its own is left out, and ends the paragraph",
  paragraphs([
    piece("We compute the outputs as:", 100, 400, 100),
    piece("QKT", 250, 300, 118, { font: "f2", math: true }),
    piece("where the keys are packed too.", 100, 400, 136),
  ]),
  ["We compute the outputs as:", "where the keys are packed too."],
);

check(
  "a formula inside a paragraph is a part of its own, with the digits beside it",
  paragraphs([
    piece("values of dimension ", 100, 200, 100),
    piece("d", 200, 206, 100, { font: "f2", math: true }),
    piece("v", 206, 210, 102, { size: 7 }),
    piece(" are used in every layer.", 212, 400, 100),
  ]),
  ["values of dimension □ are used in every layer."],
);

{
  const blocks = blocksOf(
    linesOf([
      piece("A justified paragraph fills its lines to", 100, 500, 100),
      piece("the right edge, all of them except for", 100, 500, 112),
      piece("the last.", 100, 160, 124),
    ]),
    PAGE,
  );
  check("alignment: justified", alignment(blocks[0], PAGE), "justify");
  check("alignment: a line in the middle of the page", alignment(blocksOf(linesOf([piece("Abstract", 270, 330, 100)]), PAGE)[0], PAGE), "center");
  check("alignment: a line at the left", alignment(blocksOf(linesOf([piece("1 Introduction", 100, 200, 100)]), PAGE)[0], PAGE), "left");
}

{
  const worth = (str, size = 10) => {
    const block = blocksOf(linesOf([piece(str, 100, 300, 100, { size })]), PAGE)[0];
    return worthTranslating(partsOf(block), block, 10);
  };
  check("worth translating: a sentence", worth("The model is trained."), true);
  check("worth translating: not numbers", worth("0.25 1.50 3.75"), false);
  check("worth translating: not a small label of a figure", worth("Linear", 6), false);
  check("worth translating: a heading in the text's size", worth("Abstract"), true);
  check("worth translating: Japanese", worth("概要と背景", 6), true);
}

check("font: Times is serif", fontKind("ABCDEF+NimbusRomNo9L-Regu"), { mono: false, serif: true, bold: false, italic: false });
check("font: Computer Modern bold", fontKind("CYUPTR+CMBX10"), { mono: false, serif: true, bold: true, italic: false });
check("font: a sans CJK font is not serif, whatever it says", fontKind("AAAAAA+NotoSansCJKjp-Regular", { serif: true }), { mono: false, serif: false, bold: false, italic: false });
check("font: Mincho is serif", fontKind("MS-Mincho"), { mono: false, serif: true, bold: false, italic: false });
check("font: monospace by its name", fontKind("JQUDPS+NimbusMonL-Regu"), { mono: true, serif: false, bold: false, italic: false });
check("font: TeX's typewriter", fontKind("XEXHSJ+SFTT1000").mono, true);
check("font: monospace by the PDF's flag, for an unknown name", fontKind("ABCDEF+TT12", { mono: true }).mono, true);
check("font: a Roman font is not monospace, whatever it says", fontKind("WMCLTX+CMBX10", { mono: true }).mono, false);
check("font: an unknown name follows the PDF's flags", fontKind("KGMNOB+TT93o00", { serif: true, bold: true }), { mono: false, serif: true, bold: true, italic: false });
check("font: italic and bold by name", fontKind("Arial-BoldItalicMT"), { mono: false, serif: false, bold: true, italic: true });

check("math: by the font", isMath("YYBXCM+CMMI10", "x"), true);
check("math: by the symbol", isMath("Arial", "≤"), true);
check("math: not a word", isMath("Arial", "alpha"), false);

check("normalize: radicals become the characters they look like", normalize("⽣まれて⾒た⼈"), "生まれて見た人");
check("normalize: ligatures become letters", normalize("ﬁnal ﬂow"), "final flow");
check("normalize: other text stays", normalize("生 ① ｱ ㌔"), "生 ① ｱ ㌔");

console.log(failures ? `${failures} failed` : "all ok");
process.exit(failures ? 1 : 0);
