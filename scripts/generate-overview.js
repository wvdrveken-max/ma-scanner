'use strict';

// ---------------------------------------------------------------------------
// Generates docs/index.html and docs/listings.csv from the ma_listings table.
// Run automatically by the GitHub Actions workflow after each scan, or manually:
//   node scripts/generate-overview.js
//
// Public URL (derived from GitHub user + repo name):
//   https://wvdrveken-max.github.io/ma-scanner/
// Update OVERVIEW_URL in mailer.js if the repo is ever renamed or transferred.
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const DOCS_DIR = path.join(__dirname, '..', 'docs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeCsv(val) {
  if (val == null) return '';
  const s = String(val).replace(/"/g, '""');
  return /[",\n\r]/.test(s) ? `"${s}"` : s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  let rows;
  try {
    const result = await pool.query(
      `SELECT source, url, title, description, first_seen_at
       FROM ma_listings
       ORDER BY first_seen_at DESC`
    );
    rows = result.rows;
  } finally {
    await pool.end();
  }

  fs.mkdirSync(DOCS_DIR, { recursive: true });

  generateCsv(rows);
  generateHtml(rows);

  console.log(`Overview generated: ${rows.length} listings → docs/index.html + docs/listings.csv`);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function generateCsv(rows) {
  const lines = [
    ['source', 'title', 'description', 'first_seen_at', 'url'].map(escapeCsv).join(','),
    ...rows.map(r => [
      escapeCsv(r.source),
      escapeCsv(r.title),
      escapeCsv(r.description),
      escapeCsv(r.first_seen_at ? r.first_seen_at.toISOString() : ''),
      escapeCsv(r.url),
    ].join(',')),
  ];
  fs.writeFileSync(path.join(DOCS_DIR, 'listings.csv'), lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
function generateHtml(rows) {
  const now     = new Date();
  const sources = [...new Set(rows.map(r => r.source))].sort();

  // Embed data as JSON for client-side filtering — all values HTML-escaped at render time
  const data = rows.map(r => ({
    source: r.source      || '',
    title:  r.title       || '',
    desc:   r.description || '',
    date:   r.first_seen_at ? r.first_seen_at.toISOString().slice(0, 10) : '',
    url:    r.url         || '',
  }));

  const sourceOptions = sources
    .map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
    .join('\n        ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MA Scanner – All Opportunities</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; background: #f5f5f5; margin: 0; padding: 0; color: #222; }
  .header { background: #1a2e4a; color: #fff; padding: 20px 32px; }
  .header h1 { margin: 0 0 4px; font-size: 20px; }
  .header .sub { font-size: 13px; color: #aec6e8; }
  .controls { background: #eef2f7; padding: 12px 32px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid #d8e4f0; }
  .controls input { padding: 7px 10px; font-size: 13px; border: 1px solid #ccc; border-radius: 4px; width: 280px; }
  .controls select { padding: 7px 10px; font-size: 13px; border: 1px solid #ccc; border-radius: 4px; }
  .controls .spacer { flex: 1; }
  .btn-toggle { font-size: 12px; cursor: pointer; color: #2563eb; background: none; border: none; padding: 0; text-decoration: underline; }
  .btn-csv { display: inline-block; background: #fff; border: 1px solid #2563eb; color: #2563eb; padding: 6px 14px; border-radius: 4px; font-size: 12px; text-decoration: none; }
  .btn-csv:hover { background: #2563eb; color: #fff; }
  .count { font-size: 12px; color: #666; padding: 8px 32px 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #1a2e4a; color: #fff; padding: 9px 12px; text-align: left; font-size: 12px; font-weight: 600; position: sticky; top: 0; z-index: 1; }
  td { padding: 8px 12px; border-bottom: 1px solid #efefef; vertical-align: top; }
  tr:hover td { background: #f9fbff; }
  .c-source { white-space: nowrap; color: #555; font-size: 12px; width: 130px; }
  .c-title { font-weight: 600; color: #1a2e4a; }
  .c-desc { color: #666; font-size: 12px; margin-top: 2px; line-height: 1.4; }
  .c-date { white-space: nowrap; color: #888; font-size: 12px; width: 90px; }
  .c-link { width: 60px; text-align: center; }
  .view-btn { display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 4px 10px; border-radius: 3px; font-size: 11px; white-space: nowrap; }
  .view-btn:hover { background: #1d4ed8; }
  .no-results { padding: 48px; text-align: center; color: #888; font-size: 14px; }
</style>
</head>
<body>

<div class="header">
  <h1>MA Scanner – All Opportunities</h1>
  <div class="sub">
    Last updated: ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC
    &nbsp;·&nbsp;
    ${rows.length} total listings across ${sources.length} sources
  </div>
</div>

<div class="controls">
  <input type="text" id="search" placeholder="Search title, description, source…" oninput="applyFilters()">
  <select id="srcFilter" onchange="applyFilters()">
    <option value="">All sources</option>
    ${sourceOptions}
  </select>
  <button class="btn-toggle" id="dateToggle" onclick="toggleDate()">Showing last 90 days &mdash; click to show all</button>
  <div class="spacer"></div>
  <a class="btn-csv" href="listings.csv" download>&#8595; Download CSV</a>
</div>

<div class="count" id="countLine"></div>

<table>
  <thead>
    <tr>
      <th>Source</th>
      <th>Opportunity</th>
      <th>Date found</th>
      <th></th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>
<div class="no-results" id="noResults" style="display:none">No matching listings.</div>

<script>
const DATA = ${JSON.stringify(data)};
let showAll = false;

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toggleDate() {
  showAll = !showAll;
  document.getElementById('dateToggle').textContent = showAll
    ? 'Showing all \u2014 click to show last 90 days'
    : 'Showing last 90 days \u2014 click to show all';
  applyFilters();
}

function applyFilters() {
  const q      = document.getElementById('search').value.trim().toLowerCase();
  const source = document.getElementById('srcFilter').value;
  const cutoff = showAll
    ? null
    : new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

  const filtered = DATA.filter(r => {
    if (source && r.source !== source) return false;
    if (cutoff && r.date < cutoff) return false;
    if (q) {
      const hay = (r.title + ' ' + r.desc + ' ' + r.source).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  document.getElementById('countLine').textContent =
    filtered.length + ' of ' + DATA.length + ' listings';
  document.getElementById('noResults').style.display = filtered.length ? 'none' : '';

  document.getElementById('tbody').innerHTML = filtered.map(r => \`
    <tr>
      <td class="c-source">\${esc(r.source)}</td>
      <td>
        <div class="c-title">\${esc(r.title)}</div>
        \${r.desc ? '<div class="c-desc">' + esc(r.desc) + '</div>' : ''}
      </td>
      <td class="c-date">\${r.date}</td>
      <td class="c-link"><a class="view-btn" href="\${esc(r.url)}" target="_blank" rel="noopener">View</a></td>
    </tr>\`).join('');
}

applyFilters();
</script>
</body>
</html>`;

  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), html, 'utf8');
}

main().catch(err => {
  console.error('generate-overview failed:', err.message);
  process.exit(1);
});
