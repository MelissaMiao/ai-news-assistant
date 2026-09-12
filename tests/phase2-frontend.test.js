import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [html, app] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
]);

test("Phase 2 Web Explorer UI is present", () => {
  assert.match(html, /Phase 2 · Live/);
  assert.match(html, /id="web-explorer-form"/);
  assert.match(html, /id="explorer-url"/);
  assert.match(html, /id="explorer-result"/);
});

test("Web Explorer reuses the single-page scrape route", () => {
  assert.match(app, /explorerForm\.addEventListener\("submit", explorePage\)/);
  assert.match(app, /fetch\("\/api\/scrape"/);
  assert.doesNotMatch(app, /\/api\/(?:crawl|search|batch)/);
});
