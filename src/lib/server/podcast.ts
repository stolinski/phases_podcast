import { XMLParser } from 'fast-xml-parser';
import type { Episode, EpisodeNoteBlock } from '$lib/episodes';

const FEED_URL = 'https://feeds.transistor.fm/phases-a-parenting-podcast-with-dr-courtney';
const FRESH_CACHE_KEY = 'https://phases.fm/__cache/podcast-episodes-v2';
const STALE_CACHE_KEY = 'https://phases.fm/__cache/podcast-episodes-stale-v2';
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

const namedEntities: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  rsquo: '’'
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (entity, decimal: string) => {
      try { return String.fromCodePoint(Number(decimal)); } catch { return entity; }
    })
    .replace(/&#x([\da-f]+);/gi, (entity, hexadecimal: string) => {
      try { return String.fromCodePoint(Number.parseInt(hexadecimal, 16)); } catch { return entity; }
    })
    .replace(/&([a-z]+);/gi, (entity, name: string) => namedEntities[name.toLowerCase()] ?? entity);
}

function cleanText(value: string): string {
  return decodeEntities(value)
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function episodeNotes(value: unknown): EpisodeNoteBlock[] {
  const html = text(value);
  const blocks: EpisodeNoteBlock[] = [];

  for (const match of html.matchAll(/<(p|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const [, element, content] = match;
    if (element.toLowerCase() === 'p') {
      const paragraph = cleanText(content);
      if (paragraph) blocks.push({ type: 'paragraph', text: paragraph });
      continue;
    }

    const items = [...content.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((item) => cleanText(item[1]))
      .filter(Boolean);
    if (items.length) blocks.push({ type: 'list', items });
  }

  const fallback = cleanText(html);
  return blocks.length ? blocks : [{ type: 'paragraph', text: fallback }];
}

function plainText(notes: EpisodeNoteBlock[]): string {
  return notes
    .flatMap((block) => block.type === 'paragraph' ? block.text : block.items)
    .join(' ')
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
    const notes = episodeNotes(item.description);

    return {
      id: text(item.guid),
      episode: Number(text(item['itunes:episode'] ?? item['podcast:episode'])),
      title: text(item['itunes:title'] ?? item.title).trim(),
      description: plainText(notes),
      notes,
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
