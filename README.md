# Phases.fm

A modern single-page podcast site built with Svelte 5, Vite, and [Media Chrome](https://www.media-chrome.org/).

## Development

```bash
npm install
npm run dev
```

## Validation

```bash
npm run check
npm run build
```

Episodes are fetched from the official Transistor RSS feed in the server-only homepage load. Successful responses are cached at the Cloudflare edge for 15 minutes, with a seven-day stale cache used when Transistor is temporarily unavailable. Publishing an episode does not require a source change or rebuild.

Cloudflare Pages configuration lives in `wrangler.toml`; the server-rendered build output is `.svelte-kit/cloudflare`.
