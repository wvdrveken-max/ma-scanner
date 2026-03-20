'use strict';

const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

const MODULE = 'mailer';

// No cap on listings — all new opportunities are shown in a condensed table.

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
function truncate(text, max = 160) {
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
  .wrapper { max-width: 780px; margin: 24px auto; background: #fff; border-radius: 8px; overflow: hidden; }
  .header { background: #1a2e4a; color: #fff; padding: 20px 28px; }
  .header h1 { margin: 0; font-size: 18px; }
  .summary { background: #eef2f7; padding: 12px 28px; font-size: 13px; color: #444; }
  .summary span { margin-right: 20px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th { background: #1a2e4a; color: #fff; text-align: left; padding: 8px 10px; font-size: 12px; font-weight: 600; }
  .tbl td { padding: 7px 10px; vertical-align: top; border-bottom: 1px solid #f0f0f0; }
  .tbl tr:last-child td { border-bottom: none; }
  .tbl tr.src-header td { background: #eef2f7; font-weight: 700; font-size: 12px;
                           color: #1a2e4a; padding: 5px 10px; border-bottom: 1px solid #d8e4f0; }
  .t-title { font-weight: 600; color: #1a2e4a; }
  .t-desc { color: #666; font-size: 12px; margin-top: 2px; line-height: 1.4; }
  .btn { display: inline-block; background: #2563eb; color: #fff !important; text-decoration: none;
         padding: 4px 10px; border-radius: 3px; font-size: 11px; white-space: nowrap; }
  .footer { background: #f5f5f5; padding: 14px 28px; font-size: 11px; color: #888; }
  .footer a { color: #2563eb; }
  .footer .errors { color: #c0392b; margin-top: 6px; }
`;

// ---------------------------------------------------------------------------
// Build HTML digest email — compact table, no cap on listings
// ---------------------------------------------------------------------------
function buildDigestHtml(listings, runStats) {
  const {
    ranAt             = new Date(),
    totalSites        = 0,
    sitesSucceeded    = 0,
    sitesFailed       = 0,
    failedSiteDetails = [],
  } = runStats;

  // Group by source (preserve insertion order)
  const bySource = {};
  for (const l of listings) {
    (bySource[l.source] = bySource[l.source] || []).push(l);
  }

  let tableRows  = '';
  let plainLines = '';

  for (const [source, items] of Object.entries(bySource)) {
    // Source header row
    tableRows += `<tr class="src-header"><td colspan="2">${escapeHtml(source)} (${items.length})</td><td></td></tr>`;
    plainLines += `\n=== ${source} (${items.length}) ===\n`;

    for (const l of items) {
      const desc = truncate(l.description);
      tableRows += `
        <tr>
          <td>
            <div class="t-title">${escapeHtml(l.title)}</div>
            ${desc ? `<div class="t-desc">${escapeHtml(desc)}</div>` : ''}
          </td>
          <td style="width:60px;text-align:center;">
            <a class="btn" href="${escapeHtml(l.url)}">View</a>
          </td>
        </tr>`;
      plainLines += `  - ${l.title}\n    ${l.url}\n${desc ? `    ${desc}\n` : ''}`;
    }
  }

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
  <table class="tbl">
    <thead><tr><th>Opportunity</th><th></th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div class="footer">
    <a href="https://wvdrveken-max.github.io/ma-scanner/">View all opportunities</a>
    &nbsp;·&nbsp; Run completed: ${ranAt.toISOString()} UTC
    ${errorsHtml}
  </div>
</div>
</body>
</html>`;

  const text = `New Acquisition Opportunities – ${formatDate(ranAt)}

Sites scanned: ${totalSites} | Succeeded: ${sitesSucceeded} | Failed: ${sitesFailed}
New opportunities: ${listings.length}
${plainLines}
View all opportunities: https://wvdrveken-max.github.io/ma-scanner/
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
