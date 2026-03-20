# MA Scanner

Automated scraper that monitors 24 Belgian M&A / business acquisition websites daily, detects new listings, and emails a digest to configured recipients.

Built to run as a scheduled GitHub Actions workflow — no paid hosting required.

---

## What it does

1. Connects to a Neon PostgreSQL database and runs schema migrations.
2. Scrapes all 24 configured sites with full pagination.
3. Normalizes and deduplicates listings using a SHA256 ID based on canonical URL.
4. Upserts new listings into the database.
5. **First run only:** stores all listings as a baseline — no email sent.
6. **Subsequent runs:** sends a digest email if new listings are found; sends a separate alert email if any sites failed or show anomalous results.
7. Logs a full run record (per-site stats, counts, duration) to the database.

---

## One-time setup

### 1. Create a Neon database

- Go to [neon.tech](https://neon.tech) and create a free project.
- Copy the connection string from the dashboard (it looks like `postgresql://user:pass@host/db?sslmode=require`).
- The schema is created automatically on first run — no manual SQL needed.

### 2. Set GitHub Secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|--------|-------|
| `DATABASE_URL` | Neon connection string |
| `SMTP_HOST` | Your SMTP server hostname |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From address (e.g. `scanner@yourdomain.com`) |
| `NOTIFY_TO` | Comma-separated recipient list |

`SMTP_PORT` is hardcoded to `587` in the workflow. Change it there if needed.

### 3. Push to GitHub

Push this repo to GitHub. The workflow will run automatically at 5 AM UTC each day, or you can trigger it manually (see below).

---

## Local testing

```bash
cd ma-scanner
cp .env.example .env
# Fill in .env with real values
npm install
node index.js
```

### CLI flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Scrape everything, skip DB writes and email. Run log is written with `status=dry_run`. |
| `--no-email` | Scrape and write DB, skip sending email. |
| `--site=domain.com` | Run only the site matching that domain string. |
| `--debug` | Verbose per-listing log output. |
| `--force-puppeteer` | Use Puppeteer for all sites regardless of `needsJS` config. |

**Recommended workflow for testing a single site:**

```bash
node index.js --site=overnamemarkt.be --dry-run --debug
```

Check the log output for `rawItemsFound` vs `normalizedValidListings` to confirm selectors are working.

---

## Manual trigger

In the GitHub UI: **Actions → MA Scanner → Run workflow**.

This is useful for:
- Testing after initial setup
- Re-running after a known outage
- Backfilling after a multi-day gap (DB deduplication means no duplicate emails regardless of how many times you run)

---

## Schedule and timezone

The cron runs at `0 5 * * *` UTC:

- **Winter (CET):** 6:00 AM
- **Summer (CEST):** 7:00 AM

No manual adjustment needed — UTC cron is stable across DST changes.

---

## Troubleshooting

### Site returns 0 results (selector issue)

1. Open the site in a browser, inspect the listing container element.
2. Update `selectors.item`, `selectors.title`, etc. in `scraper/sites.js`.
3. Test with:
   ```bash
   node index.js --site=domain.com --dry-run --debug
   ```
4. Compare `rawItemsFound` (before normalization) and `normalizedValidListings` (after) in the log.
5. If `rawItemsFound` is still 0, the item selector is wrong. If `normalizedValidListings` is 0 but `rawItemsFound > 0`, the title or link selector isn't matching.

### Site returns 403 Forbidden

The site is blocking scrapers. Options:
- Add realistic request headers to the site config (not yet implemented per-site; can be added as a `headers` field in `sites.js`).
- Set `needsJS: true` to use Puppeteer, which has a more realistic browser fingerprint.
- Set `enabled: false` to skip the site.

### Site returns 429 Too Many Requests

Increase `rateLimitMsMin` and `rateLimitMsMax` for that site in `scraper/sites.js`.

### Puppeteer timeout

- The site may be very slow or require scroll/interaction to load listings.
- Try increasing the navigation timeout in `scraper/engine.js` (`fetchWithPuppeteer`).
- If the site consistently fails with Puppeteer, set `enabled: false` temporarily.

### SMTP failure

- Check that all `SMTP_*` secrets are set correctly.
- For Gmail: use an App Password, not your regular password.
- For other providers: ensure port 587 and STARTTLS are supported. Change `SMTP_PORT` in the workflow if needed.

### Database connection error

- Confirm `DATABASE_URL` is set and includes `?sslmode=require` (required for Neon).
- Check the Neon dashboard to confirm the project is active and not suspended.

---

## Selector maintenance

When a site redesigns, its selectors will break silently (the scraper won't error — it will just return 0 listings). The alert email will flag this as an anomaly.

**To update selectors:**

1. Open the site in Chrome DevTools.
2. Find the listing container (the repeating element that wraps each business listing).
3. Prefer stable attributes: semantic class names, `data-*` attributes, or structural selectors. Avoid position-based selectors like `:nth-child`.
4. Update the relevant entry in `scraper/sites.js`.
5. Test with `--site=<domain> --dry-run --debug`.
6. Once `normalizedValidListings` looks correct, commit and push.

**Known limitation:** There is no unique constraint on `url` in the database. If selectors are heavily retuned and canonical URLs change as a result, some listings may briefly reappear as "new" in a single run.

---

## Architecture

```
index.js                  Orchestrator: CLI flags, env validation, concurrency, email logic
scraper/
  engine.js               Fetch (Cheerio + Puppeteer fallback), pagination, normalization
  sites.js                Per-site config: selectors, pagination strategy, rate limits
db/
  database.js             Neon/PostgreSQL: migrate, upsert, anomaly baseline, run log
email/
  mailer.js               Nodemailer: digest email + operational alert email
utils/
  logger.js               Structured JSON logging to stdout
.github/
  workflows/scraper.yml   GitHub Actions: cron + manual trigger, Chrome cache, log artifact
```
