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

async function runValidation(body) {
  const response = responseRecorder();
  await handler({ method: "POST", body }, response);
  return response;
}

test("a missing Web Explorer URL gets a readable 400 response", async () => {
  const response = await runValidation({ url: "" });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "Enter a public webpage URL.");
});

test("non-web and private URLs are rejected", async () => {
  const nonWebResponse = await runValidation({ url: "ftp://example.com/file" });
  const privateResponse = await runValidation({ url: "http://localhost:3000/private" });

  assert.equal(nonWebResponse.statusCode, 400);
  assert.match(nonWebResponse.body.error, /http:\/\/ or https:\/\//i);
  assert.equal(privateResponse.statusCode, 400);
  assert.match(privateResponse.body.error, /public web pages/i);
});

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

test("unsafe metadata URLs fall back to the validated request URL", async () => {
  const response = await runScrape("https://example.com/article", {
    success: true,
    data: {
      markdown: "Readable article content.",
      metadata: { title: "Example", sourceURL: "javascript:alert(1)" },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.url, "https://example.com/article");
  assert.equal(response.body.domain, "example.com");
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
