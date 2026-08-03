'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');

const MODULE = 'staatsblad-db';
let pool;

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------
function connect() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
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
    CREATE TABLE IF NOT EXISTS staatsblad_entries (
      id                  TEXT PRIMARY KEY,
      type                TEXT NOT NULL,
      company_name        TEXT NOT NULL,
      enterprise_number   TEXT,
      address             TEXT,
      business_activity   TEXT,
      court               TEXT NOT NULL,
      judge               TEXT,
      curator_name        TEXT,
      curator_email       TEXT,
      curator_address     TEXT,
      event_date          DATE,
      cessation_date      DATE,
      moratorium_end_date DATE,
      reference           TEXT,
      publication_date    DATE NOT NULL,
      first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_text            TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sb_entries_type
      ON staatsblad_entries(type);

    CREATE INDEX IF NOT EXISTS idx_sb_entries_pub_date
      ON staatsblad_entries(publication_date DESC);

    CREATE INDEX IF NOT EXISTS idx_sb_entries_first_seen
      ON staatsblad_entries(first_seen_at DESC);

    CREATE TABLE IF NOT EXISTS staatsblad_run_log (
      id                  BIGSERIAL PRIMARY KEY,
      started_at          TIMESTAMPTZ NOT NULL,
      finished_at         TIMESTAMPTZ NOT NULL,
      duration_ms         INTEGER NOT NULL,
      publication_date    DATE,
      pdf_url             TEXT,
      status              TEXT NOT NULL,
      total_found         INTEGER NOT NULL,
      flemish_found       INTEGER NOT NULL,
      new_inserted        INTEGER NOT NULL,
      type_breakdown      JSONB,
      error_summary       TEXT
    );
  `);

  logger.info('db_migrated', MODULE);
}

// ---------------------------------------------------------------------------
// Upsert entries — insert new, skip existing (idempotent by id)
// Returns { insertedCount }
// ---------------------------------------------------------------------------
async function upsertEntries(entries) {
  if (!entries.length) return { insertedCount: 0 };

  const BATCH = 200;
  let insertedCount = 0;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const values = [];
      const placeholders = batch.map((row, idx) => {
        const base = idx * 16;
        values.push(
          row.id,
          row.type,
          row.company_name,
          row.enterprise_number ?? null,
          row.address ?? null,
          row.business_activity ?? null,
          row.court,
          row.judge ?? null,
          row.curator_name ?? null,
          row.curator_email ?? null,
          row.curator_address ?? null,
          row.event_date ?? null,
          row.cessation_date ?? null,
          row.moratorium_end_date ?? null,
          row.reference ?? null,
          row.publication_date,
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16})`;
      });

      const sql = `
        WITH inserted AS (
          INSERT INTO staatsblad_entries
            (id, type, company_name, enterprise_number, address, business_activity,
             court, judge, curator_name, curator_email, curator_address,
             event_date, cessation_date, moratorium_end_date, reference, publication_date)
          VALUES ${placeholders.join(',')}
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        )
        SELECT COUNT(*) AS cnt FROM inserted
      `;

      const { rows } = await client.query(sql, values);
      await client.query('COMMIT');

      insertedCount += Number(rows[0].cnt);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('upsert_batch_failed', MODULE, { err: err.message, batchStart: i });
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info('upsert_complete', MODULE, { insertedCount });
  return { insertedCount };
}

// ---------------------------------------------------------------------------
// Get entries inserted since a given timestamp
// ---------------------------------------------------------------------------
async function getNewEntriesSince(since) {
  const { rows } = await pool.query(
    `SELECT *
     FROM   staatsblad_entries
     WHERE  first_seen_at >= $1
     ORDER  BY type, company_name`,
    [since],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Log run
// ---------------------------------------------------------------------------
async function logRun(stats) {
  const {
    startedAt,
    finishedAt,
    publicationDate,
    pdfUrl,
    status,
    totalFound,
    flemishFound,
    newInserted,
    typeBreakdown,
    errorSummary,
  } = stats;

  try {
    await pool.query(
      `INSERT INTO staatsblad_run_log
         (started_at, finished_at, duration_ms, publication_date, pdf_url,
          status, total_found, flemish_found, new_inserted, type_breakdown, error_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        startedAt,
        finishedAt,
        finishedAt - startedAt,
        publicationDate ?? null,
        pdfUrl ?? null,
        status,
        totalFound ?? 0,
        flemishFound ?? 0,
        newInserted ?? 0,
        typeBreakdown ? JSON.stringify(typeBreakdown) : null,
        errorSummary ?? null,
      ],
    );
    logger.info('run_logged', MODULE, { status, newInserted });
  } catch (err) {
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

module.exports = { connect, migrate, upsertEntries, getNewEntriesSince, logRun, close };
