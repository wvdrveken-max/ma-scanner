'use strict';

require('dotenv').config();

const puppeteer = require('puppeteer');
const db        = require('./db/database');
const { scrape } = require('./scraper/engine');
const { sendDigest, sendAlert } = require('./email/mailer');
const logger    = require('./utils/logger');
const allSites  = require('./scraper/sites');

const MODULE = 'index';

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {
    dryRun:         false,
    noEmail:        false,
    debug:          false,
    forcePuppeteer: false,
    siteFilter:     null,
  };

  for (const arg of args) {
    if (arg === '--dry-run')          flags.dryRun         = true;
    else if (arg === '--no-email')    flags.noEmail        = true;
    else if (arg === '--debug')       flags.debug          = true;
    else if (arg === '--force-puppeteer') flags.forcePuppeteer = true;
    else if (arg.startsWith('--site=')) flags.siteFilter   = arg.slice(7).toLowerCase();
  }

  if (flags.debug) process.env.DEBUG = '1';
  return flags;
}

// ---------------------------------------------------------------------------
// Startup: validate required env vars
// ---------------------------------------------------------------------------
function validateEnv(flags) {
  const required = ['DATABASE_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'NOTIFY_TO'];

  // In dry-run we still need DB; email vars only matter if email will be sent
  const emailRequired = !flags.dryRun && !flags.noEmail;
  const toCheck = emailRequired
    ? required
    : required.filter((k) => k === 'DATABASE_URL');

  const missing = toCheck.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error('missing_env_vars', MODULE, { missing });
    process.exit(1);
  }

  const recipients = (process.env.NOTIFY_TO || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (emailRequired && recipients.length === 0) {
    logger.error('notify_to_empty', MODULE);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------
function detectAnomalies(perSiteStats, baseline) {
  const anomalies = [];

  for (const stat of perSiteStats) {
    if (stat.status === 'failed') continue; // already counted as failure

    const base = baseline.get(stat.site);

    // Extraction anomaly: found raw items but none survived normalization
    if (stat.rawItemsFound > 0 && stat.normalizedValidListings === 0) {
      anomalies.push({
        site:   stat.site,
        reason: `Extraction anomaly: ${stat.rawItemsFound} raw items found but 0 survived normalization (selector or parse issue)`,
      });
      continue;
    }

    if (!base) continue; // no baseline yet for this site

    const current = stat.normalizedValidListings;

    // Hard anomaly: site had listings before, now has zero
    if (base.listingsFound > 0 && current === 0) {
      anomalies.push({
        site:   stat.site,
        reason: `Hard anomaly: previously returned ${base.listingsFound} listings, now returns 0`,
      });
      continue;
    }

    // Soft anomaly: significant drop (< 20% of baseline, baseline >= 10)
    if (base.listingsFound >= 10 && current < base.listingsFound * 0.2) {
      anomalies.push({
        site:   stat.site,
        reason: `Soft anomaly: dropped from ${base.listingsFound} to ${current} listings (< 20% of baseline)`,
      });
      continue;
    }

    // Pagination anomaly: site used to have multiple pages, now only 1
    if (base.pagesVisited > 2 && stat.pagesVisited === 1) {
      anomalies.push({
        site:   stat.site,
        reason: `Pagination anomaly: previously visited ${base.pagesVisited} pages, now only 1`,
      });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Bounded concurrency helper
// ---------------------------------------------------------------------------
async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Graceful shutdown helpers
// ---------------------------------------------------------------------------
let _browser;
let _dbConnected = false;

async function shutdown(code = 0) {
  logger.info('shutdown', MODULE);
  if (_browser) await _browser.close().catch(() => {});
  if (_dbConnected) await db.close().catch(() => {});
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = new Date();
  const flags     = parseArgs();

  validateEnv(flags);

  logger.info('run_start', MODULE, {
    dryRun:         flags.dryRun,
    noEmail:        flags.noEmail,
    siteFilter:     flags.siteFilter,
    forcePuppeteer: flags.forcePuppeteer,
  });

  // DB
  db.connect();
  _dbConnected = true;
  await db.migrate();

  // First-run detection
  const listingsCountBefore = await db.countListings();
  const isFirstRun          = listingsCountBefore === 0;

  // Baseline for anomaly detection
  const baseline = await db.getBaselinePerSite();
  logger.info('baseline_loaded', MODULE, { sites: baseline.size });

  // Filter + apply flags to sites
  let sites = allSites.filter((s) => s.enabled !== false);
  if (flags.siteFilter) {
    sites = sites.filter((s) => s.domain.toLowerCase().includes(flags.siteFilter));
    if (!sites.length) {
      logger.error('no_sites_match_filter', MODULE, { filter: flags.siteFilter });
      await shutdown(1);
    }
  }
  if (flags.forcePuppeteer) {
    sites = sites.map((s) => ({ ...s, needsJS: true }));
  }

  // Launch Puppeteer only if at least one site needs it
  const anyNeedsJS = sites.some((s) => s.needsJS);
  if (anyNeedsJS) {
    logger.info('puppeteer_launch', MODULE);
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  // Scrape all sites with bounded concurrency (3 parallel)
  const CONCURRENCY = 3;
  const tasks = sites.map((site) => () => scrape(site, _browser));
  const siteResults = await runWithConcurrency(tasks, CONCURRENCY);

  // Close browser as soon as scraping is done
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }

  // Flatten listings + collect per-site stats
  const allListings   = siteResults.flatMap((r) => r.listings);
  const perSiteStats  = siteResults.map((r) => r.stat);

  // Deduplicate across sites by id
  const seenIds    = new Set();
  const dedupedAll = allListings.filter((l) => {
    if (seenIds.has(l.id)) return false;
    seenIds.add(l.id);
    return true;
  });

  logger.info('dedup_complete', MODULE, { total: allListings.length, deduped: dedupedAll.length });

  // Upsert to DB (skip in dry-run)
  let insertedCount = 0;
  let updatedCount  = 0;

  if (!flags.dryRun) {
    try {
      ({ insertedCount, updatedCount } = await db.upsertListings(dedupedAll));
    } catch (err) {
      logger.error('upsert_failed', MODULE, { err: err.message });
      // Continue to log run + potentially send alerts
    }
  } else {
    logger.info('dry_run_skip_upsert', MODULE, { wouldInsert: dedupedAll.length });
  }

  // Patch newListingsInserted back onto per-site stats (best-effort proportional)
  // We track counts per domain from the upserted set
  const newByDomain = {};
  if (!flags.dryRun && insertedCount > 0) {
    for (const l of dedupedAll) {
      newByDomain[l.source_domain] = (newByDomain[l.source_domain] || 0);
    }
    // We can't know per-site counts from a bulk upsert; set to 0 for per-site
    // The total insertedCount is accurate at run level
  }

  // Classify site outcomes
  const siteFailures = perSiteStats
    .filter((s) => s.status === 'failed')
    .map((s) => ({ site: s.site, reason: s.error || 'Unknown error' }));

  const sitesSucceeded = perSiteStats.filter((s) => s.status !== 'failed').length;

  // Anomaly detection
  const anomalies = detectAnomalies(perSiteStats, baseline);

  // Summary
  logger.info('run_summary', MODULE, {
    sites:          sites.length,
    sitesSucceeded,
    sitesFailed:    siteFailures.length,
    totalScraped:   dedupedAll.length,
    newFound:       insertedCount,
    anomalies:      anomalies.length,
    firstRun:       isFirstRun,
    dryRun:         flags.dryRun,
  });

  // Email
  if (!flags.noEmail && !flags.dryRun) {
    const ranAt = new Date();
    const runStats = {
      ranAt,
      totalSites:       sites.length,
      sitesSucceeded,
      sitesFailed:      siteFailures.length,
      failedSiteDetails: siteFailures.map((f) => `${f.site} (${f.reason})`),
    };

    // Digest — skip on first run
    if (!isFirstRun && insertedCount > 0) {
      // Fetch the newly inserted listings to pass to email
      // (use dedupedAll filtered to newly inserted — approximated as full batch on first non-baseline run)
      const newListings = dedupedAll.slice(0, insertedCount); // conservative; actual new are a subset
      await sendDigest(newListings, runStats).catch((err) => {
        logger.error('digest_send_error', MODULE, { err: err.message });
      });
    } else if (!isFirstRun) {
      logger.info('no_new_listings_skip_digest', MODULE);
    }

    // Alert — send if failures or anomalies (including on first run)
    const shouldAlert = siteFailures.length > 0 || anomalies.length > 0;
    if (shouldAlert) {
      await sendAlert(siteFailures, anomalies, ranAt).catch((err) => {
        logger.error('alert_send_error', MODULE, { err: err.message });
      });
    }
  } else if (flags.dryRun) {
    logger.info('dry_run_skip_email', MODULE);
  }

  // First-run message
  if (isFirstRun && !flags.dryRun) {
    logger.info('first_run_baseline', MODULE, {
      message: 'First run: baseline established',
      listingsStored: dedupedAll.length,
    });
  }

  // Log run
  const finishedAt = new Date();
  await db.logRun({
    startedAt,
    finishedAt,
    totalSites:    sites.length,
    sitesSucceeded,
    sitesFailed:   siteFailures.length,
    totalScraped:  dedupedAll.length,
    newFound:      insertedCount,
    status:        flags.dryRun
      ? 'dry_run'
      : siteFailures.length === sites.length
        ? 'failed'
        : siteFailures.length > 0
          ? 'partial'
          : 'success',
    errorSummary:  siteFailures.length > 0
      ? siteFailures.map((f) => `${f.site}: ${f.reason}`).join('; ')
      : null,
    perSiteStats,
  });

  logger.info('run_complete', MODULE, {
    durationMs:  finishedAt - startedAt,
    newFound:    insertedCount,
    emailSent:   !flags.dryRun && !flags.noEmail && (!isFirstRun && insertedCount > 0),
  });
}

// ---------------------------------------------------------------------------
// Process-level error handlers
// ---------------------------------------------------------------------------
process.on('unhandledRejection', async (reason) => {
  logger.error('unhandled_rejection', MODULE, { reason: String(reason) });
  await shutdown(1);
});

process.on('uncaughtException', async (err) => {
  logger.error('uncaught_exception', MODULE, { err: err.message, stack: err.stack });
  await shutdown(1);
});

process.on('SIGINT',  () => { logger.info('SIGINT',  MODULE); shutdown(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM', MODULE); shutdown(0); });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
main().then(() => shutdown(0)).catch(async (err) => {
  logger.error('main_failed', MODULE, { err: err.message, stack: err.stack });
  await shutdown(1);
});
