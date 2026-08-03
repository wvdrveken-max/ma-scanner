'use strict';

const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

const MODULE = 'staatsblad-mailer';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateBE(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function kboUrl(enterpriseNumber) {
  if (!enterpriseNumber) return null;
  const digits = enterpriseNumber.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `https://kbopub.economie.fgov.be/kbopub/toonondernemingps.html?ondernemingsnummer=${digits}`;
}

// ---------------------------------------------------------------------------
// Type labels + display order (most actionable first)
// ---------------------------------------------------------------------------
const TYPE_CONFIG = {
  overdracht_opening:              { label: 'Overdracht onder gerechtelijk gezag', color: '#c0392b', order: 1 },
  faillissement_opening:           { label: 'Opening faillissement',               color: '#e74c3c', order: 2 },
  overdracht_einde_faillissement:  { label: 'Einde overdracht → faillissement',    color: '#e67e22', order: 3 },
  reorganisatie_opening:           { label: 'Opening gerechtelijke reorganisatie',  color: '#f39c12', order: 4 },
  reorganisatie_verlenging:        { label: 'Verlenging reorganisatie',             color: '#95a5a6', order: 5 },
  reorganisatie_homologatie:       { label: 'Homologatie reorganisatieplan',        color: '#95a5a6', order: 6 },
  faillissement_afsluiting:        { label: 'Afsluiting faillissement',            color: '#bdc3c7', order: 7 },
};

function getTypeConfig(type) {
  return TYPE_CONFIG[type] || { label: type, color: '#95a5a6', order: 99 };
}

// ---------------------------------------------------------------------------
// CSS — matches existing MA scanner style
// ---------------------------------------------------------------------------
const CSS = `
  body { font-family: Arial, Helvetica, sans-serif; background: #f5f5f5; margin: 0; padding: 0; }
  .wrapper { max-width: 780px; margin: 24px auto; background: #fff; border-radius: 8px; overflow: hidden; }
  .header { background: #1a2e4a; color: #fff; padding: 20px 28px; }
  .header h1 { margin: 0; font-size: 18px; }
  .summary { background: #eef2f7; padding: 12px 28px; font-size: 13px; color: #444; }
  .summary span { margin-right: 20px; }
  .section-hdr td { background: #eef2f7; font-weight: 700; font-size: 12px;
                     color: #1a2e4a; padding: 8px 10px; border-bottom: 1px solid #d8e4f0; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th { background: #1a2e4a; color: #fff; text-align: left; padding: 8px 10px; font-size: 12px; font-weight: 600; }
  .tbl td { padding: 7px 10px; vertical-align: top; border-bottom: 1px solid #f0f0f0; }
  .tbl tr:last-child td { border-bottom: none; }
  .company { font-weight: 600; color: #1a2e4a; }
  .detail { color: #666; font-size: 12px; margin-top: 2px; line-height: 1.5; }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 10px;
            font-weight: 600; color: #fff; margin-right: 4px; }
  .btn { display: inline-block; background: #2563eb; color: #fff !important; text-decoration: none;
         padding: 4px 10px; border-radius: 3px; font-size: 11px; white-space: nowrap; }
  .footer { background: #f5f5f5; padding: 14px 28px; font-size: 11px; color: #888; }
  .footer a { color: #2563eb; }
`;

// ---------------------------------------------------------------------------
// Build HTML digest
// ---------------------------------------------------------------------------
function buildDigestHtml(entries, publicationDate) {
  // Group by type, sorted by priority
  const grouped = {};
  for (const e of entries) {
    (grouped[e.type] = grouped[e.type] || []).push(e);
  }

  const sortedTypes = Object.keys(grouped).sort(
    (a, b) => getTypeConfig(a).order - getTypeConfig(b).order,
  );

  let tableRows = '';
  let plainLines = '';

  for (const type of sortedTypes) {
    const items = grouped[type];
    const cfg = getTypeConfig(type);

    tableRows += `<tr class="section-hdr"><td colspan="2">
      <span class="badge" style="background:${cfg.color}">${items.length}</span>
      ${escapeHtml(cfg.label)}
    </td></tr>`;
    plainLines += `\n=== ${cfg.label} (${items.length}) ===\n`;

    for (const e of items) {
      const kbo = kboUrl(e.enterprise_number);
      const kboLink = kbo
        ? `<a class="btn" href="${escapeHtml(kbo)}" style="margin-right:4px;">KBO</a>`
        : '';
      const curatorLine = e.curator_name
        ? `Curator: ${escapeHtml(e.curator_name)}${e.curator_email ? ` (<a href="mailto:${escapeHtml(e.curator_email)}">${escapeHtml(e.curator_email)}</a>)` : ''}`
        : '';

      tableRows += `
        <tr>
          <td>
            <div class="company">${escapeHtml(e.company_name)}</div>
            <div class="detail">
              ${e.enterprise_number ? `ON: ${escapeHtml(e.enterprise_number)}<br>` : ''}
              ${e.court ? `Rechtbank: ${escapeHtml(e.court)}<br>` : ''}
              ${e.business_activity ? `Activiteit: ${escapeHtml(e.business_activity)}<br>` : ''}
              ${curatorLine ? `${curatorLine}<br>` : ''}
              ${e.event_date ? `Datum: ${formatDateBE(e.event_date)}<br>` : ''}
              ${e.reference ? `Ref: ${escapeHtml(e.reference)}` : ''}
            </div>
          </td>
          <td style="width:60px;text-align:center;vertical-align:middle;">
            ${kboLink}
          </td>
        </tr>`;

      plainLines += `  - ${e.company_name}`;
      if (e.enterprise_number) plainLines += ` (${e.enterprise_number})`;
      plainLines += `\n`;
      if (e.court) plainLines += `    Rechtbank: ${e.court}\n`;
      if (e.business_activity) plainLines += `    Activiteit: ${e.business_activity}\n`;
      if (e.curator_name) plainLines += `    Curator: ${e.curator_name}${e.curator_email ? ` (${e.curator_email})` : ''}\n`;
      if (e.event_date) plainLines += `    Datum: ${formatDateBE(e.event_date)}\n`;
      if (e.reference) plainLines += `    Ref: ${e.reference}\n`;
      if (kbo) plainLines += `    KBO: ${kbo}\n`;
    }
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>${CSS}</style></head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>Staatsblad – Nieuwe faillissementen & reorganisaties – ${formatDateBE(publicationDate)}</h1>
  </div>
  <div class="summary">
    <span><strong>${entries.length}</strong> nieuwe vermeldingen</span>
    <span>Publicatiedatum: <strong>${formatDateBE(publicationDate)}</strong></span>
  </div>
  <table class="tbl">
    <thead><tr><th>Onderneming</th><th></th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div class="footer">
    Staatsblad Scanner &middot; Run: ${new Date().toISOString()} UTC
  </div>
</div>
</body>
</html>`;

  const text = `Staatsblad – Nieuwe faillissementen & reorganisaties – ${formatDateBE(publicationDate)}

Nieuwe vermeldingen: ${entries.length}
${plainLines}
Run: ${new Date().toISOString()} UTC
`;

  return { html, text };
}

// ---------------------------------------------------------------------------
// Send digest
// ---------------------------------------------------------------------------
async function sendDigest(entries, publicationDate) {
  const recipients = getRecipients();
  if (!recipients.length) {
    logger.warn('digest_no_recipients', MODULE);
    return;
  }

  const { html, text } = buildDigestHtml(entries, publicationDate);
  const subject = `Staatsblad – Nieuwe faillissementen & reorganisaties – ${formatDateBE(publicationDate)}`;

  try {
    await getTransporter().sendMail({
      from:    process.env.SMTP_FROM,
      to:      recipients.join(', '),
      subject,
      html,
      text,
    });
    logger.info('digest_sent', MODULE, { recipients: recipients.length, entries: entries.length });
  } catch (err) {
    logger.error('digest_send_failed', MODULE, { err: err.message });
    throw err;
  }
}

module.exports = { sendDigest };
