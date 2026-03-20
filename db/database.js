'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');

const MODULE = 'database';
let pool;

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------
function connect() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // required for Neon
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    logger.error('pg_pool_error', MODULE, { err: err.message });
  });

  logger.info('db_connected', MODULE);
}

// ---------------------------------------------------------------------------
// Migrate — safe to run on every startup
// ---------------------------------------------------------------------------
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ma_listings (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      source_domain   TEXT NOT NULL,
      url             TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_listings_source
      ON ma_listings(source);

    CREATE INDEX IF NOT EXISTS idx_listings_first_seen
      ON ma_listings(first_seen_at DESC);

    CREATE TABLE IF NOT EXISTS ma_run_log (
      id              BIGSERIAL PRIMARY KEY,
      started_at      TIMESTAMPTZ NOT NULL,
      finished_at     TIMESTAMPTZ NOT NULL,
      duration_ms     INTEGER NOT NULL,
      total_sites     INTEGER NOT NULL,
      sites_succeeded INTEGER NOT NULL,
      sites_failed    INTEGER NOT NULL,
      total_scraped   INTEGER NOT NULL,
      new_found       INTEGER NOT NULL,
      status          TEXT NOT NULL,
      error_summary   TEXT,
      per_site_stats  JSONB
    );
  `);

  logger.info('db_migrated', MODULE);
}

// ---------------------------------------------------------------------------
// Count existing listings — used for first-run detection
// ---------------------------------------------------------------------------
async function countListings() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ma_listings');
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Upsert listings
//
// Uses xmax trick: xmax = 0 on a fresh insert, non-zero on an update.
// Batches at 200 rows per transaction.
// Preserves first_seen_at on conflict; refreshes title/description/url/last_seen_at.
//
// Returns { insertedCount, updatedCount }
// ---------------------------------------------------------------------------
async function upsertListings(listings) {
  if (!listings.length) return { insertedCount: 0, updatedCount: 0 };

  const BATCH = 200;
  let insertedCount = 0;
  let updatedCount = 0;

  for (let i = 0; i < listings.length; i += BATCH) {
    const batch = listings.slice(i, i + BATCH);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Build parameterised multi-row insert
      const values = [];
      const placeholders = batch.map((row, idx) => {
        const base = idx * 7;
        values.push(
          row.id,
          row.source,
          row.source_domain,
          row.url,
          row.title,
          row.description ?? null,
          row.first_seen_at ?? new Date(),
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},NOW())`;
      });

      const sql = `
        WITH upserted AS (
          INSERT INTO ma_listings
            (id, source, source_domain, url, title, description, first_seen_at, last_seen_at)
          VALUES ${placeholders.join(',')}
          ON CONFLICT (id) DO UPDATE SET
            title         = EXCLUDED.title,
            description   = EXCLUDED.description,
            url           = EXCLUDED.url,
            last_seen_at  = NOW()
          RETURNING (xmax = 0) AS is_insert
        )
        SELECT
          COUNT(*) FILTER (WHERE is_insert)      AS inserted_count,
          COUNT(*) FILTER (WHERE NOT is_insert)  AS updated_count
        FROM upserted
      `;

      const { rows } = await client.query(sql, values);
      await client.query('COMMIT');

      insertedCount += Number(rows[0].inserted_count);
      updatedCount  += Number(rows[0].updated_count);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('upsert_batch_failed', MODULE, { err: err.message, batchStart: i });
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info('upsert_complete', MODULE, { insertedCount, updatedCount });
  return { insertedCount, updatedCount };
}

// ---------------------------------------------------------------------------
// Baseline — most recent successful per-site stats for anomaly detection.
//
// Queries the last 20 runs and, for each site, picks the most recent run
// where that site's status === 'success'. Simple and robust.
//
// Returns Map<domain, { listingsFound, pagesVisited }>
// ---------------------------------------------------------------------------
async function getBaselinePerSite() {
  const { rows } = await pool.query(`
    SELECT per_site_stats
    FROM   ma_run_log
    WHERE  status IN ('success', 'partial')
      AND  per_site_stats IS NOT NULL
    ORDER  BY finished_at DESC
    LIMIT  20
  `);

  const baseline = new Map();

  // Walk runs newest-first; first hit per site wins
  for (const row of rows) {
    const stats = row.per_site_stats;
    if (!Array.isArray(stats)) continue;

    for (const site of stats) {
      if (site.status === 'success' && !baseline.has(site.site)) {
        baseline.set(site.site, {
          listingsFound: site.normalizedValidListings ?? 0,
          pagesVisited:  site.pagesVisited ?? 0,
        });
      }
    }
  }

  return baseline;
}

// ---------------------------------------------------------------------------
// Log run — always called, even on partial failure
// ---------------------------------------------------------------------------
async function logRun(stats) {
  const {
    startedAt,
    finishedAt,
    totalSites,
    sitesSucceeded,
    sitesFailed,
    totalScraped,
    newFound,
    status,
    errorSummary,
    perSiteStats,
  } = stats;

  try {
    await pool.query(
      `INSERT INTO ma_run_log
         (started_at, finished_at, duration_ms, total_sites, sites_succeeded,
          sites_failed, total_scraped, new_found, status, error_summary, per_site_stats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        startedAt,
        finishedAt,
        finishedAt - startedAt,
        totalSites,
        sitesSucceeded,
        sitesFailed,
        totalScraped,
        newFound,
        status,
        errorSummary ?? null,
        perSiteStats ? JSON.stringify(perSiteStats) : null,
      ],
    );
    logger.info('run_logged', MODULE, { status, newFound });
  } catch (err) {
    // Non-fatal — don't let log failure crash the process
    logger.error('run_log_failed', MODULE, { err: err.message });
  }
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------
async function close() {
  if (pool) {
    await pool.end();
    logger.info('db_closed', MODULE);
  }
}

module.exports = { connect, migrate, countListings, upsertListings, getBaselinePerSite, logRun, close };
