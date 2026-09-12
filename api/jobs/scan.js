import { isBlockedPage, validatePublicUrl } from "../scrape.js";

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const REQUEST_TIMEOUT_MS = 48_000;
const MAX_URLS = 5;
const MAX_JOBS_PER_SOURCE = 8;
const MAX_RESULTS = 5;
const UNSUPPORTED_JOB_HOSTS = ["linkedin.com", "indeed.com"];

const JOB_SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      maxItems: MAX_JOBS_PER_SOURCE,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          employer: { type: "string" },
          location: { type: "string" },
          jobUrl: { type: "string" },
          postedDate: { type: "string" },
          employmentType: { type: "string" },
          description: { type: "string" },
          juniorEvidence: { type: "array", items: { type: "string" } },
          transferableSkills: { type: "array", items: { type: "string" } },
          futureRelevantSignals: { type: "array", items: { type: "string" } },
          learningSignals: { type: "array", items: { type: "string" } },
          seniorityWarnings: { type: "array", items: { type: "string" } },
        },
        required: [
          "title",
          "employer",
          "location",
          "jobUrl",
          "postedDate",
          "employmentType",
          "description",
          "juniorEvidence",
          "transferableSkills",
          "futureRelevantSignals",
          "learningSignals",
          "seniorityWarnings",
        ],
      },
    },
  },
  required: ["jobs"],
};

const EXTRACTION_PROMPT = `Extract only genuine job openings visible on this exact page, with at most ${MAX_JOBS_PER_SOURCE} jobs. Do not crawl other pages, paginate, or invent missing facts. Focus on internships, graduate roles, entry-level roles, assistants, coordinators, associates, trainees, and roles requiring roughly 0-2 years of experience. Keep senior roles if present so they can be penalized. For every job, return concise verbatim or closely paraphrased evidence from the page for: early-career accessibility (juniorEvidence), transferable skills, future-relevant work or technology exposure, learning or mentorship, and seniority warnings. Use empty strings or empty arrays when the page does not provide a fact.`;

const EARLY_PATTERN = /\b(?:intern(?:ship)?|junior|graduate|entry[ -]?level|early[ -]?career|trainee|assistant|associate|coordinator|apprentice|0\s*(?:-|–|to)\s*2 years?|no (?:prior )?experience|new grad)\b/i;
const SKILL_PATTERN = /\b(?:communication|research|analysis|analytical|writing|project|data|customer|operations|marketing|sales|design|coding|programming|teamwork|problem.solving|excel|sql|python)\b/i;
const FUTURE_PATTERN = /\b(?:ai|artificial intelligence|machine learning|automation|robotics|cloud|cyber|data|software|digital|technology|sustainab|renewable|fintech|biotech)\b/i;
const LEARNING_PATTERN = /\b(?:mentor|training|learn|development|coaching|onboarding|rotation|career growth|professional growth)\b/i;
const SENIOR_PATTERN = /\b(?:senior|sr\.?|lead|principal|staff|head|director|executive|vice president|vp|manager|5\+? years?|[6-9]\+? years?|1[0-9]\+? years?)\b/i;

function parseRequestBody(body) {
  if (!body) return {};
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function cleanText(value, maxLength = 220) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item)).filter(Boolean))].slice(0, 8);
}

function isUnsupportedHost(hostname) {
  const host = hostname.toLowerCase();
  return UNSUPPORTED_JOB_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function validateSources(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "Enter at least one public job listing URL." };
  }
  if (value.length > MAX_URLS) {
    return { error: `Enter no more than ${MAX_URLS} job listing URLs.` };
  }

  const urls = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const validation = validatePublicUrl(value[index]);
    if (validation.error) {
      return { error: `Job Source ${index + 1}: ${validation.error}` };
    }
    if (isUnsupportedHost(validation.url.hostname)) {
      return {
        error: `Job Source ${index + 1}: LinkedIn and Indeed are not supported. Use a public job page that does not require sign-in.`,
      };
    }
    if (!seen.has(validation.url.href)) {
      seen.add(validation.url.href);
      urls.push(validation.url);
    }
  }
  return { urls };
}

function safeJobUrl(value, sourceUrl) {
  if (!value) return sourceUrl.href;
  try {
    const candidate = new URL(value, sourceUrl);
    const validation = validatePublicUrl(candidate.href);
    return validation.url?.href || sourceUrl.href;
  } catch {
    return sourceUrl.href;
  }
}

function normalizeJob(raw, sourceUrl) {
  if (!raw || typeof raw !== "object") return null;
  const title = cleanText(raw.title, 180);
  if (!title) return null;

  return {
    title,
    employer: cleanText(raw.employer, 160) || "Employer not listed",
    location: cleanText(raw.location, 160) || "Location not listed",
    jobUrl: safeJobUrl(raw.jobUrl, sourceUrl),
    postedDate: cleanText(raw.postedDate, 100) || "Date not listed",
    employmentType: cleanText(raw.employmentType, 100) || "Type not listed",
    description: cleanText(raw.description, 1_000),
    juniorEvidence: cleanList(raw.juniorEvidence),
    transferableSkills: cleanList(raw.transferableSkills),
    futureRelevantSignals: cleanList(raw.futureRelevantSignals),
    learningSignals: cleanList(raw.learningSignals),
    seniorityWarnings: cleanList(raw.seniorityWarnings),
    sourceUrl: sourceUrl.href,
    sourceDomain: sourceUrl.hostname,
  };
}

function firstMatchingSentence(job, pattern) {
  const candidates = [job.title, ...job.description.split(/(?<=[.!?])\s+/)];
  return candidates.map((value) => cleanText(value)).find((value) => pattern.test(value)) || "";
}

function scoreAndExplain(job) {
  const searchable = [job.title, job.description, ...job.seniorityWarnings].join(" ");
  const accessible = job.juniorEvidence[0] || firstMatchingSentence(job, EARLY_PATTERN);
  const skills = job.transferableSkills[0] || firstMatchingSentence(job, SKILL_PATTERN);
  const exposure =
    job.futureRelevantSignals[0] ||
    job.learningSignals[0] ||
    firstMatchingSentence(job, FUTURE_PATTERN) ||
    firstMatchingSentence(job, LEARNING_PATTERN);

  const earlyScore = Math.min(40, (accessible ? 24 : 0) + job.juniorEvidence.length * 5);
  const skillsScore = Math.min(30, (skills ? 16 : 0) + job.transferableSkills.length * 4);
  const futureScore = Math.min(
    20,
    (job.futureRelevantSignals[0] ? 12 : 0) + job.futureRelevantSignals.length * 3,
  );
  const learningScore = Math.min(
    10,
    (job.learningSignals[0] ? 6 : 0) + job.learningSignals.length * 2,
  );
  const seniorPenalty =
    (SENIOR_PATTERN.test(job.title) ? 60 : 0) +
    (job.seniorityWarnings.length > 0 || SENIOR_PATTERN.test(searchable) ? 35 : 0);

  return {
    ...job,
    score: earlyScore + skillsScore + futureScore + learningScore - seniorPenalty,
    qualifies: Boolean(accessible && skills && exposure),
    reasons: [
      { heading: "Accessible start", text: accessible },
      { heading: "Skills you can build", text: skills },
      { heading: "Career exposure", text: exposure },
    ],
  };
}

function publicJob(job, rank) {
  return {
    rank,
    title: job.title,
    employer: job.employer,
    location: job.location,
    sourceDomain: job.sourceDomain,
    employmentType: job.employmentType,
    postedDate: job.postedDate,
    jobUrl: job.jobUrl,
    sourceUrl: job.sourceUrl,
    reasons: job.reasons,
  };
}

function rankJobs(jobs) {
  const seen = new Set();
  const unique = [];
  for (const job of jobs) {
    const key = `${job.jobUrl}|${job.title.toLowerCase()}|${job.employer.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(job);
    }
  }

  return unique
    .map(scoreAndExplain)
    .filter((job) => job.qualifies)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.title.localeCompare(right.title) ||
        left.employer.localeCompare(right.employer),
    )
    .slice(0, MAX_RESULTS)
    .map((job, index) => publicJob(job, index + 1));
}

function firecrawlOptions(url) {
  return {
    url: url.href,
    formats: ["markdown", { type: "json", prompt: EXTRACTION_PROMPT, schema: JOB_SCHEMA }],
    onlyMainContent: true,
    onlyCleanContent: true,
    blockAds: true,
    timeout: 45_000,
  };
}

function extractJobs(data) {
  let extracted = data?.json ?? data?.extract;
  if (typeof extracted === "string") {
    try {
      extracted = JSON.parse(extracted);
    } catch {
      return [];
    }
  }
  return Array.isArray(extracted?.jobs) ? extracted.jobs.slice(0, MAX_JOBS_PER_SOURCE) : [];
}

async function scanSource(url, apiKey) {
  const source = { url: url.href, domain: url.hostname };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(firecrawlOptions(url)),
      signal: controller.signal,
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok || payload.success === false || !payload.data || isBlockedPage(payload.data)) {
      return {
        source: {
          ...source,
          status: "could_not_extract",
          message: "Could not extract this public page.",
          jobCount: 0,
        },
        jobs: [],
      };
    }

    const jobs = extractJobs(payload.data)
      .map((job) => normalizeJob(job, url))
      .filter(Boolean);
    return {
      source: {
        ...source,
        status: jobs.length ? "extracted" : "no_jobs_found",
        message: jobs.length ? `Extracted ${jobs.length} job${jobs.length === 1 ? "" : "s"}.` : "No jobs found on this page.",
        jobCount: jobs.length,
      },
      jobs,
    };
  } catch (error) {
    return {
      source: {
        ...source,
        status: "could_not_extract",
        message:
          error?.name === "AbortError"
            ? "This source timed out."
            : "Could not reach this source through Firecrawl.",
        jobCount: 0,
      },
      jobs: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const config = { maxDuration: 60 };

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to scan job listing pages." });
  }

  const validation = validateSources(parseRequestBody(request.body).urls);
  if (validation.error) return response.status(400).json({ error: validation.error });

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({
      error: "Job scanning is not configured yet. Add FIRECRAWL_API_KEY on the server.",
    });
  }

  const scans = await Promise.all(validation.urls.map((url) => scanSource(url, apiKey)));
  const sources = scans.map((scan) => scan.source);
  const jobs = rankJobs(scans.flatMap((scan) => scan.jobs));
  const failedCount = sources.filter((source) => source.status === "could_not_extract").length;

  return response.status(200).json({
    sources,
    jobs,
    allFailed: failedCount === sources.length,
    message: jobs.length
      ? `Ranked ${jobs.length} junior opportunit${jobs.length === 1 ? "y" : "ies"}.`
      : failedCount === sources.length
        ? "None of the sources could be extracted. Check the URLs and try again."
        : "The pages were scanned, but no evidence-backed junior opportunities were found.",
  });
}
