#!/usr/bin/env node

const origin = process.env.AUDIT_ORIGIN ?? 'http://127.0.0.1:4179';
const canonicalOrigin = 'https://phases.fm';
const maxPages = 100;

const decode = (value = '') => value
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>');
const text = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const match = (html, pattern) => decode(html.match(pattern)?.[1]?.trim() ?? '');
const metas = (html) => [...html.matchAll(/<meta\s+[^>]*(?:name|property)=(["'])(.*?)\1[^>]*content=(["'])(.*?)\3[^>]*>/gi)].reduce((all, item) => ({ ...all, [item[2].toLowerCase()]: decode(item[4]) }), {});
const links = (html) => [...html.matchAll(/<a\s+[^>]*href=["']([^"'#]+)(?:#[^"']*)?["'][^>]*>/gi)].map((item) => decode(item[1]));
const schemas = (html) => [...html.matchAll(/<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((item) => item[1]);
const types = (value) => {
  if (!value || typeof value !== 'object') return [];
  const own = Array.isArray(value['@type']) ? value['@type'] : [value['@type']].filter(Boolean);
  return [...own, ...Object.values(value).flatMap(types)];
};
const clamp = (value, max) => Math.min(max, Math.max(0, value));
const ratio = (items, predicate) => items.length ? items.filter(predicate).length / items.length : 0;
const award = (points, max, fraction, label) => {
  const earned = Math.round(max * clamp(fraction, 1) * 100) / 100;
  points.value += earned;
  if (earned < max) findings.push(`${label}: ${earned}/${max}`);
};

const queue = ['/', '/courtney', '/questions'];
const seen = new Set();
const pages = [];
const responseTimes = [];

while (queue.length && pages.length < maxPages) {
  const path = queue.shift();
  if (!path || seen.has(path)) continue;
  seen.add(path);
  const started = performance.now();
  const response = await fetch(new URL(path, origin), { redirect: 'follow' });
  responseTimes.push(performance.now() - started);
  const html = await response.text();
  const page = {
    path,
    status: response.status,
    html,
    title: match(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: metas(html).description,
    meta: metas(html),
    canonical: match(html, /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i),
    h1s: [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((item) => text(item[1])),
    words: text(html).split(/\s+/).filter(Boolean).length,
    links: links(html),
    schemaRaw: schemas(html),
    schemas: []
  };
  for (const raw of page.schemaRaw) {
    try { page.schemas.push(JSON.parse(raw)); } catch { page.schemas.push(null); }
  }
  pages.push(page);
  for (const href of page.links) {
    try {
      const url = new URL(href, canonicalOrigin);
      if (url.origin === canonicalOrigin && !/\.(?:jpg|jpeg|png|svg|xml|mp3|pdf)$/i.test(url.pathname)) queue.push(url.pathname || '/');
    } catch {}
  }
}

const findings = [];
const points = { value: 0 };
const okPages = pages.filter((page) => page.status === 200);
const titles = okPages.map((page) => page.title);
const descriptions = okPages.map((page) => page.description);
const allTypes = (page) => page.schemas.flatMap(types);
const episodePages = okPages.filter((page) => page.path.startsWith('/episodes/'));
const innerPages = okPages.filter((page) => page.path !== '/');

// Page quality: 30 points
award(points, 2, ratio(pages, (page) => page.status === 200), 'Successful crawl');
award(points, 4, ratio(okPages, (page) => page.title.length >= 15 && page.title.length <= 65) * (new Set(titles).size / Math.max(1, titles.length)), 'Unique, well-sized titles');
award(points, 4, ratio(okPages, (page) => page.description.length >= 70 && page.description.length <= 170) * (new Set(descriptions).size / Math.max(1, descriptions.length)), 'Unique, well-sized descriptions');
award(points, 4, ratio(okPages, (page) => page.canonical === `${canonicalOrigin}${page.path === '/' ? '' : page.path}` || page.canonical === `${canonicalOrigin}${page.path}`), 'Canonical URLs');
award(points, 4, ratio(okPages, (page) => ['og:title', 'og:description', 'og:image', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].every((key) => page.meta[key])), 'Complete social metadata');
award(points, 2, ratio(okPages, (page) => page.h1s.length === 1 && page.h1s[0].length > 5), 'Single descriptive H1');
award(points, 3, ratio(okPages, (page) => page.words >= 120), 'Substantive rendered copy');
award(points, 2, ratio(okPages, (page) => !page.links.some((href) => href.startsWith('/') && pages.some((candidate) => candidate.path === href && candidate.status !== 200))), 'Internal link integrity');
award(points, 2, ratio(okPages, (page) => page.html.includes('<script defer data-domain="phases.fm" src="https://analytics.tolin.ski/js/script.js"></script>')), 'Requested Plausible tag');
award(points, 1, ratio(okPages, (page) => !/<img\b(?![^>]*\balt=)[^>]*>/i.test(page.html)), 'Image alt attributes');
award(points, 2, ratio(okPages, (page) => /<html[^>]*lang=["']en["']/i.test(page.html) && /name=["']viewport["']/i.test(page.html)), 'Language and viewport');

// Discovery: 20 points
const [robotsResponse, sitemapResponse] = await Promise.all([fetch(`${origin}/robots.txt`), fetch(`${origin}/sitemap.xml`)]);
const robots = await robotsResponse.text();
const sitemap = await sitemapResponse.text();
const sitemapPaths = [...sitemap.matchAll(/<loc>https:\/\/phases\.fm([^<]*)<\/loc>/g)].map((item) => item[1] || '/');
award(points, 5, robotsResponse.ok && /Sitemap:\s*https:\/\/phases\.fm\/sitemap\.xml/i.test(robots) && !/Disallow:\s*\//i.test(robots) ? 1 : 0, 'Robots and sitemap declaration');
award(points, 7, sitemapResponse.ok && /<urlset\b/.test(sitemap) ? ratio(okPages, (page) => sitemapPaths.includes(page.path)) : 0, 'Sitemap coverage');
award(points, 4, clamp(sitemapPaths.length / 10, 1), 'Indexable URL inventory');
award(points, 2, okPages[0]?.html.includes('type="application/rss+xml"') ? 1 : 0, 'Podcast RSS discovery');
award(points, 2, ratio(okPages, (page) => !/noindex/i.test(page.meta.robots ?? '')), 'Pages are indexable');

// Structured data and entities: 35 points
award(points, 3, ratio(okPages.flatMap((page) => page.schemaRaw), (raw) => { try { JSON.parse(raw); return true; } catch { return false; } }), 'Valid JSON-LD');
const home = okPages.find((page) => page.path === '/');
for (const schemaType of ['WebSite', 'Organization', 'PodcastSeries']) award(points, 3, home && allTypes(home).includes(schemaType) ? 1 : 0, `${schemaType} schema`);
const courtney = okPages.find((page) => page.path === '/courtney');
award(points, 4, courtney && allTypes(courtney).includes('Person') ? 1 : 0, 'Expert Person schema');
const questions = okPages.find((page) => page.path === '/questions');
award(points, 2, questions && allTypes(questions).some((type) => ['ContactPage', 'WebPage'].includes(type)) ? 1 : 0, 'Questions page schema');
award(points, 2, ratio(innerPages, (page) => allTypes(page).includes('BreadcrumbList')), 'Breadcrumb schemas');
award(points, 10, clamp(episodePages.length / 10, 1), 'Podcast episode inventory');
award(points, 3, ratio(episodePages, (page) => allTypes(page).includes('PodcastEpisode')), 'PodcastEpisode schemas');
award(points, 2, courtney && /"(?:jobTitle|knowsAbout|sameAs)"/.test(courtney.schemaRaw.join('')) ? 1 : 0, 'Expertise details');

// Useful answer-shaped content: 15 points
award(points, 6, clamp(episodePages.length / 10, 1), 'Dedicated episode resources');
award(points, 3, clamp(episodePages.filter((page) => /<section\s+class=["']episode-resources["']/i.test(page.html)).length / 4, 1), 'Publisher resource preservation');
award(points, 2, ratio(episodePages, (page) => /<section\s+class=["']episode-notes["'][\s\S]*?<(?:ul|ol)\b/i.test(page.html)), 'Structured publisher episode notes');
award(points, 2, ratio(episodePages, (page) => /<time\b/i.test(page.html) && /<audio\b/i.test(page.html)), 'Episode date and playable audio');
award(points, 2, episodePages.length ? ratio(okPages, (page) => page.links.some((href) => {
  try { return new URL(href, canonicalOrigin).pathname.startsWith('/episodes/'); } catch { return false; }
})) : 0, 'Internal episode linking');

const score = Math.round(points.value * 100) / 100;
const sortedTimes = [...responseTimes].sort((a, b) => a - b);
const medianMs = sortedTimes[Math.floor(sortedTimes.length / 2)] ?? 0;
const htmlKb = okPages.reduce((sum, page) => sum + Buffer.byteLength(page.html), 0) / 1024;

console.log(`METRIC seo_aeo_score=${score}`);
console.log(`METRIC indexed_pages=${sitemapPaths.length}`);
console.log(`METRIC episode_pages=${episodePages.length}`);
console.log(`METRIC response_ms=${medianMs.toFixed(2)}`);
console.log(`METRIC html_kb=${htmlKb.toFixed(2)}`);
console.log(`AUDIT crawled=${pages.length} findings=${findings.length}`);
for (const finding of findings) console.log(`AUDIT ${finding}`);

if (process.env.PLAUSIBLE_API_KEY) {
  try {
    const params = new URLSearchParams({
      site_id: 'phases.fm',
      period: '30d',
      metrics: 'visitors'
    });
    const response = await fetch(`https://analytics.tolin.ski/api/v1/stats/aggregate?${params}`, {
      headers: { authorization: `Bearer ${process.env.PLAUSIBLE_API_KEY}` }
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    const visitors = data?.results?.visitors?.value;
    if (Number.isFinite(visitors)) console.log(`METRIC plausible_visitors_30d=${visitors}`);
  } catch (error) {
    console.error(`AUDIT Plausible metric unavailable: ${error.message}`);
  }
}
