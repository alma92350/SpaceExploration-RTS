/* ============================================================
   BROWSER SMOKE TEST — does the game actually run in a browser?

   WHY THIS EXISTS, given 2500 passing tests.

   There is no build step: the files in the repo are the files the browser loads. That is the
   project's best property and its sharpest edge. `node --test` runs the engine headlessly and
   test/static-integrity.test.js catches STATIC breakage — a syntax error, an import pointing at a
   moved file, a `getElementById` for an id that does not exist. Neither can catch a page that
   parses perfectly, imports cleanly, and then throws on load. That failure mode is a blank white
   screen, and the way it has been found here before is a human opening the page and clicking.

   This closes that gap: boot the real page in real Chromium, start a real match, click things,
   and fail on any uncaught error. It is deliberately shallow — it asserts the game RUNS, not that
   it is correct. Correctness is the unit suite's job, and it is much better at it.

   WHY IT IS NOT PART OF `npm test`. Driving a browser needs Playwright, and this project ships
   with no dependencies and no build step. Two things keep that promise intact:

     - It lives in tools/, so `node --test test/*.test.js` never globs it. `npm test` stays
       offline, dependency-free and fast.
     - Playwright is fetched at RUN time via npx, never added to package.json — exactly the
       precedent the CI type-check step set for TypeScript, and for the same reason: a tool the
       build uses is not a thing the game depends on.

   RUNNING IT

     npm run smoke                    # CI does this; fetches playwright-core via npx
     node tools/smoke.js              # if playwright-core is already resolvable
     node tools/smoke.js --keep-open  # leave the browser open (headed) to watch it

   It starts and stops its own server, so there is nothing to set up. Exits non-zero on the first
   uncaught page error, on a console error, or on any step not reaching the state it expects.
   ============================================================ */

"use strict";

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT) || 8137;   // not 8080: never fight a dev server the author left running
const URL_ = `http://localhost:${PORT}/index.html`;
const HEADED = process.argv.includes("--keep-open");

/* ---------- finding Chromium ----------
   A CI runner that just ran `npx playwright install chromium` has it in the default cache and
   Playwright finds it alone. A pre-provisioned image may instead point PLAYWRIGHT_BROWSERS_PATH at
   its own directory with a versioned subfolder, which Playwright only auto-resolves when its own
   version matches. Falling back to whatever chrome binary is actually in there keeps this working
   in both places rather than only the one it was written on. */
async function launchChromium(chromium) {
  try {
    return await chromium.launch({ headless: !HEADED });
  } catch (err) {
    const { existsSync, readdirSync } = await import("node:fs");
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!base || !existsSync(base)) throw err;
    for (const entry of readdirSync(base).filter(d => d.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const exe = join(base, entry, rel);
        if (existsSync(exe)) return await chromium.launch({ headless: !HEADED, executablePath: exe });
      }
    }
    throw err;
  }
}

function startServer() {
  const proc = spawn(process.execPath, [join(ROOT, "tools", "serve.js"), String(PORT)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  // Resolve on the server's own ready line rather than a fixed sleep — a slow box would otherwise
  // race the first navigation and fail for a reason that has nothing to do with the game.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the dev server did not start within 10s on port ${PORT}`)), 10000);
    proc.stdout.on("data", d => { if (String(d).includes("open")) { clearTimeout(timer); resolve(proc); } });
    proc.on("error", e => { clearTimeout(timer); reject(e); });
    proc.on("exit", c => { clearTimeout(timer); reject(new Error(`the dev server exited early (code ${c})`)); });
  });
}

const steps = [];
const check = (name, ok, detail = "") => {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function main() {
  let chromium;
  try {
    ({ chromium } = createRequire(join(ROOT, "package.json"))("playwright-core"));
  } catch {
    try { ({ chromium } = await import("playwright-core")); }
    catch {
      console.error("playwright-core is not resolvable.\n" +
        "This is deliberately NOT a dependency — run it the way CI does:\n" +
        "  npm run smoke\n");
      process.exit(2);
    }
  }

  const server = await startServer();
  const browser = await launchChromium(chromium);
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // Any uncaught throw or console error is a failure. No allow-list: a page that logs errors in
  // normal operation trains everyone to ignore them, which is how the real one gets missed. (The
  // one known offender, the browser's unprompted /favicon.ico request, is fixed in index.html
  // with a data URI rather than excused here.)
  const errors = [];
  page.on("pageerror", e => errors.push(`uncaught: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("requestfailed", r => errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on("response", r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });

  try {
    await page.goto(URL_, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);

    check("the page loads and titles itself", (await page.title()) === "Stellar Frontier: RTS");
    check("main.js's module graph actually executed",
      (await page.evaluate(() => performance.getEntriesByType("resource").filter(r => r.name.endsWith(".js")).length)) > 50);
    check("the setup screen offers a game mode", await page.isVisible("text=⚔ Skirmish"));

    // Start a real match. Clicking a world card is what launches it (setup.js renderMapSelect).
    await page.click("text=⚔ Skirmish");
    await page.waitForTimeout(400);
    await page.click(".map-card");
    await page.waitForTimeout(2200);

    const canvasUp = await page.evaluate(() => { const c = document.querySelector("canvas"); return !!(c && c.offsetParent && c.width > 0); });
    check("a skirmish starts and the canvas is live", canvasUp);

    // The clock advancing is the cheapest proof the fixed-timestep loop is actually stepping —
    // a frozen sim renders a perfectly convincing still frame.
    const clockOf = () => page.evaluate(() => (document.body.innerText.match(/\d+:\d\d/) || ["0:00"])[0]);
    const t0 = await clockOf();
    await page.waitForTimeout(2500);
    const t1 = await clockOf();
    check("the simulation is running", t0 !== t1, `${t0} → ${t1}`);

    const box = await (await page.$("canvas")).boundingBox();

    // Drag-select: inputCommands.js applyBoxSelection -> hudSelection.js renderSelectionSummary
    // and renderBuildMenu. Nothing headless clicks, so this is the only check on that path.
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 900, box.y + 700, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const panel = await page.evaluate(() => (document.querySelector("#selectionPanel")?.innerText || "").trim());
    check("drag-select builds a selection panel", /worker|hp/i.test(panel), panel.split("\n")[0]?.slice(0, 48));

    // Right-click: inputCommands.js commandAt, the 92-line order ladder.
    await page.mouse.click(box.x + 600, box.y + 420, { button: "right" });
    await page.waitForTimeout(500);
    check("a right-click order is dispatched", true);

    // Keyboard routes through input.js's own handler, which kept the stateful half.
    await page.keyboard.press("q");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("keyboard commands are handled", true);

    check("the browser console stayed clean", errors.length === 0, errors.slice(0, 4).join(" | "));
  } catch (err) {
    check("the run completed without throwing", false, err.message);
  } finally {
    if (!HEADED) { await browser.close(); server.kill(); }
    else console.log("\n--keep-open: browser and server left running; Ctrl+C to stop.");
  }

  const failed = steps.filter(s => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} checks passed`);
  if (errors.length) {
    console.log(`\n${errors.length} browser error(s):`);
    for (const e of errors.slice(0, 20)) console.log("  !!", e);
  }
  if (!HEADED) process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
