import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine } from "./harness.mjs";

// Bangla cards drew boxes in production for a day while every check passed, because the checks ran in a Docker image
// that installs Noto and production turned out to be a plain Node runtime with no Bengali font at all. The fonts now
// travel with the code, and the engine reads text overlays from that directory before it looks anywhere else.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let eng;
before(async () => { eng = await startEngine(); });
after(async () => { await eng?.stop(); });

test("the fonts the overlays name are in the repo, and the engine reads them from there", async () => {
  for (const f of ["NotoSansBengali-Regular.ttf", "NotoSansBengali-Bold.ttf", "NotoSans-Regular.ttf", "NotoSans-Bold.ttf"]) {
    const bytes = await readFile(join(ROOT, "fonts", f));
    assert.equal(bytes.readUInt32BE(0), 0x00010000, `${f} is a TrueType font`);
    assert.ok(bytes.length > 100000, `${f} is the whole font, not a stub (${bytes.length} bytes)`);
  }
  const { fonts } = await eng.api("GET", "/health");
  assert.equal(basename(fonts), "fonts", `libass is pointed at the repo's fonts directory, not ${fonts}`);
});
