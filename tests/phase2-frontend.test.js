import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [html, app] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
]);

test("Phase 2 Web Explorer UI is present", () => {
  assert.match(html, /Phase 4 · Live/);
  assert.match(html, /id="web-explorer-form"/);
  assert.match(html, /id="explorer-url"/);
  assert.match(html, /id="explorer-result"/);
});

test("Phase 4 interface includes five job sources, statuses, controls, and results", () => {
  assert.match(html, /id="job-scout-form"/);
  assert.match(html, /Find Junior Opportunities/);
  assert.match(html, /Clear Results/);
  assert.match(html, /Top 5 Junior Opportunities/);
  assert.equal((html.match(/id="job-source-[1-5]"/g) || []).length, 5);
  assert.equal((html.match(/id="job-source-status-[1-5]"/g) || []).length, 5);
  assert.match(app, /fetch\("\/api\/jobs\/scan"/);
  assert.match(app, /Open Job Posting/);
  assert.doesNotMatch(app, /\/api\/jobs\/(?:crawl|search|batch)/);
});

test("Web Explorer reuses the single-page scrape route", () => {
  assert.match(app, /explorerForm\.addEventListener\("submit", explorePage\)/);
  assert.match(app, /fetch\("\/api\/scrape"/);
  assert.doesNotMatch(app, /\/api\/(?:crawl|search|batch)/);
});
