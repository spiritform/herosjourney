/* Write the sheet templates to disk as real files.
 *
 * THE TABLE IN mockup.html IS STILL THE ONLY SOURCE. This does not hold a
 * second copy of the layouts or a second copy of the drawing — it lifts both
 * out of the page and runs them, so a file on disk can never disagree with the
 * thumbnail in the picker. Change a panel in mockup.html, run this again.
 *
 *   node tools/make-sheets.mjs      -> sheets/*.svg, each at its own ratio
 *   node tools/make-sheets.mjs 4    -> the same drawings at four megapixels
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(join(ROOT, "mockup.html"), "utf8");

/* Slice a definition out of the page by its opening line and the closing line
 * at the same indent. Crude on purpose: the alternative is a parser, and the
 * two things it has to find are both written at a known depth. */
function lift(startsWith, endsWith) {
  const i = page.indexOf(startsWith);
  if (i < 0) throw new Error(`not found in mockup.html: ${startsWith}`);
  const j = page.indexOf(endsWith, i);
  if (j < 0) throw new Error(`no end for: ${startsWith}`);
  return page.slice(i, j + endsWith.length);
}

const sheetsSrc = lift("var SHEETS = [", "\n  ];");
/* 04's storyboard is drawn by the same function off its own table, so it
 * is written out here too - the page the model is handed should be on
 * disk for both rungs, not just the one with a picker. */
const boardSrc = lift("var MODES = [", "\n  ];");
const inkSrc = lift("var SHEET_BG =", ";");
const sizeSrc = lift("function sheetSize(sheet, mp) {", "\n  }");
const drawSrc = lift("function sheetTemplate(sheet, W, H, bare) {", "\n  }");

const { SHEETS, MODES, sheetTemplate, sheetSize } = new Function(
  `${sheetsSrc}\n${boardSrc}\n${inkSrc}\n${sizeSrc}\n${drawSrc}\n` +
    `return { SHEETS, MODES, sheetTemplate, sheetSize };`
)();

/* no fixed size on the command line any more: each sheet has its own ratio,
 * so the argument is how many megapixels they all get. */
const MP = Number(process.argv[2]) || 2;

mkdirSync(join(ROOT, "sheets"), { recursive: true });

for (const sheet of [...SHEETS, ...MODES]) {
  const { W, H } = sheetSize(sheet, MP);
  const file = join(ROOT, "sheets", `${sheet.id}.svg`);
  writeFileSync(file, sheetTemplate(sheet, W, H) + "\n", "utf8");
  console.log(
    `  sheets/${sheet.id}.svg  ${sheet.ar}  ${W}x${H}  ${sheet.panels.length} panels  ` +
      sheet.panels.map((p) => p.label.join(" ")).join("  |  ")
  );
}
