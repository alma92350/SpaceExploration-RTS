import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// This project has NO build step — the files in the repo are the files the browser loads. So a
// syntax slip, a mistyped element id, or an import pointing at a moved file isn't caught by a
// compiler; it's a blank white screen the moment someone opens index.html. These are cheap
// static guards that turn each of those silent breakages into a failing test.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every JS file the app ships: the root modules + the engine. (test/ is excluded — `node --test`
// already parses and runs it.)
function shippedJs() {
  const files = readdirSync(root).filter(f => f.endsWith(".js")).map(f => join(root, f));
  for (const f of readdirSync(join(root, "engine")))
    if (f.endsWith(".js")) files.push(join(root, "engine", f));
  return files;
}

test("every shipped .js file parses (no syntax errors reach the browser)", () => {
  const broken = [];
  for (const file of shippedJs()) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (e) {
      broken.push(`${file.replace(root + "/", "")}: ${String(e.stderr || e.message).split("\n")[0]}`);
    }
  }
  assert.deepEqual(broken, [], "syntax error(s) in shipped JS:\n" + broken.join("\n"));
});

test("every getElementById reference resolves to a real element id", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

  // Some elements are built at runtime (e.g. the update banner) rather than living in index.html;
  // a JS `el.id = "foo"` assignment is a legitimate source of an id too. Allow those.
  const dynamicIds = new Set();
  const jsFiles = shippedJs();
  for (const f of jsFiles)
    for (const m of readFileSync(f, "utf8").matchAll(/\.id\s*=\s*["']([^"']+)["']/g)) dynamicIds.add(m[1]);

  const dangling = [];
  for (const f of jsFiles) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/getElementById\(["']([^"']+)["']\)/g)) {
      const id = m[1];
      if (!htmlIds.has(id) && !dynamicIds.has(id)) dangling.push(`${f.replace(root + "/", "")} → #${id}`);
    }
  }
  assert.deepEqual(dangling, [],
    "getElementById targets that exist in no HTML and are never created in JS (typo or removed element):\n" +
    dangling.join("\n"));
});

test("every relative import points at a file that exists", () => {
  const missing = [];
  const spec = /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const f of shippedJs()) {
    const src = readFileSync(f, "utf8");
    const dir = dirname(f);
    for (const m of src.matchAll(spec)) {
      const path = m[1] || m[2];
      if (!path || !path.startsWith(".")) continue;    // bare/absolute specifiers aren't ours to resolve
      if (!existsSync(resolve(dir, path)))
        missing.push(`${f.replace(root + "/", "")} → ${path}`);
    }
  }
  assert.deepEqual(missing, [], "import(s) pointing at a file that no longer exists:\n" + missing.join("\n"));
});
