const loadButton = document.querySelector("#load-news");
const filterInput = document.querySelector("#news-filter");
const statusElement = document.querySelector("#news-status");
const articleList = document.querySelector("#article-list");
const resultCount = document.querySelector("#result-count");
const deepReadPanel = document.querySelector("#deep-read-panel");

const state = {
  articles: [],
  deepReadRequest: 0,
};

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setStatus(message, tone = "neutral") {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
}

function formatDate(value) {
  if (!value) return "Date unavailable";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function createExternalLink(label, url, className = "text-link") {
  const link = createElement("a", className, label);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function renderEmptyState(number, message) {
  const empty = createElement("div", "empty-state");
  empty.append(
    createElement("p", "empty-number", number),
    createElement("p", "", message),
  );
  articleList.replaceChildren(empty);
}

function renderArticles() {
  const query = filterInput.value.trim().toLocaleLowerCase();
  const filteredArticles = state.articles.filter((article) => {
    const searchableText = `${article.title} ${article.summary}`.toLocaleLowerCase();
    return searchableText.includes(query);
  });

  if (state.articles.length === 0) {
    resultCount.textContent = "No stories loaded";
    renderEmptyState("00", "Your briefing is waiting above.");
    return;
  }

  resultCount.textContent = query
    ? `Showing ${filteredArticles.length} of ${state.articles.length}`
    : `${state.articles.length} stories loaded`;

  if (filteredArticles.length === 0) {
    renderEmptyState("00", "No matching stories. Clear the filter to see everything.");
    return;
  }

  const cards = filteredArticles.map((article) => {
    const card = createElement("article", "article-card");
    const meta = createElement("div", "card-meta");
    meta.append(
      createElement("span", "source-tag", article.source),
      createElement("time", "article-date", formatDate(article.publishedAt)),
    );
    const time = meta.querySelector("time");
    if (article.publishedAt) time.dateTime = article.publishedAt;

    const title = createElement("h4", "", article.title);
    const summary = createElement(
      "p",
      "article-summary",
      article.summary || "No RSS summary was provided for this story.",
    );

    const footer = createElement("div", "card-footer");
    const originalLink = createExternalLink("Read Original Article ↗", article.url);
    const deepReadButton = createElement("button", "deep-read-button", "Deep Read");
    deepReadButton.type = "button";
    deepReadButton.addEventListener("click", () => loadDeepRead(article, deepReadButton));
    footer.append(originalLink, deepReadButton);
    card.append(meta, title, summary, footer);
    return card;
  });

  articleList.replaceChildren(...cards);
}

function renderDeepReadLoading(article) {
  const wrapper = createElement("div");
  const kicker = createElement("p", "panel-kicker", "Deep Read · Retrieving");
  const title = createElement("h3", "", article.title);
  const firstLine = createElement("div", "loading-line");
  const secondLine = createElement("div", "loading-line short");
  wrapper.append(kicker, title, firstLine, secondLine);
  deepReadPanel.replaceChildren(wrapper);
  deepReadPanel.setAttribute("aria-busy", "true");
}

function renderDeepReadResult(article, result) {
  const wrapper = createElement("div");
  const header = createElement("div", "deep-read-header");
  const headingGroup = createElement("div");
  headingGroup.append(
    createElement("p", "panel-kicker", `Deep Read · ${article.source}`),
    createElement("h3", "", result.title || article.title),
  );
  header.append(
    headingGroup,
    createElement("span", "deep-read-domain", result.domain || article.source),
  );

  wrapper.append(header);
  if (result.description) {
    wrapper.append(createElement("p", "", result.description));
  }
  wrapper.append(
    createElement(
      "div",
      "deep-read-content",
      result.content || "Firecrawl returned no readable page content.",
    ),
    createExternalLink("Open Original Article ↗", result.url || article.url),
  );
  deepReadPanel.replaceChildren(wrapper);
  deepReadPanel.removeAttribute("aria-busy");
}

function renderDeepReadError(article, message) {
  const wrapper = createElement("div");
  wrapper.append(
    createElement("p", "panel-kicker", "Deep Read · Could not retrieve"),
    createElement("h3", "", article.title),
    createElement("p", "", `${message} You can retry from the story card.`),
    createExternalLink("Read the original instead ↗", article.url),
  );
  deepReadPanel.replaceChildren(wrapper);
  deepReadPanel.removeAttribute("aria-busy");
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function loadDeepRead(article, button) {
  const requestId = ++state.deepReadRequest;
  button.disabled = true;
  button.textContent = "Reading…";
  renderDeepReadLoading(article);
  deepReadPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: article.url }),
    });
    const payload = await readJson(response);

    if (!response.ok) {
      throw new Error(payload.error || "Deep Read is temporarily unavailable.");
    }

    if (requestId === state.deepReadRequest) {
      renderDeepReadResult(article, payload);
    }
  } catch (error) {
    if (requestId === state.deepReadRequest) {
      renderDeepReadError(article, error.message || "Deep Read failed.");
    }
  } finally {
    button.disabled = false;
    button.textContent = "Deep Read";
  }
}

function restoreLoadButton() {
  const dot = createElement("span", "button-dot");
  dot.setAttribute("aria-hidden", "true");
  loadButton.replaceChildren(dot, document.createTextNode("Load Latest News"));
}

async function loadLatestNews() {
  loadButton.disabled = true;
  loadButton.textContent = "Loading feeds…";
  filterInput.disabled = true;
  setStatus("Contacting WIRED, TechCrunch, and VentureBeat…");

  try {
    const response = await fetch("/api/news", {
      headers: { Accept: "application/json" },
    });
    const payload = await readJson(response);

    if (!response.ok) {
      throw new Error(payload.error || "The news feeds could not be loaded.");
    }

    state.articles = Array.isArray(payload.articles) ? payload.articles : [];
    filterInput.disabled = state.articles.length === 0;
    renderArticles();

    if (payload.warnings?.length) {
      const unavailable = payload.warnings.map((warning) => warning.source).join(", ");
      setStatus(
        `Loaded ${state.articles.length} stories. ${unavailable} could not be reached this time.`,
        "warning",
      );
    } else if (state.articles.length > 0) {
      setStatus(`Briefing ready: ${state.articles.length} stories from three sources.`);
    } else {
      setStatus("The feeds responded, but no current stories were found.", "warning");
    }
  } catch (error) {
    state.articles = [];
    renderArticles();
    setStatus(
      `${error.message || "The news feeds could not be loaded."} Please try again.`,
      "error",
    );
  } finally {
    loadButton.disabled = false;
    restoreLoadButton();
  }
}

loadButton.addEventListener("click", loadLatestNews);
filterInput.addEventListener("input", renderArticles);
