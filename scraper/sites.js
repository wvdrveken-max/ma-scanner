'use strict';

// ---------------------------------------------------------------------------
// Site configuration for all 24 Belgian M&A / business acquisition sources.
//
// IMPORTANT: Selectors are best-effort starting points. After the first test
// run, compare `rawItemsFound` vs `normalizedValidListings` in the logs to
// identify sites that need selector tuning. Use:
//
//   node index.js --site=<domain> --dry-run --debug
//
// to iterate on a single site without touching the DB or sending email.
//
// Fields:
//   name            — human-readable label used in email + logs
//   domain          — bare domain, used as source_domain and for ID hashing
//   startUrl        — first page to scrape
//   enabled         — set false to skip a site without deleting its config
//   needsJS         — true: always use Puppeteer; false: Cheerio first
//   maxPages        — hard cap on pagination depth (default 20)
//   rateLimitMsMin  — minimum delay between page fetches (ms)
//   rateLimitMsMax  — maximum delay between page fetches (ms)
//   idStrategy      — 'url' (preferred) | 'title+domain' (emergency fallback)
//   selectors       — item: listing container; title/description/link: sub-selectors
//   pagination      — type: 'next'|'numbered'|'loadmore'|'none'; selector: CSS
//   filters         — minTitleLength: discard suspiciously short titles
//   // extract: null  — reserved for future per-site custom extractor function
// ---------------------------------------------------------------------------

const DEFAULTS = {
  enabled:       true,
  needsJS:       false,
  maxPages:      20,
  rateLimitMsMin: 2000,
  rateLimitMsMax: 4000,
  idStrategy:    'url',
  filters:       { minTitleLength: 5 },
};

function site(overrides) {
  return { ...DEFAULTS, ...overrides };
}

module.exports = [

  // 1. Overnamemarkt
  site({
    name:     'Overnamemarkt',
    domain:   'overnamemarkt.be',
    startUrl: 'https://www.overnamemarkt.be/kopen',
    selectors: {
      item:        '.aanbod-item, .listing-item, article.bedrijf',
      title:       'h2, h3, .title, .bedrijf-naam',
      description: '.omschrijving, .description, p',
      link:        'a',
    },
    pagination: { type: 'numbered', selector: '.pagination a, .pager a' },
  }),

  // 2. TakeoverServices
  site({
    name:     'TakeoverServices',
    domain:   'takeoverservices.com',
    startUrl: 'https://www.takeoverservices.com/over-te-nemen-1',
    selectors: {
      item:        '.listing, .bedrijf, article, .item',
      title:       'h2, h3, .title',
      description: 'p, .description, .omschrijving',
      link:        'a',
    },
    pagination: { type: 'numbered', selector: '.pagination a, a[href*="page"]' },
  }),

  // 3. Group-P
  site({
    name:     'Group-P',
    domain:   'group-p.be',
    startUrl: 'https://group-p.be/acheter-une-entreprise/',
    selectors: {
      item:        '.entreprise, article, .property, .listing',
      title:       'h2, h3, .title, .name',
      description: 'p, .description, .excerpt',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next, a[rel="next"], .nav-next a' },
  }),

  // 4. De Brugse Databank
  site({
    name:     'De Brugse Databank',
    domain:   'de-brugse-databank.be',
    startUrl: 'https://www.de-brugse-databank.be/Producten/Overtenemen/AanbodOvertenemen.html',
    selectors: {
      item:        'table tr, .aanbod tr, tr.item',
      title:       'td:first-child, .title, h3',
      description: 'td:nth-child(2), .omschrijving',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 5. 2sell.be
  site({
    name:     '2sell',
    domain:   '2sell.be',
    startUrl: 'https://2sell.be/aanbod.html',
    selectors: {
      item:        '.aanbod-item, .listing, article, .bedrijf',
      title:       'h2, h3, .title',
      description: 'p, .description',
      link:        'a',
    },
    pagination: { type: 'numbered', selector: '.pagination a' },
  }),

  // 6. Pro-Maxx
  site({
    name:     'Pro-Maxx',
    domain:   'pro-maxx.be',
    startUrl: 'http://www.pro-maxx.be/nl/te-koop/',
    selectors: {
      item:        '.property, article, .listing, .te-koop-item',
      title:       'h2, h3, .title, .property-title',
      description: 'p, .description, .property-description',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next, a[rel="next"]' },
  }),

  // 7. AD Corporate
  site({
    name:     'AD Corporate',
    domain:   'adcorporate.be',
    startUrl: 'https://www.adcorporate.be/aanbod/',
    selectors: {
      item:        'article, .aanbod-item, .post, .case',
      title:       'h2, h3, .entry-title, .title',
      description: 'p, .excerpt, .description',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next-page, a[rel="next"], .nav-next a' },
  }),

  // 8. Blue-Bridge
  site({
    name:     'Blue-Bridge',
    domain:   'blue-bridge.be',
    startUrl: 'https://www.blue-bridge.be/portfolio',
    selectors: {
      item:        '.portfolio-item, article, .case, .project',
      title:       'h2, h3, .title',
      description: 'p, .description, .excerpt',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 9. MultipleChoice
  site({
    name:     'MultipleChoice',
    domain:   'multiplechoice.be',
    startUrl: 'https://multiplechoice.be/',
    selectors: {
      item:        'article, .listing, .bedrijf, .aanbod-item',
      title:       'h2, h3, .title',
      description: 'p, .description',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 10. Overname Partners
  site({
    name:     'Overname Partners',
    domain:   'overnamepartners.be',
    startUrl: 'https://overnamepartners.be/bedrijven-te-koop/',
    selectors: {
      item:        'article, .bedrijf, .listing-item, .property',
      title:       'h2, h3, .entry-title, .title',
      description: 'p, .excerpt, .description',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next-page, a[rel="next"]' },
  }),

  // 11. KMO Overname
  site({
    name:     'KMO Overname',
    domain:   'kmo-overname.be',
    startUrl: 'https://www.kmo-overname.be/bedrijven/aanbod-kmo-overnames',
    selectors: {
      item:        '.bedrijf, article, .listing, .case-item',
      title:       'h2, h3, .bedrijfsnaam, .title',
      description: '.omschrijving, p, .description',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next, .pager a.next, a[rel="next"]' },
  }),

  // 12. Van Damme Partners
  site({
    name:     'Van Damme Partners',
    domain:   'vandamme-partners.be',
    startUrl: 'https://www.vandamme-partners.be/te-koop',
    selectors: {
      item:        'article, .listing, .dossier, .property',
      title:       'h2, h3, .title',
      description: 'p, .description, .excerpt',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 13. OBA
  site({
    name:     'OBA',
    domain:   'oba.be',
    startUrl: 'https://www.oba.be/nl/portefeuille/',
    selectors: {
      item:        '.dossier, .case, article, .portefeuille-item',
      title:       'h2, h3, .title, .dossier-titel',
      description: 'p, .description, .omschrijving',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next, a[rel="next"]' },
  }),

  // 14. ABM Plus
  site({
    name:     'ABM Plus',
    domain:   'abm-plus.be',
    startUrl: 'https://abm-plus.be/overnames/overzicht-van-ons-aanbod/',
    selectors: {
      item:        'article, .listing, .overname-item, .post',
      title:       'h2, h3, .entry-title, .title',
      description: 'p, .excerpt, .description',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next-page, a[rel="next"]' },
  }),

  // 15. DaVinci CF
  site({
    name:     'DaVinci CF',
    domain:   'davinci-cf.be',
    startUrl: 'https://www.davinci-cf.be/nl/portefeuille',
    selectors: {
      item:        '.case, .dossier, article, .portfolio-item',
      title:       'h2, h3, .title',
      description: 'p, .description',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 16. Coforce
  site({
    name:     'Coforce',
    domain:   'coforce.be',
    startUrl: 'https://www.coforce.be/nl/over-te-nemen',
    selectors: {
      item:        '.over-te-nemen-item, article, .listing, .card',
      title:       'h2, h3, .title',
      description: 'p, .description, .omschrijving',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 17. Finactor
  site({
    name:     'Finactor',
    domain:   'finactor.be',
    startUrl: 'https://finactor.be/bedrijfsovername/bedrijven-te-koop/',
    selectors: {
      item:        'article, .bedrijf, .listing-item',
      title:       'h2, h3, .entry-title, .title',
      description: 'p, .excerpt, .description',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next-page, a[rel="next"]' },
  }),

  // 18. Aquis
  site({
    name:     'Aquis',
    domain:   'aquis.be',
    startUrl: 'https://www.aquis.be/aanbod',
    selectors: {
      item:        '.aanbod-item, .listing, article, .case',
      title:       'h2, h3, .title',
      description: 'p, .description, .omschrijving',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 19. A-Square
  site({
    name:     'A-Square',
    domain:   'a-square.be',
    startUrl: 'http://a-square.be/',
    selectors: {
      item:        'article, .listing, .bedrijf, .item',
      title:       'h2, h3, .title',
      description: 'p, .description',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 20. Advisory Team
  site({
    name:     'Advisory Team',
    domain:   'advisoryteam.be',
    startUrl: 'https://www.advisoryteam.be/overnames',
    selectors: {
      item:        'article, .overname, .listing, .case',
      title:       'h2, h3, .title',
      description: 'p, .description, .excerpt',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 21. Dealmakers Opportunities
  site({
    name:     'Dealmakers',
    domain:   'opportunities.dealmakers.be',
    startUrl: 'https://opportunities.dealmakers.be/nl/filter',
    needsJS:  true, // filter/listing page likely JS-rendered
    selectors: {
      item:        '.opportunity, article, .listing, .deal',
      title:       'h2, h3, .title, .opportunity-title',
      description: 'p, .description, .excerpt',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next, button.next, [aria-label="Next"]' },
  }),

  // 22. Varafin
  site({
    name:     'Varafin',
    domain:   'varafin.be',
    startUrl: 'https://www.varafin.be/opdrachten',
    selectors: {
      item:        '.opdracht, article, .listing, .case',
      title:       'h2, h3, .title',
      description: 'p, .description',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 23. Atkinson
  site({
    name:     'Atkinson',
    domain:   'atkinson.be',
    startUrl: 'https://atkinson.be/portefeuille',
    selectors: {
      item:        '.portefeuille-item, article, .case, .listing',
      title:       'h2, h3, .title',
      description: 'p, .description',
      link:        'a',
    },
    pagination: { type: 'none' },
  }),

  // 24. BedrijvenTeKoop
  site({
    name:     'BedrijvenTeKoop',
    domain:   'bedrijventekoop.be',
    startUrl: 'https://www.bedrijventekoop.be/te-koop-aangeboden',
    selectors: {
      item:        '.listing, article, .bedrijf, .aanbod-item',
      title:       'h2, h3, .title, .bedrijfsnaam',
      description: 'p, .description, .omschrijving',
      link:        'a',
    },
    pagination: { type: 'numbered', selector: '.pagination a, .pager a' },
  }),
];
