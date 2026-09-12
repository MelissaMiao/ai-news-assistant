const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const REQUEST_TIMEOUT_MS = 50_000;
const MAX_CONTENT_LENGTH = 6_000;

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

function limitedContent(value) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= MAX_CONTENT_LENGTH) return clean;
  return `${clean.slice(0, MAX_CONTENT_LENGTH).trimEnd()}\n\n[…]`;
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
      body: JSON.stringify({
        url: validation.url.href,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
      signal: controller.signal,
    });
    const payload = await firecrawlResponse.json().catch(() => ({}));

    if (!firecrawlResponse.ok || payload.success === false || !payload.data) {
      const status = firecrawlResponse.status === 429 ? 429 : 502;
      return response.status(status).json({
        error: safeUpstreamMessage(payload, apiKey),
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

    return response.status(200).json({
      title: metadata.title || metadata.ogTitle || validation.url.hostname,
      domain: resultDomain,
      url: resultUrl,
      description: metadata.description || metadata.ogDescription || "",
      content: limitedContent(payload.data.markdown),
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
