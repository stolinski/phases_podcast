import { XMLParser } from 'fast-xml-parser';
import type { Episode } from '$lib/episodes';

const FEED_URL = 'https://feeds.transistor.fm/phases-a-parenting-podcast-with-dr-courtney';
const FRESH_CACHE_KEY = 'https://phases.fm/__cache/podcast-episodes-v1';
const STALE_CACHE_KEY = 'https://phases.fm/__cache/podcast-episodes-stale-v1';
const FRESH_TTL_SECONDS = 15 * 60;
const STALE_TTL_SECONDS = 7 * 24 * 60 * 60;

let memoryCache: { episodes: Episode[]; expiresAt: number } | undefined;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (_name, path) => path === 'rss.channel.item'
});

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in value) {
    return String((value as { '#text': unknown })['#text']);
  }
  return '';
}

function plainText(value: unknown): string {
  return text(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function durationInSeconds(value: unknown): number {
  const duration = text(value);
  if (/^\d+$/.test(duration)) return Number(duration);

  const parts = duration.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function parseEpisodes(xml: string): Episode[] {
  const document = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown[] } };
  };
  const items = document.rss?.channel?.item;

  if (!Array.isArray(items)) throw new Error('Podcast RSS did not contain any episodes');

  const episodes = items.map((rawItem) => {
    const item = rawItem as Record<string, unknown>;
    const enclosure = item.enclosure as Record<string, unknown> | undefined;
    const date = new Date(text(item.pubDate));

    return {
      id: text(item.guid),
      episode: Number(text(item['itunes:episode'] ?? item['podcast:episode'])),
      title: text(item['itunes:title'] ?? item.title).trim(),
      description: plainText(item.description),
      date: date.toISOString(),
      audio: text(enclosure?.['@_url']),
      duration: durationInSeconds(item['itunes:duration']),
      share: text(item.link)
    } satisfies Episode;
  });

  const validEpisodes = episodes.filter(
    (episode) => episode.id && episode.title && episode.audio && Number.isFinite(episode.episode)
  );

  if (!validEpisodes.length) throw new Error('Podcast RSS episodes were invalid');

  return validEpisodes.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

async function readCache(cache: Cache | undefined, key: string): Promise<Episode[] | undefined> {
  const response = await cache?.match(key);
  if (!response?.ok) return undefined;

  try {
    return (await response.json()) as Episode[];
  } catch {
    await cache?.delete(key);
    return undefined;
  }
}

function cacheResponse(episodes: Episode[], ttl: number): Response {
  return new Response(JSON.stringify(episodes), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${ttl}`
    }
  });
}

export async function getEpisodes(
  fetcher: typeof fetch,
  platform?: App.Platform
): Promise<Episode[]> {
  if (memoryCache && memoryCache.expiresAt > Date.now()) return memoryCache.episodes;

  const cache = platform?.caches?.default;
  const freshEpisodes = await readCache(cache, FRESH_CACHE_KEY);
  if (freshEpisodes) {
    memoryCache = { episodes: freshEpisodes, expiresAt: Date.now() + FRESH_TTL_SECONDS * 1000 };
    return freshEpisodes;
  }

  try {
    const response = await fetcher(FEED_URL, {
      headers: { accept: 'application/rss+xml, application/xml;q=0.9' }
    });
    if (!response.ok) throw new Error(`Podcast RSS returned ${response.status}`);

    const episodes = parseEpisodes(await response.text());
    memoryCache = { episodes, expiresAt: Date.now() + FRESH_TTL_SECONDS * 1000 };

    if (cache) {
      const writes = Promise.all([
        cache.put(FRESH_CACHE_KEY, cacheResponse(episodes, FRESH_TTL_SECONDS)),
        cache.put(STALE_CACHE_KEY, cacheResponse(episodes, STALE_TTL_SECONDS))
      ]);
      if (platform?.ctx) platform.ctx.waitUntil(writes);
      else await writes;
    }

    return episodes;
  } catch (error) {
    const staleEpisodes = await readCache(cache, STALE_CACHE_KEY);
    if (staleEpisodes) return staleEpisodes;
    throw error;
  }
}
