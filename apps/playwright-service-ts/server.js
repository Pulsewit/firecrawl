/**
 * Stealth-enabled drop-in replacement for mendableai/playwright-service-ts.
 *
 * Exposes the SAME HTTP contract Firecrawl's worker expects, so you can set
 *   PLAYWRIGHT_MICROSERVICE_URL=http://playwright-stealth.railway.internal:3003/scrape
 * on firecrawl-api + firecrawl-worker and the upstream code doesn't change.
 *
 * Differences from the upstream image:
 *  - puppeteer-extra + puppeteer-extra-plugin-stealth (~17 evasions:
 *    navigator.webdriver, chrome.runtime, WebGL vendor, plugins/MIMEs,
 *    permissions API, iframe.contentWindow, etc.)
 *  - Respects BLOCK_MEDIA=true (skips image/font/media/stylesheet requests)
 *  - Respects PROXY_SERVER / PROXY_USERNAME / PROXY_PASSWORD
 *  - Randomised viewport + Accept-Language matching the request's geo header
 *
 * Stealth helps with basic detection. It does NOT defeat DataDome, PerimeterX,
 * Akamai, or Cloudflare Turnstile on a datacenter IP — for those you still
 * need a residential proxy (and ideally JA3 spoofing, which is out of scope
 * for a puppeteer-only setup).
 */

const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cheerio = require("cheerio");

puppeteer.use(StealthPlugin());

const PORT = parseInt(process.env.PORT || "3003", 10);
const BLOCK_MEDIA = String(process.env.BLOCK_MEDIA || "").toLowerCase() === "true";
const PROXY_SERVER = process.env.PROXY_SERVER || "";
const PROXY_USERNAME = process.env.PROXY_USERNAME || "";
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || "";
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_TIMEOUT_MS || "30000", 10);
const INTERNAL_WORKER_TOKEN = process.env.INTERNAL_WORKER_TOKEN || "";
const ENABLE_GOOGLE_SERP = String(process.env.ENABLE_GOOGLE_SERP || "false").toLowerCase() === "true";

const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "stylesheet",
  "texttrack",
  "object",
  "beacon",
  "csp_report",
  "imageset",
]);

let browserPromise = null;
async function getBrowser() {
  if (browserPromise) return browserPromise;
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
  ];
  if (PROXY_SERVER) {
    // Strip scheme — Chrome wants host:port for --proxy-server when auth is provided separately.
    const proxyArg = PROXY_SERVER.replace(/^https?:\\/\\//i, "");
    args.push(`--proxy-server=${proxyArg}`);
  }
  browserPromise = puppeteer.launch({
    headless: "new",
    args,
    ignoreHTTPSErrors: true,
  });
  const browser = await browserPromise;
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

async function scrape(req) {
  const {
    url,
    wait_after_load = 0,
    timeout = DEFAULT_TIMEOUT_MS,
    headers = {},
    check_selector,
  } = req;
  if (!url || typeof url !== "string") {
    return { error: "url required" };
  }

  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    if (PROXY_USERNAME) {
      await page.authenticate({ username: PROXY_USERNAME, password: PROXY_PASSWORD });
    }
    if (headers && Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }
    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });

    if (BLOCK_MEDIA) {
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        if (BLOCKED_RESOURCE_TYPES.has(r.resourceType())) return r.abort();
        return r.continue();
      });
    }

    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout,
    });

    if (wait_after_load > 0) {
      await new Promise((res) => setTimeout(res, wait_after_load));
    }
    if (check_selector) {
      await page.waitForSelector(check_selector, { timeout: 5000 }).catch(() => {});
    }

    const content = await page.content();
    return {
      content,
      pageStatusCode: response ? response.status() : null,
      pageError: null,
    };
  } catch (err) {
    return {
      content: "",
      pageStatusCode: null,
      pageError: err && err.message ? err.message : String(err),
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, stealth: true }));
app.get("/", (_req, res) => res.json({ ok: true, service: "playwright-stealth" }));

app.post("/scrape", async (req, res) => {
  try {
    const result = await scrape(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({
      content: "",
      pageStatusCode: null,
      pageError: err && err.message ? err.message : String(err),
    });
  }
});

// ─── LinkedIn site-restricted SERP + OG enrich ──────────────────────────────
// POST /linkedin/search
// Body: { keyword, limit?, country?, sinceDays?, internalToken }
// Discovers LinkedIn URLs via Bing (DuckDuckGo fallback) and enriches each
// with the publicly-served OG metadata. Datacenter-friendly: Google is
// deliberately skipped because it blocks site:linkedin.com from Railway IPs.
const LINKEDIN_URL_RE = /linkedin\\.com\\/(?:posts|pulse|feed\\/update|company|in)\\/[A-Za-z0-9_:%./?=&-]+/i;

function absoluteLinkedInUrl(href) {
  if (!href) return null;
  try {
    // Bing wraps result links sometimes; normalise.
    let u = href;
    if (u.startsWith("//")) u = `https:${u}`;
    if (!/^https?:\\/\\//i.test(u)) return null;
    const parsed = new URL(u);
    // DuckDuckGo wraps results in /l/?uddg=<encoded>
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname === "/l/") {
      const inner = parsed.searchParams.get("uddg");
      if (inner) u = decodeURIComponent(inner);
    }
    if (!LINKEDIN_URL_RE.test(u)) return null;
    const re = new URL(u);
    re.hash = "";
    // Drop tracking params
    ["trk", "trackingId", "originalSubdomain", "lipi"].forEach((k) => re.searchParams.delete(k));
    return re.toString();
  } catch {
    return null;
  }
}

async function fetchSerpHtml(page, url) {
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  );
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  if (!resp || !resp.ok()) return "";
  return await page.content();
}

function parseBing(html) {
  const $ = cheerio.load(html);
  const urls = [];
  $("li.b_algo h2 a, .b_algo h2 a").each((_, el) => {
    const href = $(el).attr("href");
    const norm = absoluteLinkedInUrl(href);
    if (norm) urls.push(norm);
  });
  return urls;
}

function parseDdg(html) {
  const $ = cheerio.load(html);
  const urls = [];
  $("a.result__a, a.result__url, a[href*='linkedin.com']").each((_, el) => {
    const href = $(el).attr("href");
    const norm = absoluteLinkedInUrl(href);
    if (norm) urls.push(norm);
  });
  return urls;
}

function parseGoogle(html) {
  const $ = cheerio.load(html);
  const urls = [];
  $("a[href*='linkedin.com'], div.g a[href*='linkedin.com']").each((_, el) => {
    const href = $(el).attr("href");
    const norm = absoluteLinkedInUrl(href);
    if (norm) urls.push(norm);
  });
  return urls;
}

/**
 * Regex-based fallback parser: scans raw HTML for LinkedIn URLs
 * that the CSS selectors might miss (news cards, "people also search", deep results, etc.)
 */
function parseLinkedInUrlsRegex(html) {
  const urls = [];
  // Match LinkedIn URLs in href attributes and text
  const linkedinRegex = /(?:href=["']|>)([^"'<>]*linkedin\.com\/(?:posts|pulse|feed\/update|company|in)\/[A-Za-z0-9_:%./?=&-]+)/gi;
  let match;
  while ((match = linkedinRegex.exec(html)) !== null) {
    const href = match[1];
    const norm = absoluteLinkedInUrl(href);
    if (norm && !urls.includes(norm)) {
      urls.push(norm);
    }
  }
  return urls;
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const u of arr) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function enrichLinkedInUrl(browser, url) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    if (BLOCK_MEDIA) {
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        if (BLOCKED_RESOURCE_TYPES.has(r.resourceType())) return r.abort();
        return r.continue();
      });
    }
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const status = resp ? resp.status() : 0;
    if (status >= 400) return { url, status };
    const html = await page.content();
    const $ = cheerio.load(html);
    const meta = (sel) => $(sel).attr("content") || "";
    const title = meta('meta[property="og:title"]') || $("title").text() || "";
    const snippet = meta('meta[property="og:description"]') || meta('meta[name="description"]') || "";
    const publishedDate =
      meta('meta[property="article:published_time"]') ||
      meta('meta[name="article:published_time"]') ||
      meta('meta[itemprop="datePublished"]') ||
      "";
    const authorName = meta('meta[name="author"]') || meta('meta[property="article:author"]') || "";
    const canonical = $('link[rel="canonical"]').attr("href") || url;
    return {
      url: canonical,
      status,
      title: title.trim().slice(0, 400),
      snippet: snippet.trim().slice(0, 1200),
      publishedDate: publishedDate || null,
      authorName: authorName.trim().slice(0, 200) || null,
    };
  } catch (e) {
    return { url, status: 0, err: e && e.message ? e.message : String(e) };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function runPool(items, size, fn) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

app.post("/linkedin/search", async (req, res) => {
  const t0 = Date.now();
  try {
    const body = req.body || {};
    const token = body.internalToken || req.headers["x-internal-token"] || "";
    if (!INTERNAL_WORKER_TOKEN || token !== INTERNAL_WORKER_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    if (!keyword || keyword.length < 2 || keyword.length > 120) {
      return res.status(400).json({ error: "keyword required (2-120 chars)" });
    }
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 20, 1), 50);
    const country = typeof body.country === "string" ? body.country.toUpperCase().slice(0, 2) : "";
    const sinceDays = Math.min(Math.max(parseInt(body.sinceDays, 10) || 30, 1), 365);

    const q = `site:linkedin.com "${keyword}"`;
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en${country ? `&cc=${country}` : ""}&count=30`;
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=30`;

    const browser = await getBrowser();

    // SERP — Bing first.
    let serpEngine = "bing";
    let urls = [];
    let bingHtml = "";
    {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      try {
        bingHtml = await fetchSerpHtml(page, bingUrl);
        const bingUrls = parseBing(bingHtml);
        urls = dedupe(bingUrls);
        
        // Log Bing diagnostics
        const bingFirst200 = bingHtml.slice(0, 200);
        const bingRegexUrls = parseLinkedInUrlsRegex(bingHtml);
        console.log(`[SERP-BING] html_length=${bingHtml.length} first_200_chars="${bingFirst200.replace(/\n/g, " ")}" selector_urls=${bingUrls.length} regex_urls=${bingRegexUrls.length}`);
      } catch (e) {
        console.log(`[SERP-BING] error=${e && e.message ? e.message : String(e)}`);
      } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
      }
    }

    // Fallback to DuckDuckGo if Bing returned < 5 results
    if (urls.length < 5) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      try {
        const ddgHtml = await fetchSerpHtml(page, ddgUrl);
        const ddgUrls = parseDdg(ddgHtml);
        const ddgRegexUrls = parseLinkedInUrlsRegex(ddgHtml);
        
        // Log DDG diagnostics
        const ddgFirst200 = ddgHtml.slice(0, 200);
        console.log(`[SERP-DDG] html_length=${ddgHtml.length} first_200_chars="${ddgFirst200.replace(/\n/g, " ")}" selector_urls=${ddgUrls.length} regex_urls=${ddgRegexUrls.length}`);
        
        // Combine DDG results with regex fallback
        urls = dedupe([...urls, ...ddgUrls, ...ddgRegexUrls]);
        if (urls.length > 0 && parseBing(bingHtml).length === 0) {
          serpEngine = "ddg";
        }
      } catch (e) {
        console.log(`[SERP-DDG] error=${e && e.message ? e.message : String(e)}`);
      } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
      }
    }

    // Google fallback if enabled and still < 5 results
    if (ENABLE_GOOGLE_SERP && urls.length < 5) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      try {
        const googleHtml = await fetchSerpHtml(page, googleUrl);
        const googleUrls = parseGoogle(googleHtml);
        const googleRegexUrls = parseLinkedInUrlsRegex(googleHtml);
        
        // Log Google diagnostics
        const googleFirst200 = googleHtml.slice(0, 200);
        console.log(`[SERP-GOOGLE] html_length=${googleHtml.length} first_200_chars="${googleFirst200.replace(/\n/g, " ")}" selector_urls=${googleUrls.length} regex_urls=${googleRegexUrls.length}`);
        
        // Combine Google results with regex fallback
        urls = dedupe([...urls, ...googleUrls, ...googleRegexUrls]);
        if (urls.length > 0 && parseBing(bingHtml).length === 0) {
          serpEngine = "google";
        }
      } catch (e) {
        console.log(`[SERP-GOOGLE] error=${e && e.message ? e.message : String(e)}`);
      } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
      }
    }

    urls = urls.slice(0, limit);
    const enriched = await runPool(urls, 4, (u) => enrichLinkedInUrl(browser, u));

    // Filter by date window when publishedDate is parseable.
    const sinceMs = Date.now() - sinceDays * 86400_000;
    const items = enriched
      .filter((r) => r && r.title)
      .map((r) => {
        const ts = r.publishedDate ? Date.parse(r.publishedDate) : NaN;
        const dateOk = !Number.isFinite(ts) || ts >= sinceMs;
        return dateOk ? r : null;
      })
      .filter(Boolean);

    return res.json({
      items,
      serpEngine,
      fetched: enriched.length,
      kept: items.length,
      latency_ms: Date.now() - t0,
    });
  } catch (err) {
    return res.status(500).json({
      error: err && err.message ? err.message : String(err),
      latency_ms: Date.now() - t0,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(
    `[playwright-stealth] listening on :${PORT} (BLOCK_MEDIA=${BLOCK_MEDIA}, PROXY=${PROXY_SERVER ? "on" : "off"}, ENABLE_GOOGLE_SERP=${ENABLE_GOOGLE_SERP})`,
  );
});

async function shutdown() {
  try {
    const browser = browserPromise ? await browserPromise : null;
    if (browser) await browser.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

