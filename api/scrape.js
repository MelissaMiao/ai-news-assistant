const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const REQUEST_TIMEOUT_MS = 50_000;
const MAX_CONTENT_LENGTH = 6_000;
const ENHANCED_PROXY_HOSTS = new Set(["techcrunch.com", "www.techcrunch.com"]);
const BLOCKED_PAGE_PATTERNS = [
  /challenges\.cloudflare\.com/i,
  /cdn-cgi\/challenge-platform/i,
  /verification (?:failed|expired)/i,
  /just a moment\.\.\./i,
  /enable javascript and cookies to continue/i,
  /attention required[^\n]*cloudflare/i,
  /cloudflare ray id/i,
  /captcha/i,
];
const TECHCRUNCH_BOILERPLATE_PATTERNS = [
  /^\[?share on\b/i,
  /^copy share link\b/i,
  /^\d{1,2}:\d{2}\s+(?:am|pm)\s+[a-z]{2,4}\s+·/i,
  /^\d+ seconds? of \d+ minutes?/i,
  /^press shift question mark/i,
  /^keyboard shortcuts/i,
  /^(?:play\/pause|increase volume|decrease volume|seek forward|seek backward|captions on\/off|fullscreen)/i,
  /\|\s*[^\n]*podcast\s*$/i,
];

function parseRequestBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }

  if (
    host === "::1" ||
    (host.includes(":") &&
      (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")))
  ) {
    return true;
  }

  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;

  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

function validatePublicUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { error: "Choose an article URL to Deep Read." };
  }

  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) {
      return { error: "Only http:// or https:// web pages can be scraped." };
    }
    if (url.username || url.password || isPrivateHostname(url.hostname)) {
      return { error: "Deep Read accepts public web pages only." };
    }
    return { url };
  } catch {
    return { error: "The selected article does not have a valid web URL." };
  }
}

function markdownToPlainText(value) {
  return value
    .replace(/!\[[^\]]*\]\([^\n)]*(?:\([^\n)]*\)[^\n)]*)*\)/g, "")
    .replace(/\[([^\]]+)]\([^\n)]*(?:\([^\n)]*\)[^\n)]*)*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function cleanTechCrunchContent(value) {
  const blocks = value.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const articleHeadingIndex = blocks.findIndex((block) => /^#\s+\S/m.test(block));
  const articleBlocks = articleHeadingIndex >= 0 ? blocks.slice(articleHeadingIndex + 1) : blocks;

  return articleBlocks
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !/^!\[[^\]]*]/.test(block))
    .filter((block) => !/^\[[^\]]+]\([^\n]+\)$/.test(block))
    .filter(
      (block) =>
        !TECHCRUNCH_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(block)),
    )
    .join("\n\n");
}

function limitedContent(value, url) {
  if (typeof value !== "string") return "";
  const extracted = ENHANCED_PROXY_HOSTS.has(url.hostname.toLowerCase())
    ? cleanTechCrunchContent(value)
    : value;
  const clean = markdownToPlainText(extracted).replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= MAX_CONTENT_LENGTH) return clean;
  return `${clean.slice(0, MAX_CONTENT_LENGTH).trimEnd()}\n\n[…]`;
}

function isBlockedPage(data) {
  const metadata = data?.metadata || {};
  const pageText = [
    metadata.title,
    metadata.description,
    metadata.ogTitle,
    metadata.ogDescription,
    data?.markdown,
  ]
    .filter((value) => typeof value === "string")
    .join("\n")
    .slice(0, 20_000);

  return BLOCKED_PAGE_PATTERNS.some((pattern) => pattern.test(pageText));
}

function scrapeOptions(url) {
  const options = {
    url: url.href,
    formats: ["markdown"],
    onlyMainContent: true,
    blockAds: true,
  };

  if (ENHANCED_PROXY_HOSTS.has(url.hostname.toLowerCase())) {
    options.proxy = "enhanced";
    options.location = { country: "US", languages: ["en-US"] };
    options.waitFor = 1_500;
  }

  return options;
}

function safeUpstreamMessage(payload, apiKey) {
  const message = typeof payload?.error === "string" ? payload.error : "";
  if (!message) return "Firecrawl could not retrieve this page.";
  return message.replaceAll(apiKey, "[redacted]").slice(0, 240);
}

export const config = { maxDuration: 60 };

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to scrape one page." });
  }

  const body = parseRequestBody(request.body);
  const validation = validatePublicUrl(body.url);
  if (validation.error) {
    return response.status(400).json({ error: validation.error });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({
      error: "Deep Read is not configured yet. Add FIRECRAWL_API_KEY on the server.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const firecrawlResponse = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(scrapeOptions(validation.url)),
      signal: controller.signal,
    });
    const payload = await firecrawlResponse.json().catch(() => ({}));

    if (!firecrawlResponse.ok || payload.success === false || !payload.data) {
      const status = firecrawlResponse.status === 429 ? 429 : 502;
      return response.status(status).json({
        error: safeUpstreamMessage(payload, apiKey),
      });
    }

    if (isBlockedPage(payload.data)) {
      return response.status(502).json({
        error:
          "This publisher blocked automated reading with a verification page. Please retry once or open the original article.",
      });
    }

    const metadata = payload.data.metadata || {};
    const resultUrl = metadata.sourceURL || metadata.url || validation.url.href;
    let resultDomain = validation.url.hostname;
    try {
      resultDomain = new URL(resultUrl).hostname;
    } catch {
      // Keep the validated request hostname as a safe fallback.
    }

    const content = limitedContent(payload.data.markdown, validation.url);
    if (!content) {
      return response.status(502).json({
        error: "Deep Read could not find readable article content. Please open the original article.",
      });
    }

    return response.status(200).json({
      title: metadata.title || metadata.ogTitle || validation.url.hostname,
      domain: resultDomain,
      url: resultUrl,
      description: metadata.description || metadata.ogDescription || "",
      content,
    });
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? "Deep Read timed out. Please try again."
        : "Deep Read could not reach Firecrawl. Please try again.";
    return response.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}
