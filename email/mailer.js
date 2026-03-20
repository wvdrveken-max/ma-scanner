'use strict';

const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

const MODULE = 'mailer';

const MAX_ITEMS_PER_SOURCE = 10;
const MAX_TOTAL_ITEMS      = 50;

// ---------------------------------------------------------------------------
// Transporter (lazy singleton)
// ---------------------------------------------------------------------------
let _transporter;
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

function getRecipients() {
  return (process.env.NOTIFY_TO || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatDate(d = new Date()) {
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ---------------------------------------------------------------------------
// Truncate description for email display
// ---------------------------------------------------------------------------
function truncate(text, max = 400) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
  body { font-family: Arial, Helvetica, sans-serif; background: #f5f5f5; margin: 0; padding: 0; }
  .wrapper { max-width: 680px; margin: 24px auto; background: #fff; border-radius: 8px; overflow: hidden; }
  .header { background: #1a2e4a; color: #fff; padding: 24px 32px; }
  .header h1 { margin: 0; font-size: 20px; }
  .summary { background: #eef2f7; padding: 16px 32px; font-size: 14px; color: #444; }
  .summary span { margin-right: 20px; }
  .source-section { padding: 24px 32px 0; }
  .source-section h2 { font-size: 16px; color: #1a2e4a; border-bottom: 2px solid #eef2f7; padding-bottom: 8px; margin-bottom: 16px; }
  .listing { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #f0f0f0; }
  .listing:last-child { border-bottom: none; }
  .listing-title { font-size: 15px; font-weight: bold; color: #1a2e4a; margin: 0 0 4px; }
  .listing-desc { font-size: 13px; color: #555; margin: 4px 0 10px; line-height: 1.5; }
  .btn { display: inline-block; background: #2563eb; color: #fff; text-decoration: none;
         padding: 7px 16px; border-radius: 4px; font-size: 13px; }
  .overflow { font-size: 13px; color: #888; font-style: italic; margin: 8px 0 24px; }
  .footer { background: #f5f5f5; padding: 16px 32px; font-size: 12px; color: #888; }
  .footer .errors { color: #c0392b; margin-top: 8px; }
`;

// ---------------------------------------------------------------------------
// Build HTML digest email
// ---------------------------------------------------------------------------
function buildDigestHtml(listings, runStats) {
  const {
    ranAt        = new Date(),
    totalSites   = 0,
    sitesSucceeded = 0,
    sitesFailed  = 0,
    failedSiteDetails = [],
  } = runStats;

  // Group by source
  const bySource = {};
  for (const l of listings) {
    (bySource[l.source] = bySource[l.source] || []).push(l);
  }

  let totalRendered = 0;
  let sourceSections = '';
  let plainSections  = '';

  for (const [source, items] of Object.entries(bySource)) {
    if (totalRendered >= MAX_TOTAL_ITEMS) break;

    const toShow  = items.slice(0, Math.min(MAX_ITEMS_PER_SOURCE, MAX_TOTAL_ITEMS - totalRendered));
    const overflow = items.length - toShow.length;

    let listingsHtml  = '';
    let listingsPlain = '';

    for (const l of toShow) {
      const desc = truncate(l.description);
      listingsHtml += `
        <div class="listing">
          <p class="listing-title">${escapeHtml(l.title)}</p>
          ${desc ? `<p class="listing-desc">${escapeHtml(desc)}</p>` : ''}
          <a class="btn" href="${escapeHtml(l.url)}">View Opportunity</a>
        </div>`;
      listingsPlain += `  - ${l.title}\n    ${l.url}\n${desc ? `    ${desc}\n` : ''}`;
    }

    const overflowHtml  = overflow > 0 ? `<p class="overflow">…and ${overflow} more from ${escapeHtml(source)}</p>` : '';
    const overflowPlain = overflow > 0 ? `  …and ${overflow} more from ${source}\n` : '';

    sourceSections += `
      <div class="source-section">
        <h2>${escapeHtml(source)}</h2>
        ${listingsHtml}
        ${overflowHtml}
      </div>`;

    plainSections += `\n=== ${source} ===\n${listingsPlain}${overflowPlain}`;
    totalRendered += toShow.length;
  }

  // Global overflow
  const globalOverflow = listings.length - totalRendered;
  const globalOverflowHtml = globalOverflow > 0
    ? `<div style="padding: 0 32px 24px; font-size: 13px; color: #888;">
         <em>${globalOverflow} additional opportunities not shown — all stored in the database.</em>
       </div>`
    : '';

  // Errors in footer
  const errorsHtml = failedSiteDetails.length > 0
    ? `<div class="errors">Sites with errors: ${failedSiteDetails.map((e) => escapeHtml(e)).join(', ')}</div>`
    : '';

  const errorsPlain = failedSiteDetails.length > 0
    ? `\nSites with errors: ${failedSiteDetails.join(', ')}`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>${CSS}</style></head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>🔍 New Acquisition Opportunities – ${formatDate(ranAt)}</h1>
  </div>
  <div class="summary">
    <span><strong>${listings.length}</strong> new opportunities</span>
    <span><strong>${totalSites}</strong> sites scanned</span>
    <span><strong>${sitesSucceeded}</strong> succeeded</span>
    ${sitesFailed > 0 ? `<span style="color:#c0392b"><strong>${sitesFailed}</strong> failed</span>` : ''}
  </div>
  ${sourceSections}
  ${globalOverflowHtml}
  <div class="footer">
    Run completed: ${ranAt.toISOString()} UTC
    ${errorsHtml}
  </div>
</div>
</body>
</html>`;

  const text = `New Acquisition Opportunities – ${formatDate(ranAt)}

Sites scanned: ${totalSites} | Succeeded: ${sitesSucceeded} | Failed: ${sitesFailed}
New opportunities: ${listings.length}
${plainSections}
${globalOverflow > 0 ? `\n${globalOverflow} additional opportunities not shown.\n` : ''}
Run: ${ranAt.toISOString()} UTC${errorsPlain}
`;

  return { html, text };
}

// ---------------------------------------------------------------------------
// Build HTML alert email
// ---------------------------------------------------------------------------
function buildAlertHtml(siteFailures, anomalies, ranAt = new Date()) {
  let bodyHtml  = '';
  let bodyPlain = '';

  if (siteFailures.length > 0) {
    bodyHtml  += '<h2 style="color:#c0392b">Site Failures</h2><ul>';
    bodyPlain += 'SITE FAILURES:\n';
    for (const f of siteFailures) {
      bodyHtml  += `<li><strong>${escapeHtml(f.site)}</strong>: ${escapeHtml(f.reason)}</li>`;
      bodyPlain += `  - ${f.site}: ${f.reason}\n`;
    }
    bodyHtml  += '</ul>';
    bodyPlain += '\n';
  }

  if (anomalies.length > 0) {
    bodyHtml  += '<h2 style="color:#e67e22">Anomalies Detected</h2><ul>';
    bodyPlain += 'ANOMALIES:\n';
    for (const a of anomalies) {
      bodyHtml  += `<li><strong>${escapeHtml(a.site)}</strong>: ${escapeHtml(a.reason)}</li>`;
      bodyPlain += `  - ${a.site}: ${a.reason}\n`;
    }
    bodyHtml  += '</ul>';
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>${CSS}</style></head>
<body>
<div class="wrapper">
  <div class="header" style="background:#8b1a1a;">
    <h1>⚠️ MA Scanner – Site Issues Detected – ${formatDate(ranAt)}</h1>
  </div>
  <div style="padding: 24px 32px;">
    ${bodyHtml}
    <p style="font-size:13px;color:#888;margin-top:32px;">Run: ${ranAt.toISOString()} UTC</p>
  </div>
</div>
</body>
</html>`;

  const text = `MA Scanner – Site Issues Detected – ${formatDate(ranAt)}\n\n${bodyPlain}\nRun: ${ranAt.toISOString()} UTC\n`;

  return { html, text };
}

// ---------------------------------------------------------------------------
// sendDigest — new listings email
// ---------------------------------------------------------------------------
async function sendDigest(newListings, runStats) {
  const recipients = getRecipients();
  if (!recipients.length) {
    logger.warn('digest_no_recipients', MODULE);
    return;
  }

  const { html, text } = buildDigestHtml(newListings, runStats);
  const subject = `🔍 New Acquisition Opportunities – ${formatDate(runStats.ranAt)}`;

  try {
    await getTransporter().sendMail({
      from:    process.env.SMTP_FROM,
      to:      recipients.join(', '),
      subject,
      html,
      text,
    });
    logger.info('digest_sent', MODULE, { recipients: recipients.length, listings: newListings.length });
  } catch (err) {
    logger.error('digest_send_failed', MODULE, { err: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// sendAlert — operational failures / anomalies email
// ---------------------------------------------------------------------------
async function sendAlert(siteFailures, anomalies, ranAt = new Date()) {
  const recipients = getRecipients();
  if (!recipients.length) {
    logger.warn('alert_no_recipients', MODULE);
    return;
  }

  const { html, text } = buildAlertHtml(siteFailures, anomalies, ranAt);
  const subject = `⚠️ MA Scanner – Site Issues Detected – ${formatDate(ranAt)}`;

  try {
    await getTransporter().sendMail({
      from:    process.env.SMTP_FROM,
      to:      recipients.join(', '),
      subject,
      html,
      text,
    });
    logger.info('alert_sent', MODULE, {
      recipients: recipients.length,
      failures:   siteFailures.length,
      anomalies:  anomalies.length,
    });
  } catch (err) {
    logger.error('alert_send_failed', MODULE, { err: err.message });
    throw err;
  }
}

module.exports = { sendDigest, sendAlert };
