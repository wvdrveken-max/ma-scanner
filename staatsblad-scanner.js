'use strict';

require('dotenv').config();

const engine         = require('./staatsblad/engine');
const db             = require('./staatsblad/db');
const { sendDigest } = require('./staatsblad/mailer');
const logger         = require('./utils/logger');

const MODULE = 'staatsblad-scanner';

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {
    dryRun:  false,
    noEmail: false,
    debug:   false,
    date:    null,
  };

  for (const arg of args) {
    if (arg === '--dry-run')        flags.dryRun  = true;
    else if (arg === '--no-email')  flags.noEmail = true;
    else if (arg === '--debug')     flags.debug   = true;
    else if (arg.startsWith('--date=')) flags.date = arg.slice(7);
  }

  if (flags.debug) process.env.DEBUG = '1';
  return flags;
}

// ---------------------------------------------------------------------------
// Validate env vars
// ---------------------------------------------------------------------------
function validateEnv(flags) {
  const required = ['DATABASE_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'NOTIFY_TO'];

  const emailRequired = !flags.dryRun && !flags.noEmail;
  const toCheck = flags.dryRun
    ? []
    : emailRequired
      ? required
      : required.filter((k) => k === 'DATABASE_URL');

  const missing = toCheck.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error('missing_env_vars', MODULE, { missing });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Today's date in YYYY-MM-DD
// ---------------------------------------------------------------------------
function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let _dbConnected = false;

async function shutdown(code = 0) {
  logger.info('shutdown', MODULE);
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

  const dateStr = flags.date || todayStr();

  logger.info('run_start', MODULE, {
    dryRun:  flags.dryRun,
    noEmail: flags.noEmail,
    date:    dateStr,
  });

  // Connect DB (skip in dry-run)
  if (!flags.dryRun) {
    db.connect();
    _dbConnected = true;
    await db.migrate();
  }

  // Run engine: download + parse
  const { entries, stats } = await engine.run(dateStr);

  logger.info('parse_summary', MODULE, {
    totalFound:    stats.totalFound,
    typeBreakdown: stats.typeBreakdown,
  });

  if (flags.dryRun) {
    // In dry-run mode, display entries to stdout
    logger.info('dry_run_results', MODULE, { count: entries.length });
    for (const e of entries) {
      logger.info('entry', MODULE, {
        type:              e.type,
        company:           e.company_name,
        enterprise_number: e.enterprise_number,
        court:             e.court,
        activity:          e.business_activity,
        curator:           e.curator_name,
        curator_email:     e.curator_email,
        event_date:        e.event_date,
        reference:         e.reference,
      });
    }

    const finishedAt = new Date();
    logger.info('run_complete', MODULE, {
      durationMs: finishedAt - startedAt,
      dryRun:     true,
      found:      entries.length,
    });
    return;
  }

  // Upsert to DB
  let insertedCount = 0;
  if (entries.length > 0) {
    try {
      ({ insertedCount } = await db.upsertEntries(entries));
    } catch (err) {
      logger.error('upsert_failed', MODULE, { err: err.message });
    }
  }

  // Send email digest if new entries found
  if (!flags.noEmail && insertedCount > 0) {
    const newEntries = await db.getNewEntriesSince(startedAt).catch((err) => {
      logger.error('get_new_entries_failed', MODULE, { err: err.message });
      return [];
    });

    if (newEntries.length > 0) {
      await sendDigest(newEntries, dateStr).catch((err) => {
        logger.error('digest_send_error', MODULE, { err: err.message });
      });
    }
  } else if (insertedCount === 0 && entries.length > 0) {
    logger.info('no_new_entries', MODULE, { reason: 'all_already_seen' });
  } else if (!flags.noEmail) {
    logger.info('no_entries_skip_email', MODULE);
  }

  // Log run
  const finishedAt = new Date();
  await db.logRun({
    startedAt,
    finishedAt,
    publicationDate: dateStr,
    pdfUrl:          stats.pdfUrls ? stats.pdfUrls[0] : null,
    status:          entries.length === 0 ? 'empty' : insertedCount > 0 ? 'success' : 'no_new',
    totalFound:      stats.totalFound,
    flemishFound:    entries.length,
    newInserted:     insertedCount,
    typeBreakdown:   stats.typeBreakdown,
    errorSummary:    null,
  });

  logger.info('run_complete', MODULE, {
    durationMs:  finishedAt - startedAt,
    found:       entries.length,
    newInserted: insertedCount,
    emailSent:   !flags.noEmail && insertedCount > 0,
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
