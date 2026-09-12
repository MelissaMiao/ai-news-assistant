import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import handler from "../api/scrape.js";

const originalFetch = global.fetch;
const originalApiKey = process.env.FIRECRAWL_API_KEY;

before(() => {
  process.env.FIRECRAWL_API_KEY = "fc-test-key";
});

after(() => {
  global.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = originalApiKey;
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function runScrape(url, payload, onRequest = () => {}) {
  global.fetch = async (_endpoint, options) => {
    onRequest(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  };

  const response = responseRecorder();
  await handler({ method: "POST", body: { url } }, response);
  return response;
}

test("TechCrunch uses enhanced proxy mode", async () => {
  let requestBody;
  const response = await runScrape(
    "https://techcrunch.com/example",
    {
      success: true,
      data: {
        markdown: "Readable article content.",
        metadata: { title: "Example", sourceURL: "https://techcrunch.com/example" },
      },
    },
    (body) => {
      requestBody = body;
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(requestBody.proxy, "enhanced");
  assert.deepEqual(requestBody.location, { country: "US", languages: ["en-US"] });
  assert.equal(requestBody.waitFor, 1_500);
});

test("Cloudflare verification content is rejected", async () => {
  const response = await runScrape("https://example.com/article", {
    success: true,
    data: {
      markdown:
        "Verification failed\n[Troubleshoot](https://challenges.cloudflare.com/cdn-cgi/challenge-platform/test)",
      metadata: { title: "Example article" },
    },
  });

  assert.equal(response.statusCode, 502);
  assert.match(response.body.error, /blocked automated reading/i);
  assert.doesNotMatch(response.body.error, /cloudflare\.com/i);
});

test("ordinary publishers retain automatic proxy behavior", async () => {
  let requestBody;
  const response = await runScrape(
    "https://www.wired.com/story/example/",
    {
      success: true,
      data: {
        markdown: "Readable article content.",
        metadata: { title: "Example" },
      },
    },
    (body) => {
      requestBody = body;
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(requestBody.proxy, undefined);
});

test("TechCrunch boilerplate and markdown links are removed", async () => {
  const response = await runScrape("https://techcrunch.com/example", {
    success: true,
    data: {
      markdown: [
        "[Skip to content](https://techcrunch.com/example/#content)",
        "",
        "Disrupt 2026: [25% off tickets](https://techcrunch.com/events)",
        "",
        "![Robot image](https://techcrunch.com/robot.jpg)**Image Credits:** Example",
        "",
        "# Example article title",
        "",
        "[Reporter Name](https://techcrunch.com/author/reporter)",
        "",
        "3:58 PM PDT · September 11, 2026",
        "",
        "[Share on Facebook](https://facebook.com/share)[Share on X](https://x.com/share)",
        "",
        "The first real article paragraph includes a [useful link](https://example.com).",
        "",
        "The second real article paragraph.",
        "",
        "AI news roundup | Equity Podcast",
        "",
        "0 seconds of 38 minutes, 5 secondsVolume 0%",
      ].join("\n"),
      metadata: { title: "Example article title" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.content,
    "The first real article paragraph includes a useful link.\n\nThe second real article paragraph.",
  );
});
