'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const logger = require('../utils/logger');

const MODULE = 'staatsblad-engine';

// ---------------------------------------------------------------------------
// Entry type classification
// ---------------------------------------------------------------------------
const ENTRY_TYPES = [
  {
    type: 'overdracht_opening',
    test: (line) =>
      /overdracht\s+onder\s+gerechtelijk\s+gezag/i.test(line) &&
      !/^Einde/i.test(line.trim()) &&
      /gerechtsmandataris/i.test(line),
    priority: 1,
  },
  {
    type: 'overdracht_einde_faillissement',
    test: (line) =>
      /^Einde\s+overdracht\s+onder\s+gerechtelijk\s+gezag\s+en\s+opening\s+van\s+het\s+faillissement\s+van\s*:/i.test(line.trim()),
    priority: 2,
  },
  {
    type: 'faillissement_opening',
    test: (line) =>
      /^Opening\s+van\s+het\s+faillissement\s+van\s*:/i.test(line.trim()),
    priority: 3,
  },
  {
    type: 'reorganisatie_opening',
    test: (line) =>
      /^Opening\s+van\s+de\s+gerechtelijke\s+reorganisatie\s+van\s*:/i.test(line.trim()),
    priority: 4,
  },
  {
    type: 'reorganisatie_verlenging',
    test: (line) =>
      /verlenging/i.test(line) && /gerechtelijke\s+reorganisatie/i.test(line),
    priority: 5,
  },
  {
    type: 'reorganisatie_homologatie',
    test: (line) =>
      /homologatie/i.test(line) && /plan/i.test(line),
    priority: 6,
  },
  {
    type: 'faillissement_afsluiting',
    test: (line) =>
      /^(Afsluiting|Sluiting)\s+faillissement/i.test(line.trim()),
    priority: 7,
  },
];

// ---------------------------------------------------------------------------
// Flemish court patterns
// ---------------------------------------------------------------------------
const FLEMISH_COURTS = [
  /Ondernemingsrechtbank\s+Gent,?\s+afdeling\s+(Gent|Dendermonde|Oudenaarde|Brugge|Ieper|Kortrijk|Veurne)/i,
  /Ondernemingsrechtbank\s+Antwerpen,?\s+afdeling\s+(Antwerpen|Mechelen|Turnhout|Hasselt|Tongeren)/i,
  /Ondernemingsrechtbank\s+Leuven/i,
  /Nederlandstalige\s+ondernemingsrechtbank\s+Brussel/i,
];

function matchFlemishCourt(line) {
  for (const re of FLEMISH_COURTS) {
    const m = line.match(re);
    if (m) return m[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field extraction patterns
// ---------------------------------------------------------------------------
const FIELD_PATTERNS = [
  { key: 'enterprise_number', re: /^Ondernemingsnummer\s*:\s*(.+)/i },
  { key: 'business_activity', re: /^Handelsactiviteit\s*:\s*(.+)/i },
  { key: 'reference',         re: /^Referentie\s*:\s*(.+)/i },
  { key: 'judge',             re: /^(?:Rechter[\s-]?[Cc]ommissaris|Gedelegeerd\s+rechter)\s*:\s*(.+)/i },
  { key: 'curator_raw',       re: /^(?:Curator|Curators)\s*:\s*(.+)/i },
  { key: 'event_date',        re: /^(?:Datum\s+faillissement|Datum\s+uitspraak)\s*:\s*(.+)/i },
  { key: 'cessation_date',    re: /^Voorlopige\s+datum\s+van\s+staking\s+van\s+betaling\s*:\s*(.+)/i },
  { key: 'moratorium_end_date', re: /^Einddatum\s+van\s+de\s+opschorting\s*:\s*(.+)/i },
  { key: 'procedure_subject', re: /^Onderwerp\s+van\s+de\s+procedure\s*:\s*(.+)/i },
];

// Patterns that signal the end of an entry
const STOP_PATTERNS = [
  /^\d{4}\/\d{6}/,         // NUMAC reference
  /^Voor\s+eensluidend\s+uittreksel/i,
];

// ---------------------------------------------------------------------------
// Date parsing — DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
// ---------------------------------------------------------------------------
function parseDateBE(str) {
  if (!str) return null;
  const m = str.trim().match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Curator parsing — extract name, email, address from curator line
// ---------------------------------------------------------------------------
function parseCurator(raw) {
  if (!raw) return {};
  const result = {};

  // Extract email
  const emailMatch = raw.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (emailMatch) result.curator_email = emailMatch[0].toLowerCase();

  // The name is typically the first part before comma or dash
  const parts = raw.split(/\s*[-,]\s*/);
  if (parts[0]) result.curator_name = parts[0].trim();

  // Address is everything between name and email, roughly
  const withoutEmail = raw.replace(/[\w.+-]+@[\w.-]+\.\w+/, '').trim();
  const withoutName = withoutEmail.replace(result.curator_name || '', '').replace(/^[\s,\-]+/, '').replace(/[\s,\-]+$/, '');
  if (withoutName.length > 5) result.curator_address = withoutName;

  return result;
}

// ---------------------------------------------------------------------------
// Company name extraction from marker line
// ---------------------------------------------------------------------------
function extractCompanyFromMarker(line) {
  // Everything after "van:" (the last occurrence)
  const idx = line.lastIndexOf('van:');
  if (idx < 0) return { company_name: line.trim(), address: null };

  const after = line.slice(idx + 4).trim();
  if (!after) return { company_name: line.trim(), address: null };

  // Company name is typically in ALL CAPS or the first recognizable segment
  // Address often starts with a number or comma-separated location
  // Split on comma — first part is usually the company name
  const parts = after.split(/,\s*/);
  const company_name = parts[0].trim();
  const address = parts.length > 1 ? parts.slice(1).join(', ').trim() : null;

  return { company_name, address };
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------
function generateId(entry) {
  const key = entry.enterprise_number
    ? `${entry.enterprise_number}|${entry.type}|${entry.publication_date}`
    : `${entry.company_name.toLowerCase().replace(/\s+/g, '')}|${entry.type}|${entry.publication_date}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Download PDF
// ---------------------------------------------------------------------------
async function downloadPdf(dateStr) {
  const [yyyy, mm, dd] = dateStr.split('-');
  const urls = [
    `https://www.ejustice.just.fgov.be/mopdf/${yyyy}/${mm}/${dd}_1.pdf`,
    `https://www.ejustice.just.fgov.be/mopdf/${yyyy}/${mm}/${dd}_2.pdf`,
  ];

  const buffers = [];

  for (const url of urls) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logger.debug(`download_attempt`, MODULE, { url, attempt });
        const resp = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          headers: { 'User-Agent': 'VindemiaPartners-StaatsbladScanner/1.0' },
        });
        buffers.push({ url, buffer: Buffer.from(resp.data) });
        logger.info('pdf_downloaded', MODULE, { url, bytes: resp.data.byteLength });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err.response && err.response.status === 404) {
          logger.info('pdf_not_found', MODULE, { url, reason: 'weekend_or_holiday' });
          lastErr = null;
          break;
        }
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
    if (lastErr) {
      logger.error('pdf_download_failed', MODULE, { url, err: lastErr.message });
      throw lastErr;
    }
  }

  return buffers;
}

// ---------------------------------------------------------------------------
// Extract text from PDF buffer
// ---------------------------------------------------------------------------
async function extractText(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return data.text;
}

// ---------------------------------------------------------------------------
// Pre-process text: rejoin lines broken by PDF two-column layout
// Joins lines ending with a hyphen to the next non-empty line, and also
// joins short continuation lines that clearly belong to a sentence.
// ---------------------------------------------------------------------------
function preprocessText(text) {
  const rawLines = text.split('\n');
  const joined = [];
  let buffer = '';

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      if (buffer) { joined.push(buffer); buffer = ''; }
      joined.push('');
      continue;
    }

    if (buffer) {
      // Continue the buffered line
      buffer = buffer + trimmed;
    } else {
      buffer = trimmed;
    }

    // If line ends with a hyphen followed by whitespace-only or end, it's a word break
    if (/[a-zA-ZÀ-ÿ]-$/.test(buffer)) {
      // Remove trailing hyphen — next line continues the word
      buffer = buffer.slice(0, -1);
      continue;
    }

    // Push completed line
    joined.push(buffer);
    buffer = '';
  }
  if (buffer) joined.push(buffer);

  return joined;
}

// ---------------------------------------------------------------------------
// Parse entries from extracted text
// ---------------------------------------------------------------------------
function parseEntries(text, publicationDate) {
  const lines = preprocessText(text);
  const rawEntries = [];

  // Track last seen Flemish court header
  let lastCourt = null;
  let lastCourtLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check for court header
    const court = matchFlemishCourt(line);
    if (court) {
      lastCourt = court;
      lastCourtLineIdx = i;
      continue;
    }

    // Check for entry markers
    let entryType = null;
    for (const et of ENTRY_TYPES) {
      if (et.test(line)) {
        entryType = et;
        break;
      }
    }
    if (!entryType) continue;

    // Only process entries that have a preceding Flemish court header
    // Court header must be within reasonable range (200 lines)
    if (!lastCourt || (i - lastCourtLineIdx) > 200) continue;

    // Extract company info from marker line
    let { company_name, address } = extractCompanyFromMarker(line);

    // If company name is the marker text itself (nothing after "van:"),
    // the company name is on the next non-empty line
    let fieldScanStart = i + 1;
    if (!company_name || company_name === line.trim() || /van\s*:\s*$/i.test(line)) {
      // Look ahead for company name
      for (let k = i + 1; k < lines.length && k < i + 5; k++) {
        const nextLine = lines[k].trim();
        if (!nextLine) continue;
        // This should be the company name line
        const parts = nextLine.split(/,\s*/);
        company_name = parts[0].replace(/\.\s*$/, '').trim();
        address = parts.length > 1 ? parts.slice(1).join(', ').replace(/\.\s*$/, '').trim() : null;
        fieldScanStart = k + 1;
        break;
      }
    }
    if (!company_name) continue;

    // Scan forward for fields
    const fields = { address };
    const rawLines = [line];
    let lastFieldKey = null;

    for (let j = fieldScanStart; j < lines.length && j < i + 50; j++) {
      const fline = lines[j].trim();
      if (!fline) continue;

      // Stop conditions
      let shouldStop = false;
      for (const sp of STOP_PATTERNS) {
        if (sp.test(fline)) { shouldStop = true; break; }
      }
      if (shouldStop) break;

      // Check if this is a new entry marker (stop scanning)
      let isNewEntry = false;
      for (const et of ENTRY_TYPES) {
        if (et.test(fline)) { isNewEntry = true; break; }
      }
      if (isNewEntry) break;

      // Check if this is a new court header (stop scanning)
      if (matchFlemishCourt(fline)) break;

      rawLines.push(fline);

      // Try to match field patterns
      let matched = false;
      for (const fp of FIELD_PATTERNS) {
        const fm = fline.match(fp.re);
        if (fm) {
          fields[fp.key] = fm[1].trim();
          lastFieldKey = fp.key;
          matched = true;
          break;
        }
      }

      // If no match and we have a last field, this might be a continuation line
      if (!matched && lastFieldKey) {
        // Only continue multi-line for certain fields (curator, address)
        if (['curator_raw', 'business_activity'].includes(lastFieldKey)) {
          fields[lastFieldKey] = (fields[lastFieldKey] || '') + ' ' + fline;
        } else {
          lastFieldKey = null; // stop continuation
        }
      }
    }

    // Parse curator details
    const curatorInfo = parseCurator(fields.curator_raw);

    // Parse dates
    const eventDate = parseDateBE(fields.event_date);
    const cessationDate = parseDateBE(fields.cessation_date);
    const moratoriumEndDate = parseDateBE(fields.moratorium_end_date);

    // Clean enterprise number
    let enterpriseNumber = fields.enterprise_number || null;
    if (enterpriseNumber) {
      enterpriseNumber = enterpriseNumber.replace(/[^\d.]/g, '').trim();
    }

    const entry = {
      type:                entryType.type,
      company_name,
      enterprise_number:   enterpriseNumber,
      address:             fields.address || address,
      business_activity:   fields.business_activity || null,
      court:               lastCourt,
      judge:               fields.judge || null,
      curator_name:        curatorInfo.curator_name || null,
      curator_email:       curatorInfo.curator_email || null,
      curator_address:     curatorInfo.curator_address || null,
      event_date:          eventDate,
      cessation_date:      cessationDate,
      moratorium_end_date: moratoriumEndDate,
      reference:           fields.reference || null,
      publication_date:    publicationDate,
      raw_text:            rawLines.join('\n'),
    };

    entry.id = generateId(entry);
    rawEntries.push(entry);
  }

  return rawEntries;
}

// ---------------------------------------------------------------------------
// Main pipeline: download + extract + parse
// ---------------------------------------------------------------------------
async function run(dateStr) {
  logger.info('engine_start', MODULE, { date: dateStr });

  // Download PDF(s)
  const pdfs = await downloadPdf(dateStr);
  if (pdfs.length === 0) {
    logger.info('no_pdfs_available', MODULE, { date: dateStr });
    return { entries: [], stats: { totalFound: 0, pdfUrls: [] } };
  }

  // Extract text and parse entries from all PDFs
  let allEntries = [];
  const pdfUrls = [];

  for (const { url, buffer } of pdfs) {
    pdfUrls.push(url);
    logger.info('extracting_text', MODULE, { url });
    const text = await extractText(buffer);
    logger.info('text_extracted', MODULE, { url, chars: text.length });

    const entries = parseEntries(text, dateStr);
    logger.info('entries_parsed', MODULE, { url, count: entries.length });
    allEntries = allEntries.concat(entries);
  }

  // Deduplicate by id
  const seen = new Set();
  const deduped = allEntries.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  // Build type breakdown
  const typeBreakdown = {};
  for (const e of deduped) {
    typeBreakdown[e.type] = (typeBreakdown[e.type] || 0) + 1;
  }

  const stats = {
    totalFound: deduped.length,
    pdfUrls,
    typeBreakdown,
  };

  logger.info('engine_complete', MODULE, {
    date: dateStr,
    totalEntries: deduped.length,
    typeBreakdown,
  });

  return { entries: deduped, stats };
}

module.exports = { run, downloadPdf, extractText, parseEntries };
