'use strict';

// ---------------------------------------------------------------------------
// Site configuration for all 24 Belgian M&A / business acquisition sources.
//
// SELECTOR TUNING: Run a single site in dry-run mode to validate selectors:
//   node index.js --site=<domain> --dry-run --debug
//
// Compare rawItemsFound vs normalizedValidListings in the output.
// If rawItemsFound=0 → item selector is wrong.
// If rawItemsFound>0 but normalizedValidListings=0 → title or link selector is wrong.
//
// Fields:
//   enabled         — false: site is skipped entirely (dead URL, blocked, not a listing site)
//   needsJS         — true: always use Puppeteer (JS-rendered content)
//   ignoreSSLErrors — true: bypass SSL certificate verification (broken cert on their server)
//   maxPages        — hard cap on pagination depth
//   idStrategy      — 'url' (preferred) | 'title+domain' (emergency fallback, no stable URLs)
// ---------------------------------------------------------------------------

// Common "next page" selector tried on every site that has pagination type 'next'.
// If no matching element is found the engine simply stops — safe to use as default.
const NEXT_SELECTOR = [
  'a[rel="next"]',
  'a.next',
  'a.next-page',
  '.pagination a:last-child',
  '.pager a:last-child',
  'li.next a',
  'a:contains("Volgende")',
  'a:contains("volgende")',
  'a:contains("Next")',
  'a:contains(">")',
  '[aria-label="Next page"]',
  '[aria-label="Volgende pagina"]',
].join(', ');

const DEFAULTS = {
  enabled:         true,
  needsJS:         false,
  ignoreSSLErrors: false,
  maxPages:        20,
  rateLimitMsMin:  2000,
  rateLimitMsMax:  4000,
  idStrategy:      'url',
  filters:         { minTitleLength: 5 },
  // Default: always try to follow a next-page link.
  // Sites with no pagination simply won't find a next link and stop at page 1.
  pagination:      { type: 'next', selector: NEXT_SELECTOR },
};

function site(overrides) {
  return { ...DEFAULTS, ...overrides };
}

module.exports = [

  // 1. Overnamemarkt — Alpine.js rendered, Cheerio gets empty shell
  site({
    name:     'Overnamemarkt',
    domain:   'overnamemarkt.be',
    startUrl: 'https://www.overnamemarkt.be/kopen',
    needsJS:  true,
    selectors: {
      item:        'a[href*="/kopen/"]',
      title:       'h3',
      description: 'p, span, .description, .excerpt, .sector, .location, [class*="sector"], [class*="location"], [class*="desc"]',
      link:        '', // item itself is the <a>
    },
    pagination: { type: 'numbered', selector: 'ul li a[href*="/kopen"]' },
  }),

  // 2. TakeoverServices — Site123 builder platform
  site({
    name:     'TakeoverServices',
    domain:   'takeoverservices.com',
    startUrl: 'https://www.takeoverservices.com/over-te-nemen-1',
    needsJS:  true,
    selectors: {
      item:        '.product-container, .s123-module-products-item, .s123-ajax-products article',
      title:       'h3, h4, .title, .product-title',
      description: 'p, .description',
      link:        'a',
    },
  }),

  // 3. Group-P — item confirmed: .w-grid-item
  site({
    name:     'Group-P',
    domain:   'group-p.be',
    startUrl: 'https://group-p.be/acheter-une-entreprise/',
    selectors: {
      item:        '.w-grid-item',
      title:       'h3, .usg_post_title_1',
      description: '.usg_post_custom_field_1, p',
      link:        'a',
    },
  }),

  // 4. De Brugse Databank — DISABLED: URL returns 404
  site({
    name:    'De Brugse Databank',
    domain:  'de-brugse-databank.be',
    startUrl: 'https://www.de-brugse-databank.be/Producten/Overtenemen/AanbodOvertenemen.html',
    enabled: false, // 404 — page no longer exists
    selectors: { item: 'tr', title: 'td', description: 'td', link: 'a' },
  }),

  // 5. 2sell.be — item: div.block, link: a.arrow-link
  site({
    name:     '2sell',
    domain:   '2sell.be',
    startUrl: 'https://2sell.be/aanbod.html',
    selectors: {
      item:        'div.block',
      title:       'div.text-section, h2, h3',
      description: 'div.text-section p, p',
      link:        'a.arrow-link, a',
    },
  }),

  // 6. Pro-Maxx — DISABLED: connection error (HTTP site, unresponsive)
  site({
    name:    'Pro-Maxx',
    domain:  'pro-maxx.be',
    startUrl: 'http://www.pro-maxx.be/nl/te-koop/',
    enabled: false, // socket connection error, site unresponsive
    selectors: { item: '.property', title: 'h2', description: 'p', link: 'a' },
  }),

  // 7. AD Corporate — listings embedded via iframe from bedrijventekoop.be
  // Point directly at the iframe URL which is server-rendered HTML
  site({
    name:     'AD Corporate',
    domain:   'adcorporate.be',
    startUrl: 'https://www.bedrijventekoop.be/iframe/adcorporate',
    selectors: {
      item:        '.search-result-item',
      title:       'a.description-name',
      description: 'a.description',
      link:        'a.description-name',
    },
    pagination: { type: 'next', selector: 'a[rel="next"], .paginator a.next, .paginator a:last-child' },
  }),

  // 8. Blue-Bridge — DISABLED: company no longer operating
  site({
    name:    'Blue-Bridge',
    domain:  'blue-bridge.be',
    startUrl: 'https://www.blue-bridge.be/portfolio',
    enabled: false,
    selectors: { item: 'article', title: 'h2', description: 'p', link: 'a' },
  }),

  // 9. MultipleChoice — DISABLED: not a listing directory (service overview site)
  site({
    name:    'MultipleChoice',
    domain:  'multiplechoice.be',
    startUrl: 'https://multiplechoice.be/',
    enabled: false, // single-page service site, no individual listings
    selectors: { item: 'article', title: 'h2', description: 'p', link: 'a' },
  }),

  // 10. Overname Partners — Elementor, item is <a> wrapping each card
  site({
    name:     'Overname Partners',
    domain:   'overnamepartners.be',
    startUrl: 'https://overnamepartners.be/bedrijven-te-koop/',
    selectors: {
      item:        'a[href*="bedrijven-te-koop/"]',
      title:       '.elementor-heading-title, h2, h3',
      description: 'p, .elementor-widget-text-editor',
      link:        '', // item itself is the <a>
    },
    pagination: { type: 'next', selector: 'a.next, a[rel="next"]' },
  }),

  // 11. KMO Overname — Drupal 10, server-rendered views rows
  site({
    name:     'KMO Overname',
    domain:   'kmo-overname.be',
    startUrl: 'https://www.kmo-overname.be/bedrijven/aanbod-kmo-overnames',
    selectors: {
      item:        '.views-row',
      title:       'h2',
      description: 'p',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a[rel="next"], li.pager__item--next a' },
  }),

  // 12. Van Damme Partners — items are <li> with links to /bedrijven/[slug]
  site({
    name:     'Van Damme Partners',
    domain:   'vandamme-partners.be',
    startUrl: 'https://www.vandamme-partners.be/te-koop',
    selectors: {
      item:        'li:has(a[href*="/bedrijven/"])',
      title:       'a[href*="/bedrijven/"]',
      description: 'p',
      link:        'a[href*="/bedrijven/"]',
    },
    pagination: { type: 'next', selector: 'a[href*="?page="], a:contains("volgende")' },
  }),

  // 13. OBA — item is <a> linking to /portefeuille/bedrijfsfiche/[id]
  site({
    name:     'OBA',
    domain:   'oba.be',
    startUrl: 'https://www.oba.be/nl/portefeuille/',
    selectors: {
      item:        'a[href*="/portefeuille/bedrijfsfiche/"]',
      title:       'h3, h2',
      description: 'p',
      link:        '', // item itself is the <a>
    },
    pagination: { type: 'next', selector: 'a.next, a[rel="next"]' },
  }),

  // 14. ABM Plus — content often truncated, try with Puppeteer
  site({
    name:     'ABM Plus',
    domain:   'abm-plus.be',
    startUrl: 'https://abm-plus.be/overnames/overzicht-van-ons-aanbod/',
    needsJS:  true,
    selectors: {
      item:        'article, .listing, .overname-item, .post',
      title:       'h2, h3, .entry-title, .title',
      description: 'p, .excerpt, .description',
      link:        'a',
    },
    pagination: { type: 'next', selector: 'a.next-page, a[rel="next"]' },
  }),

  // 15. DaVinci CF — Vue.js / Craft CMS rendered; correct URL is /nl/portfolio
  site({
    name:     'DaVinci CF',
    domain:   'davinci-cf.be',
    startUrl: 'https://www.davinci-cf.be/nl/portfolio',
    needsJS:  true,
    selectors: {
      item:        '.project, article, .card, [class*="project"]',
      title:       'h2, h3, h4, .title, [class*="title"]',
      description: 'p, .description, [class*="description"]',
      link:        'a',
    },
  }),

  // 16. Coforce — table-based layout, link is in the description column
  site({
    name:     'Coforce',
    domain:   'coforce.be',
    startUrl: 'https://www.coforce.be/nl/over-te-nemen',
    selectors: {
      item:        'table tbody tr, table tr',
      title:       'td a',
      description: 'td:nth-child(3), td:nth-child(2)',
      link:        'td a',
    },
  }),

  // 17. Finactor — item is <a> linking to /bedrijven-te-koop/[slug]
  site({
    name:     'Finactor',
    domain:   'finactor.be',
    startUrl: 'https://finactor.be/bedrijfsovername/bedrijven-te-koop/',
    selectors: {
      item:        'a[href*="/bedrijven-te-koop/"]',
      title:       'strong, b, h2, h3',
      description: 'p',
      link:        '', // item itself is the <a>
    },
    pagination: { type: 'next', selector: 'a.next-page, a[rel="next"]' },
  }),

  // 18. Aquis — link pattern confirmed: /aanbod/[project-name]
  site({
    name:     'Aquis',
    domain:   'aquis.be',
    startUrl: 'https://www.aquis.be/aanbod',
    selectors: {
      item:        'a[href*="/aanbod/"]',
      title:       'h2, h3, strong',
      description: 'p',
      link:        '', // item itself is the <a>
    },
  }),

  // 19. A-Square — WordPress + WPBakery Visual Composer grid (server-rendered)
  // HTTP only (no HTTPS cert); Chromium blocks HTTP so Puppeteer fallback is disabled
  site({
    name:               'A-Square',
    domain:             'a-square.be',
    startUrl:           'http://a-square.be/',
    noPuppeteerFallback: true, // Chromium blocks plain HTTP navigation
    selectors: {
      item:        '.vc_grid-item',
      title:       'h4, .vc_custom_heading',
      description: '.type-textarea, p',
      link:        'a.vc_gitem-link, a',
    },
  }),

  // 20. Advisory Team — server-rendered, confirmed 2 listings currently
  site({
    name:     'Advisory Team',
    domain:   'advisoryteam.be',
    startUrl: 'https://www.advisoryteam.be/overnames',
    selectors: {
      item:        '.highlights-overview__item',
      title:       'h2',
      description: 'p',
      link:        'a.btn',
    },
  }),

  // 21. Dealmakers Opportunities — React SPA (Betty Blocks + MUI)
  // Listings visible without login; detail pages require auth (link still captured)
  // data-component attributes are stable Betty Blocks identifiers
  site({
    name:     'Dealmakers',
    domain:   'opportunities.dealmakers.be',
    startUrl: 'https://opportunities.dealmakers.be/nl/filter',
    needsJS:  true,
    selectors: {
      item:        '[data-component="Box"]:has(> h5)',
      title:       'h5',
      description: 'p',
      link:        'a[data-component="Button"]',
    },
  }),

  // 22. Varafin — SSL cert issue on their server; bypass verification
  // needsJS: true because Cheerio finds rows but links resolve to page URL (no detail links)
  site({
    name:            'Varafin',
    domain:          'varafin.be',
    startUrl:        'https://www.varafin.be/opdrachten',
    ignoreSSLErrors: true,
    needsJS:         true,
    selectors: {
      item:        '.opdracht, article, .listing, .case, .card, tr:has(td a)',
      title:       'h2, h3, .title, td:nth-child(2), td:first-child',
      description: 'p, .description, td:nth-child(3)',
      link:        'a[href]:not([href="#"]):not([href=""])',
    },
  }),

  // 23. Atkinson — listings as h3 headings with metadata; idStrategy fallback
  site({
    name:       'Atkinson',
    domain:     'atkinson.be',
    startUrl:   'https://atkinson.be/portefeuille',
    idStrategy: 'title+domain', // no stable per-listing detail URLs
    selectors: {
      item:        'h3',
      title:       '', // h3 text itself is the title (engine falls back to $el.text())
      description: 'p',
      link:        'a[href*="/portefeuille/"]',
    },
  }),

  // 24. BedrijvenTeKoop — listings loaded dynamically via JS
  site({
    name:     'BedrijvenTeKoop',
    domain:   'bedrijventekoop.be',
    startUrl: 'https://www.bedrijventekoop.be/te-koop-aangeboden',
    needsJS:  true,
    selectors: {
      item:        '#listing .listing, #listing article, .listing-item, .bedrijf-item',
      title:       'h2, h3, .title, .bedrijfsnaam',
      description: 'p, .description, .omschrijving',
      link:        'a',
    },
    pagination: { type: 'numbered', selector: '.pagination a, .pager a' },
  }),
];
