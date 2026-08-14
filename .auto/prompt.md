# Autoresearch: SEO and answer-engine visibility

## Objective
Increase qualified organic discovery of phases.fm by making the podcast site easier for search engines and answer engines to crawl, understand, cite, and send parents to. The real business outcome is higher Plausible traffic, but traffic is delayed and confounded, so each local experiment uses a deterministic SEO/AEO readiness score as the primary optimization signal. Plausible visitors are an optional long-horizon secondary metric when `PLAUSIBLE_API_KEY` is available.

Focus on substantive discoverability: indexable episode pages, clear information architecture, descriptive metadata, valid structured data, authoritative host/entity signals, useful answer-shaped episode content, and technical crawlability. Do not add empty pages or keyword-stuffed copy merely to satisfy the audit.

## Metrics
- **Primary**: `seo_aeo_score` (points, higher is better) — a 0–100 audit of rendered local pages covering metadata, crawl discovery, structured data, and useful indexable episode content.
- **Secondary**: `indexed_pages` (count), `episode_pages` (count), `response_ms` (median ms), `html_kb` (total rendered KB), `plausible_visitors_30d` (visitors, when API credentials exist).
- **North-star (delayed)**: qualified organic visitors and engagement in Plausible. Never claim a local score change caused traffic growth without enough post-deploy data.

## How to Run
`./.auto/measure.sh` starts the local SSR app, crawls it, and outputs `METRIC name=number` lines plus diagnostic audit findings.

Correctness runs separately through `./.auto/checks.sh` after a passing benchmark.

## Files in Scope
- `src/app.html` — document-wide metadata, resource hints, and analytics.
- `src/routes/**` — page routes, endpoint routes, sitemap/robots, and server data loading.
- `src/*.svelte` — rendered page content and page-specific metadata/structured data.
- `src/lib/**` — podcast parsing, slugging, metadata, and shared SEO helpers.
- `src/app.css` — styles needed for new crawlable content while preserving the visual system.
- `public/**` — static discovery and social assets.
- `.auto/**` — experiment harness and accumulated learnings.

## Off Limits
- Do not alter external podcast feed content or third-party profiles.
- Do not deploy, submit URLs to search engines, or modify Plausible settings without explicit authorization.
- Do not fabricate credentials, reviews, qualifications, citations, transcripts, or medical claims.
- Do not add dependencies unless a large, justified gain cannot be achieved with the existing stack.

## Constraints
- `npm run check` and `npm run build` must pass after every kept experiment.
- Keep the site fast: avoid unnecessary client JavaScript and preserve server-rendered content.
- Preserve or improve the current visual quality and responsive behavior.
- Use semantic, accessible markup and valid JSON-LD.
- The exact deferred analytics tag requested by the owner must be present: `<script defer data-domain="phases.fm" src="https://analytics.tolin.ski/js/script.js"></script>`.
- Prefer real user value over audit gaming. New pages must provide meaningful episode information.
- Run the Svelte autofixer on every modified `.svelte` file before keeping it.

## Experiment Strategy
1. Establish technical discovery and entity metadata: analytics, canonical/social tags, robots, sitemap, site/series/person schemas.
2. Create stable, server-rendered episode detail URLs from the RSS data with PodcastEpisode/Breadcrumb structured data and internal links.
3. Improve answer-engine utility using faithful episode summaries and scannable topics already present in the publisher-controlled RSS feed; do not invent advice beyond the source material.
4. Improve performance and metadata quality after the content architecture is in place.
5. Periodically compare deployed search/traffic trends, but keep delayed analytics separate from local causality.

## What's Been Tried
- Initial inspection: the site has a strong visual home page and SSR episode list, but episode notes point off-site, there are no dedicated episode URLs, sitemap, robots endpoint, canonical tags, or JSON-LD. Page metadata is partial and the requested Plausible script is absent.
- Search inspection: the homepage is indexed, but a `site:phases.fm` query exposes little evidence of independently discoverable episode pages. The main structural opportunity is turning the existing RSS catalog into durable first-party episode resources.
- Iterations 1–3: added the exact Plausible tag, crawlable robots/sitemap endpoints, and unique canonical/social metadata. These moved the local score from 20.33 to 46.20 without meaningful performance cost.
- Iteration 4: added linked Organization, WebSite, PodcastSeries, Person, ContactPage, and BreadcrumbList JSON-LD based only on claims already visible on the site. Score reached 68.20. In Svelte, interpolations inside a literal JSON-LD `<script>` render as text; safe static schemas must be emitted as a complete script via `{@html}` with `<` escaped. The autofixer warns generically about `{@html}`, but inputs are locally defined constants rather than user data.
- Iteration 5: created 24 first-party, server-rendered episode pages with stable numbered slugs, canonical/social metadata, PodcastEpisode and breadcrumb schemas, playable audio, source-attributed summaries, adjacent-episode navigation, and responsive styling. The sitemap now follows the live RSS catalog. Score reached 97.88. Desktop and 390px headless Chrome captures were reviewed; a mobile title overflow found during review was fixed by balancing and reducing the episode heading.
