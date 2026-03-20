'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const crypto  = require('crypto');
const https   = require('https');
const { URL } = require('url');
const logger  = require('../utils/logger');

const MODULE = 'engine';

// ---------------------------------------------------------------------------
// User-agent pool
// ---------------------------------------------------------------------------
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return delay(min + Math.floor(Math.random() * (max - min)));
}

// ---------------------------------------------------------------------------
// URL canonicalization — strip tracking params, normalize host/trailing slash
// ---------------------------------------------------------------------------
const TRACKING_PARAMS = new Set([
  'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
  'gclid','fbclid','msclkid','dclid','gclsrc','_ga','_gl',
]);

function canonicalizeUrl(rawUrl, baseUrl) {
  let resolved;
  try {
    resolved = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(resolved.protocol)) return null;

  resolved.hostname = resolved.hostname.toLowerCase();
  resolved.hash     = '';

  for (const key of [...resolved.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      resolved.searchParams.delete(key);
    }
  }

  // Normalize trailing slash: remove unless path is just '/'
  if (resolved.pathname.length > 1 && resolved.pathname.endsWith('/')) {
    resolved.pathname = resolved.pathname.slice(0, -1);
  }

  return resolved.toString();
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------
function generateId(sourceDomain, canonicalUrl) {
  return crypto
    .createHash('sha256')
    .update(`${sourceDomain}${canonicalUrl}`)
    .digest('hex');
}

function generateIdFromTitle(sourceDomain, title) {
  return crypto
    .createHash('sha256')
    .update(`${sourceDomain}${title.trim().toLowerCase()}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Listing normalization
// ---------------------------------------------------------------------------
const BOILERPLATE_TRAILING = [
  /[\s\-–|]+lees\s*meer\.?$/i,
  /[\s\-–|]+read\s*more\.?$/i,
  /[\s\-–|]+meer\s*info\.?$/i,
  /[\s\-–|]+klik\s*hier\.?$/i,
  /[\s\-–|]+bekijk\.?$/i,
  /[\s\-–|]+details\.?$/i,
];

// Strings that are UI labels / badges, not actual listing titles.
// If extracted title matches one of these exactly, fall back to URL slug.
const JUNK_TITLES = new Set([
  'in de kijker', 'featured', 'nieuw', 'new', 'sold', 'verkocht',
  'onder bod', 'onder optie', 'read more', 'lees meer', 'meer info',
  'bekijk', 'details', 'contact', 'portfolio', 'aanbod', 'overzicht',
  'home', 'kopen', 'te koop', 'over te nemen', 'bedrijven te koop',
  'referenties', 'references', 'opdrachten',
]);

function stripBoilerplate(text) {
  if (!text) return text;
  let result = text;
  for (const re of BOILERPLATE_TRAILING) {
    result = result.replace(re, '');
  }
  return result.replace(/\s+/g, ' ').trim();
}

// Convert a URL slug to a readable title: "my-business-name" → "My Business Name"
function slugToTitle(url) {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return slug
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  } catch {
    return '';
  }
}

function normalizeListing(raw, siteConfig) {
  const { startUrl, domain, idStrategy = 'url', filters = {} } = siteConfig;
  const minTitleLength = filters.minTitleLength ?? 5;

  // URL — validate first so we can use it for slug fallback
  const canonUrl = canonicalizeUrl(raw.url, startUrl);
  if (!canonUrl) return null;

  // Filter out the category/start page leaking in as a listing
  const canonStart = canonicalizeUrl(startUrl, startUrl);
  if (canonUrl === canonStart) return null;

  // Title — check for junk labels and fall back to URL slug
  let title = stripBoilerplate((raw.title || '').replace(/\s+/g, ' ').trim());
  if (!title || JUNK_TITLES.has(title.toLowerCase())) {
    title = slugToTitle(canonUrl);
  }
  if (!title || title.length < minTitleLength) return null;

  // Description — store full (up to 1000 chars); truncation for email only
  let description = raw.description
    ? stripBoilerplate(raw.description.replace(/\s+/g, ' ').trim()).slice(0, 1000) || null
    : null;
  // Don't store description if it's identical to the title (adds no value)
  if (description && description.toLowerCase() === title.toLowerCase()) {
    description = null;
  }

  // ID
  let id;
  if (idStrategy === 'title+domain') {
    // Emergency fallback only — warns in log
    logger.warn('id_strategy_title_domain', MODULE, { site: domain, title });
    id = generateIdFromTitle(domain, title);
  } else {
    id = generateId(domain, canonUrl);
  }

  return {
    id,
    source:        siteConfig.name,
    source_domain: domain,
    url:           canonUrl,
    title,
    description,
  };
}

// ---------------------------------------------------------------------------
// fetchWithCheerio — axios + cheerio, 3 retries with exponential backoff
// ---------------------------------------------------------------------------
async function fetchWithCheerio(url, { ignoreSSLErrors = false } = {}) {
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  let attempt = 0;
  let lastErr;

  while (attempt < 3) {
    if (attempt > 0) await delay(1000 * Math.pow(2, attempt - 1));

    try {
      const resp = await axios.get(url, {
        timeout: 25_000,
        headers: {
          'User-Agent':      randomUA(),
          'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        maxRedirects: 5,
        validateStatus: null, // handle status ourselves
        ...(ignoreSSLErrors && {
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        }),
      });

      const status = resp.status;
      const size   = resp.data?.length ?? 0;

      if (status === 404) {
        logger.warn('fetch_404', MODULE, { url, status });
        return null;
      }

      if (status === 403) {
        logger.warn('fetch_403_skipping', MODULE, { url, status });
        return null; // do not retry
      }

      if (RETRYABLE.has(status)) {
        logger.warn('fetch_retryable_status', MODULE, { url, status, attempt });
        lastErr = new Error(`HTTP ${status}`);
        attempt++;
        continue;
      }

      if (status < 200 || status >= 300) {
        logger.warn('fetch_unexpected_status', MODULE, { url, status });
        return null;
      }

      logger.debug('fetch_ok', MODULE, { url, status, sizeBytes: size, attempt });
      return cheerio.load(resp.data);

    } catch (err) {
      lastErr = err;
      logger.warn('fetch_error', MODULE, { url, err: err.message, attempt });
      attempt++;
    }
  }

  throw lastErr ?? new Error(`Failed to fetch ${url}`);
}

// ---------------------------------------------------------------------------
// fetchWithPuppeteer — uses shared browser instance passed from caller
// ---------------------------------------------------------------------------
async function fetchWithPuppeteer(url, browser) {
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(randomUA());
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8' });

    // Block images, fonts, media — NOT stylesheets (can break JS layout)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
    const html = await page.content();
    logger.debug('puppeteer_fetch_ok', MODULE, { url });
    return cheerio.load(html);

  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Build next-page URL from pagination config
// ---------------------------------------------------------------------------
function getNextUrl($, pagination, currentUrl, baseUrl, visitedUrls) {
  if (!pagination || pagination.type === 'none') return null;

  const { type, selector } = pagination;

  if (type === 'next') {
    const href = $(selector).first().attr('href');
    if (!href) return null;
    try {
      const next = new URL(href, baseUrl).toString();
      return visitedUrls.has(next) ? null : next;
    } catch {
      return null;
    }
  }

  if (type === 'numbered') {
    // Find the active page number and look for the next one
    const links = $(selector);
    let foundActive = false;
    let nextUrl = null;
    links.each((_, el) => {
      const $el = $(el);
      // Consider 'active', 'current', aria-current as signals
      const isActive =
        $el.hasClass('active') ||
        $el.hasClass('current') ||
        $el.attr('aria-current') === 'page' ||
        $el.parent().hasClass('active') ||
        $el.parent().hasClass('current');

      if (foundActive && !nextUrl) {
        const href = $el.attr('href') || $el.find('a').attr('href');
        if (href) {
          try {
            const candidate = new URL(href, baseUrl).toString();
            if (!visitedUrls.has(candidate)) nextUrl = candidate;
          } catch {}
        }
      }
      if (isActive) foundActive = true;
    });
    return nextUrl;
  }

  // 'loadmore' — JS-driven; Puppeteer handles this differently; return null for Cheerio
  return null;
}

// ---------------------------------------------------------------------------
// Extract listings from a loaded Cheerio page
// ---------------------------------------------------------------------------
function extractListings($, siteConfig, pageUrl) {
  const { selectors, startUrl } = siteConfig;
  const raw = [];

  $(selectors.item).each((_, el) => {
    const $el = $(el);

    let title = '';
    if (selectors.title) {
      title = $el.find(selectors.title).first().text().trim();
      if (!title) title = $el.find(selectors.title).first().attr('title') || '';
    }
    // Fallback: use the item element's own text (e.g. when item is <h3> and title selector is empty)
    if (!title) title = $el.text().trim();

    let link = $el.find(selectors.link).first().attr('href');
    if (!link) link = $el.is('a') ? $el.attr('href') : null;

    let description = '';
    if (selectors.description) {
      description = $el.find(selectors.description).first().text().trim();
    }

    if (title || link) {
      raw.push({ title, url: link || pageUrl, description });
    }
  });

  return raw;
}

// ---------------------------------------------------------------------------
// scrape(siteConfig, browser) — main per-site entry point
// ---------------------------------------------------------------------------
async function scrape(siteConfig, browser) {
  const {
    name,
    domain,
    startUrl,
    needsJS      = false,
    maxPages     = 20,
    rateLimitMsMin = 2000,
    rateLimitMsMax = 4000,
    pagination,
  } = siteConfig;

  const MAX_LISTINGS   = 500;
  const SITE_TIMEOUT   = 3 * 60 * 1000; // 3 minutes
  const startTime      = Date.now();

  let pagesVisited         = 0;
  let rawItemsFound        = 0;
  let normalizedListings   = [];
  let fetchMode            = needsJS ? 'puppeteer' : 'cheerio';
  let siteStatus           = 'success';
  let siteError            = null;
  let usedFallback         = false;

  const visitedUrls = new Set();
  let currentUrl    = startUrl;

  try {
    while (currentUrl && pagesVisited < maxPages) {
      if (Date.now() - startTime > SITE_TIMEOUT) {
        logger.warn('site_timeout', MODULE, { site: name, pagesVisited });
        siteStatus = 'partial';
        break;
      }

      if (visitedUrls.has(currentUrl)) {
        logger.warn('pagination_loop_detected', MODULE, { site: name, url: currentUrl });
        break;
      }
      visitedUrls.add(currentUrl);

      let $;
      try {
        if (needsJS || usedFallback) {
          $ = await fetchWithPuppeteer(currentUrl, browser);
          if (usedFallback) fetchMode = 'fallback';
        } else {
          $ = await fetchWithCheerio(currentUrl, { ignoreSSLErrors: siteConfig.ignoreSSLErrors });
        }
      } catch (fetchErr) {
        logger.warn('page_fetch_failed', MODULE, { site: name, url: currentUrl, err: fetchErr.message });
        siteStatus = pagesVisited > 0 ? 'partial' : 'failed';
        siteError  = fetchErr.message;
        break;
      }

      if (!$) {
        siteStatus = pagesVisited > 0 ? 'partial' : 'failed';
        siteError  = 'No response (null)';
        break;
      }

      const pageRaw = extractListings($, siteConfig, currentUrl);

      // Cheerio→Puppeteer automatic fallback on page 1 zero result
      // Skipped if noPuppeteerFallback is set (e.g. HTTP sites that Chromium blocks)
      if (pageRaw.length === 0 && pagesVisited === 0 && !needsJS && !usedFallback && !siteConfig.noPuppeteerFallback) {
        logger.info('cheerio_fallback_puppeteer', MODULE, { site: name });
        usedFallback = true;
        visitedUrls.delete(currentUrl); // allow retry of same URL
        continue;
      }

      rawItemsFound += pageRaw.length;
      pagesVisited++;

      // Normalize
      for (const raw of pageRaw) {
        if (normalizedListings.length >= MAX_LISTINGS) break;
        const normalized = normalizeListing(raw, siteConfig);
        if (normalized) normalizedListings.push(normalized);
      }

      if (normalizedListings.length >= MAX_LISTINGS) {
        logger.warn('max_listings_cap_reached', MODULE, { site: name });
        break;
      }

      // Next page
      const nextUrl = getNextUrl($, pagination, currentUrl, startUrl, visitedUrls);
      if (!nextUrl) break;

      currentUrl = nextUrl;
      if (pagesVisited < maxPages) {
        await randomDelay(rateLimitMsMin, rateLimitMsMax);
      }
    }

    // Deduplicate within this site's batch (by id)
    const seen  = new Set();
    const deduped = normalizedListings.filter((l) => {
      if (seen.has(l.id)) return false;
      seen.add(l.id);
      return true;
    });

    const stat = {
      site:                    domain,
      status:                  siteStatus,
      pagesVisited,
      rawItemsFound,
      normalizedValidListings: normalizedListings.length,
      dedupedListings:         deduped.length,
      newListingsInserted:     0, // filled in by index.js after upsert
      durationMs:              Date.now() - startTime,
      fetchMode,
      error:                   siteError,
    };

    logger.info('site_scraped', MODULE, stat);
    return { listings: deduped, stat };

  } catch (err) {
    const stat = {
      site:                    domain,
      status:                  'failed',
      pagesVisited,
      rawItemsFound,
      normalizedValidListings: 0,
      dedupedListings:         0,
      newListingsInserted:     0,
      durationMs:              Date.now() - startTime,
      fetchMode,
      error:                   err.message,
    };
    logger.error('site_failed', MODULE, { site: name, err: err.message });
    return { listings: [], stat };
  }
}

module.exports = { scrape, canonicalizeUrl, generateId, normalizeListing };
