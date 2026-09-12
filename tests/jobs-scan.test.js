import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import handler from "../api/jobs/scan.js";

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

function job(overrides = {}) {
  return {
    title: "Junior Data Analyst",
    employer: "Example Labs",
    location: "New York, NY",
    jobUrl: "/jobs/junior-data-analyst",
    postedDate: "September 12, 2026",
    employmentType: "Full time",
    description: "An entry-level role using data and AI tools with structured training.",
    juniorEvidence: ["Entry-level applicants and new graduates are welcome."],
    transferableSkills: ["Build data analysis and communication skills."],
    futureRelevantSignals: ["Work with AI-enabled analytics tools."],
    learningSignals: ["Structured onboarding and mentorship are provided."],
    seniorityWarnings: [],
    ...overrides,
  };
}

function successPayload(jobs) {
  return {
    success: true,
    data: {
      markdown: "Public careers page",
      json: { jobs },
      metadata: { title: "Careers" },
    },
  };
}

async function run(body, fetchImpl) {
  global.fetch = fetchImpl;
  const response = responseRecorder();
  await handler({ method: "POST", body }, response);
  return response;
}

test("one public source returns ranked jobs with exactly three evidence bullets", async () => {
  let firecrawlBody;
  const response = await run({ urls: ["https://jobs.example.com/openings"] }, async (_url, options) => {
    firecrawlBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => successPayload([job()]) };
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.sources[0].status, "extracted");
  assert.equal(response.body.jobs.length, 1);
  assert.equal(response.body.jobs[0].rank, 1);
  assert.equal(response.body.jobs[0].reasons.length, 3);
  assert.deepEqual(
    response.body.jobs[0].reasons.map((reason) => reason.heading),
    ["Accessible start", "Skills you can build", "Career exposure"],
  );
  assert.equal(response.body.jobs[0].description, undefined);
  assert.equal(response.body.jobs[0].markdown, undefined);
  assert.equal(firecrawlBody.url, "https://jobs.example.com/openings");
  assert.equal(firecrawlBody.formats[1].type, "json");
  assert.equal(firecrawlBody.formats[1].schema.properties.jobs.maxItems, 8);
  assert.doesNotMatch(JSON.stringify(firecrawlBody), /\/crawl|search engine|pagination/i);
});

test("five sources are scanned independently", async () => {
  const urls = Array.from({ length: 5 }, (_, index) => `https://jobs${index + 1}.example.com/roles`);
  let callCount = 0;
  const response = await run({ urls }, async (_url, options) => {
    callCount += 1;
    const source = new URL(JSON.parse(options.body).url);
    return {
      ok: true,
      status: 200,
      json: async () =>
        successPayload([
          job({ title: `Junior Analyst ${source.hostname}`, jobUrl: `https://${source.hostname}/role` }),
        ]),
    };
  });

  assert.equal(response.statusCode, 200);
  assert.equal(callCount, 5);
  assert.equal(response.body.sources.length, 5);
  assert.equal(response.body.jobs.length, 5);
});

test("one broken source does not cancel a successful source", async () => {
  const response = await run(
    { urls: ["https://good.example.com/jobs", "https://broken.example.com/jobs"] },
    async (_url, options) => {
      const requested = JSON.parse(options.body).url;
      if (requested.includes("broken")) {
        return { ok: false, status: 502, json: async () => ({ error: "blocked" }) };
      }
      return { ok: true, status: 200, json: async () => successPayload([job()]) };
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.jobs.length, 1);
  assert.deepEqual(
    response.body.sources.map((source) => source.status),
    ["extracted", "could_not_extract"],
  );
  assert.equal(response.body.allFailed, false);
});

test("strong seniority signals push a role below a junior role", async () => {
  const senior = job({
    title: "Senior Data Lead",
    jobUrl: "/jobs/senior-data-lead",
    juniorEvidence: ["The posting also mentions associate-level career pathways."],
    seniorityWarnings: ["Requires 8+ years of experience and team leadership."],
  });
  const junior = job({ title: "Graduate Data Associate", jobUrl: "/jobs/graduate-data" });
  const response = await run({ urls: ["https://jobs.example.com/roles"] }, async () => ({
    ok: true,
    status: 200,
    json: async () => successPayload([senior, junior]),
  }));

  assert.equal(response.body.jobs[0].title, "Graduate Data Associate");
  assert.equal(response.body.jobs[1].title, "Senior Data Lead");
});

test("duplicates are removed before Firecrawl is called", async () => {
  let callCount = 0;
  const response = await run(
    { urls: ["https://jobs.example.com/roles", "https://jobs.example.com/roles"] },
    async () => {
      callCount += 1;
      return { ok: true, status: 200, json: async () => successPayload([]) };
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(callCount, 1);
  assert.equal(response.body.sources.length, 1);
  assert.equal(response.body.sources[0].status, "no_jobs_found");
});

test("invalid, private, unsupported, and excessive source lists are rejected", async () => {
  const noFetch = async () => assert.fail("no fetch expected");
  const invalid = await run({ urls: ["not a url"] }, noFetch);
  const privateUrl = await run({ urls: ["http://localhost/jobs"] }, noFetch);
  const internalUrl = await run({ urls: ["https://careers.internal/jobs"] }, noFetch);
  const unsupported = await run({ urls: ["https://www.linkedin.com/jobs/view/1"] }, noFetch);
  const excessive = await run(
    { urls: Array.from({ length: 6 }, (_, index) => `https://jobs${index}.example.com`) },
    noFetch,
  );

  assert.equal(invalid.statusCode, 400);
  assert.equal(privateUrl.statusCode, 400);
  assert.equal(internalUrl.statusCode, 400);
  assert.equal(unsupported.statusCode, 400);
  assert.match(unsupported.body.error, /LinkedIn and Indeed are not supported/);
  assert.equal(excessive.statusCode, 400);
});

test("unsafe extracted job links fall back to the validated source page", async () => {
  const sourceUrl = "https://jobs.example.com/roles";
  const response = await run({ urls: [sourceUrl] }, async () => ({
    ok: true,
    status: 200,
    json: async () => successPayload([job({ jobUrl: "javascript:alert(1)" })]),
  }));

  assert.equal(response.body.jobs[0].jobUrl, sourceUrl);
});
