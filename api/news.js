import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const FEEDS = [
  {
    source: "WIRED",
    url: "https://www.wired.com/feed/tag/ai/latest/rss",
  },
  {
    source: "TechCrunch",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
  },
  {
    source: "VentureBeat",
    url: "https://venturebeat.com/category/ai/feed/",
  },
];

const ITEMS_PER_SOURCE = 6;
const MAX_ARTICLES = 18;
const REQUEST_TIMEOUT_MS = 12_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.map(textValue).find(Boolean) || "";
  }
  if (typeof value === "object") {
    for (const key of ["#text", "__cdata", "text", "value"]) {
      if (key in value) return textValue(value[key]);
    }
  }
  return "";
}

function decodeEntities(value) {
  const decodeCodePoint = (raw, radix) => {
    const code = Number.parseInt(raw, radix);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : " ";
  };

  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => decodeCodePoint(code, 10))
    .replace(/&#x([\da-f]+);/gi, (_, code) => decodeCodePoint(code, 16));
}

function cleanText(value) {
  const raw = textValue(value);
  if (!raw) return "";

  return decodeEntities(
    raw
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function articleUrl(item) {
  if (typeof item.link === "string") return item.link.trim();

  const links = asArray(item.link);
  const preferred = links.find((link) => !link?.["@_rel"] || link["@_rel"] === "alternate");
  return textValue(preferred?.["@_href"] || preferred?.href || preferred);
}

function isoDate(value) {
  const raw = textValue(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function stableId(source, item, url, title) {
  const seed = cleanText(item.guid || item.id) || url || title;
  return createHash("sha256").update(`${source}:${seed}`).digest("hex").slice(0, 18);
}

function entriesFromFeed(parsed) {
  return asArray(parsed?.rss?.channel?.item || parsed?.feed?.entry);
}

function normalizeEntry(item, source) {
  const title = (cleanText(item.title) || "Untitled story").slice(0, 240);
  const url = articleUrl(item);
  if (!url) return null;

  const publishedAt = isoDate(
    item.pubDate || item.published || item.updated || item.date || item.created,
  );
  const summary = cleanText(
    item.description || item.summary || item.encoded || item.content,
  ).slice(0, 600);

  return {
    id: stableId(source, item, url, title),
    source,
    title,
    url,
    publishedAt,
    summary,
  };
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(feed.url, {
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "User-Agent": "AI-News-Assistant/1.0 (+https://vercel.app)",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Feed returned HTTP ${response.status}.`);
    }

    const xml = await response.text();
    if (XMLValidator.validate(xml) !== true) {
      throw new Error("Feed returned invalid XML.");
    }
    const parsed = parser.parse(xml);
    const entries = entriesFromFeed(parsed);

    if (entries.length === 0) {
      throw new Error("Feed did not contain readable stories.");
    }

    const articles = entries
      .map((entry) => normalizeEntry(entry, feed.source))
      .filter(Boolean)
      .slice(0, ITEMS_PER_SOURCE);

    if (articles.length === 0) {
      throw new Error("Feed stories did not include usable links.");
    }

    return { articles, warning: null };
  } catch (error) {
    const message = error?.name === "AbortError" ? "Feed request timed out." : error.message;
    return {
      articles: [],
      warning: { source: feed.source, message: message || "Feed could not be loaded." },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sortNewestFirst(first, second) {
  const firstTime = first.publishedAt ? new Date(first.publishedAt).getTime() : 0;
  const secondTime = second.publishedAt ? new Date(second.publishedAt).getTime() : 0;
  return secondTime - firstTime;
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Use GET to load the news briefing." });
  }

  const results = await Promise.all(FEEDS.map(fetchFeed));
  const articles = results
    .flatMap((result) => result.articles)
    .sort(sortNewestFirst)
    .slice(0, MAX_ARTICLES);
  const warnings = results.map((result) => result.warning).filter(Boolean);

  response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (articles.length === 0) {
    return response.status(502).json({
      articles: [],
      warnings,
      error: "None of the news feeds could be loaded. Please try again shortly.",
    });
  }

  return response.status(200).json({ articles, warnings });
}
