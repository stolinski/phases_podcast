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

## Episode editing hand-off

`tools/upnext` runs on the MacBook Pro that edits Phases. When every required media file for an episode has finished arriving in the Phases inbox, it moves the set into the normal episodes folder, opens DaVinci Resolve if it isn't running, and starts Claude Code from the Phases folder so its editing skills do the edit. Start with `npm run upnext -- doctor`, then `npm run upnext -- launchd install`. See [tools/upnext/README.md](tools/upnext/README.md).
