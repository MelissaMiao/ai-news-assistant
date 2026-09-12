const loadButton = document.querySelector("#load-news");
const filterInput = document.querySelector("#news-filter");
const statusElement = document.querySelector("#news-status");
const articleList = document.querySelector("#article-list");
const resultCount = document.querySelector("#result-count");
const deepReadPanel = document.querySelector("#deep-read-panel");
const explorerForm = document.querySelector("#web-explorer-form");
const explorerInput = document.querySelector("#explorer-url");
const explorerButton = document.querySelector("#scrape-page");
const explorerStatus = document.querySelector("#explorer-status");
const explorerResult = document.querySelector("#explorer-result");
const jobScoutForm = document.querySelector("#job-scout-form");
const jobSourceInputs = Array.from(document.querySelectorAll("[id^='job-source-']")).filter(
  (element) => element.matches("input"),
);
const jobSourceStatuses = jobSourceInputs.map((_, index) =>
  document.querySelector(`#job-source-status-${index + 1}`),
);
const scanJobsButton = document.querySelector("#scan-jobs");
const clearJobsButton = document.querySelector("#clear-jobs");
const jobScoutStatus = document.querySelector("#job-scout-status");
const jobResults = document.querySelector("#job-results");
const jobResultCount = document.querySelector("#job-result-count");
const jobResultList = document.querySelector("#job-result-list");

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

function setExplorerStatus(message, tone = "neutral") {
  explorerStatus.textContent = message;
  explorerStatus.dataset.tone = tone;
}

function setJobScoutStatus(message, tone = "neutral") {
  jobScoutStatus.textContent = message;
  jobScoutStatus.dataset.tone = tone;
}

function setJobSourceStatus(index, label, state = "waiting", detail = "") {
  const status = jobSourceStatuses[index];
  status.textContent = label;
  status.dataset.state = state;
  status.title = detail;
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

function explorerHeading(text) {
  const heading = createElement("h3", "", text);
  heading.id = "explorer-result-title";
  return heading;
}

function renderExplorerLoading() {
  const wrapper = createElement("div");
  wrapper.append(
    createElement("p", "panel-kicker", "Web Explorer · Retrieving"),
    explorerHeading("Reading the selected page…"),
    createElement("div", "explorer-loading-line"),
    createElement("div", "explorer-loading-line short"),
  );
  explorerResult.replaceChildren(wrapper);
  explorerResult.setAttribute("aria-busy", "true");
}

function renderExplorerResult(result) {
  const wrapper = createElement("div");
  const header = createElement("div", "explorer-result-header");
  header.append(
    createElement("p", "panel-kicker", "Web Explorer · Retrieved"),
    createElement("span", "explorer-domain", result.domain || "Web page"),
  );

  const sourceUrl = createExternalLink(
    result.url || explorerInput.value.trim(),
    result.url || explorerInput.value.trim(),
    "explorer-source-url",
  );
  wrapper.append(header, explorerHeading(result.title || "Retrieved web page"), sourceUrl);

  if (result.description) {
    wrapper.append(createElement("p", "explorer-description", result.description));
  }

  wrapper.append(
    createElement(
      "div",
      "explorer-content",
      result.content || "Firecrawl returned no readable page content.",
    ),
    createExternalLink(
      "Open Original Page ↗",
      result.url || explorerInput.value.trim(),
      "text-link",
    ),
  );
  explorerResult.replaceChildren(wrapper);
  explorerResult.removeAttribute("aria-busy");
}

function renderExplorerError(message) {
  const wrapper = createElement("div");
  wrapper.append(
    createElement("p", "panel-kicker", "Web Explorer · Could not retrieve"),
    explorerHeading("That page could not be explored."),
    createElement("p", "explorer-error-copy", message),
  );
  explorerResult.replaceChildren(wrapper);
  explorerResult.removeAttribute("aria-busy");
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

async function explorePage(event) {
  event.preventDefault();
  if (explorerButton.disabled) return;

  const url = explorerInput.value.trim();
  if (!url) {
    const message = "Enter one public webpage URL before scraping.";
    setExplorerStatus(message, "error");
    renderExplorerError(message);
    explorerInput.focus();
    return;
  }

  explorerButton.disabled = true;
  explorerButton.textContent = "Scraping…";
  setExplorerStatus("Contacting Firecrawl for this page…");
  renderExplorerLoading();

  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const payload = await readJson(response);

    if (!response.ok) {
      throw new Error(payload.error || "This page is temporarily unavailable.");
    }

    renderExplorerResult(payload);
    setExplorerStatus(`Retrieved one page from ${payload.domain || "the web"}.`);
  } catch (error) {
    const message = error.message || "Web Explorer could not retrieve this page.";
    renderExplorerError(message);
    setExplorerStatus(message, "error");
  } finally {
    explorerButton.disabled = false;
    explorerButton.textContent = "Scrape Page";
  }
}

function renderJobEmpty(message = "Your evidence-backed shortlist will appear here.") {
  const empty = createElement("div", "job-empty");
  empty.append(
    createElement("p", "empty-number", "05"),
    createElement("p", "", message),
  );
  jobResultList.replaceChildren(empty);
  jobResultCount.textContent = "No results yet";
}

function renderJobLoading() {
  const loading = createElement("div", "job-loading");
  loading.append(
    createElement("p", "panel-kicker", "Scanning exact pages"),
    createElement("h4", "", "Extracting and ranking visible opportunities…"),
    createElement("div", "job-loading-line"),
    createElement("div", "job-loading-line short"),
  );
  jobResultList.replaceChildren(loading);
  jobResultCount.textContent = "Scanning";
  jobResults.setAttribute("aria-busy", "true");
}

function createJobMetaItem(label, value) {
  const item = createElement("span", "job-meta-item");
  item.append(createElement("strong", "", label), document.createTextNode(value));
  return item;
}

function renderJobs(jobs, message) {
  if (!jobs.length) {
    renderJobEmpty(message);
    jobResultCount.textContent = "0 opportunities";
    jobResults.removeAttribute("aria-busy");
    return;
  }

  const cards = jobs.map((job) => {
    const card = createElement("article", "job-card");
    const header = createElement("div", "job-card-header");
    const rank = createElement("p", "job-rank", String(job.rank).padStart(2, "0"));
    const headingGroup = createElement("div", "job-title-group");
    headingGroup.append(
      createElement("p", "job-employer", job.employer),
      createElement("h4", "", job.title),
    );
    header.append(rank, headingGroup);

    const meta = createElement("div", "job-meta");
    meta.append(
      createJobMetaItem("Location", job.location),
      createJobMetaItem("Source", job.sourceDomain),
      createJobMetaItem("Type", job.employmentType),
      createJobMetaItem("Posted", job.postedDate),
    );

    const evidence = createElement("ul", "job-evidence");
    job.reasons.slice(0, 3).forEach((reason) => {
      const item = createElement("li");
      item.append(
        createElement("strong", "", `${reason.heading}: `),
        document.createTextNode(reason.text),
      );
      evidence.append(item);
    });

    card.append(
      header,
      meta,
      evidence,
      createExternalLink("Open Job Posting ↗", job.jobUrl, "job-link"),
    );
    return card;
  });

  jobResultList.replaceChildren(...cards);
  jobResultCount.textContent = `${jobs.length} opportunit${jobs.length === 1 ? "y" : "ies"}`;
  jobResults.removeAttribute("aria-busy");
}

function sourceStatusLabel(state) {
  return {
    extracted: "Extracted",
    no_jobs_found: "No jobs found",
    could_not_extract: "Could not extract",
  }[state] || "Waiting";
}

function updateSourceResults(sources) {
  const byUrl = new Map(sources.map((source) => [source.url, source]));
  jobSourceInputs.forEach((input, index) => {
    if (!input.value.trim()) {
      setJobSourceStatus(index, "Waiting");
      return;
    }
    let normalized = input.value.trim();
    try {
      normalized = new URL(normalized).href;
    } catch {
      // Server validation provides the user-facing malformed URL message.
    }
    const source = byUrl.get(normalized);
    if (source) {
      setJobSourceStatus(
        index,
        sourceStatusLabel(source.status),
        source.status,
        source.message,
      );
    }
  });
}

function enteredJobUrls() {
  return jobSourceInputs.map((input) => input.value.trim()).filter(Boolean);
}

async function scanJobs(event) {
  event.preventDefault();
  if (scanJobsButton.disabled) return;

  const urls = enteredJobUrls();
  if (!jobSourceInputs[0].value.trim() || urls.length === 0) {
    setJobScoutStatus("Job Source 1 is required.", "error");
    jobSourceInputs[0].focus();
    return;
  }

  scanJobsButton.disabled = true;
  clearJobsButton.disabled = true;
  scanJobsButton.textContent = "Scanning…";
  jobSourceInputs.forEach((input, index) => {
    setJobSourceStatus(
      index,
      input.value.trim() ? "Scanning" : "Waiting",
      input.value.trim() ? "scanning" : "waiting",
    );
  });
  setJobScoutStatus(
    `Scanning ${urls.length} exact public page${urls.length === 1 ? "" : "s"}…`,
  );
  renderJobLoading();

  try {
    const response = await fetch("/api/jobs/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(payload.error || "Junior Job Scout is temporarily unavailable.");
    }

    updateSourceResults(Array.isArray(payload.sources) ? payload.sources : []);
    renderJobs(Array.isArray(payload.jobs) ? payload.jobs : [], payload.message);
    setJobScoutStatus(
      payload.message || "Job scan complete.",
      payload.allFailed ? "error" : "neutral",
    );
  } catch (error) {
    const message = error.message || "Junior Job Scout could not complete this scan.";
    jobSourceInputs.forEach((input, index) => {
      setJobSourceStatus(
        index,
        input.value.trim() ? "Could not extract" : "Waiting",
        input.value.trim() ? "could_not_extract" : "waiting",
      );
    });
    renderJobEmpty(message);
    jobResultCount.textContent = "Scan incomplete";
    jobResults.removeAttribute("aria-busy");
    setJobScoutStatus(message, "error");
  } finally {
    scanJobsButton.disabled = false;
    clearJobsButton.disabled = false;
    scanJobsButton.textContent = "Find Junior Opportunities";
  }
}

function clearJobResults() {
  jobScoutForm.reset();
  jobSourceStatuses.forEach((_, index) => setJobSourceStatus(index, "Waiting"));
  setJobScoutStatus("Ready to scan one to five public job pages.");
  renderJobEmpty();
  jobSourceInputs[0].focus();
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
explorerForm.addEventListener("submit", explorePage);
jobScoutForm.addEventListener("submit", scanJobs);
clearJobsButton.addEventListener("click", clearJobResults);
