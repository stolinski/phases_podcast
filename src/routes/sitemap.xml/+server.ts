import { episodeSlug } from '$lib/episodes';
import { getEpisodes } from '$lib/server/podcast';
import type { RequestHandler } from './$types';

const pages = ['/', '/courtney', '/questions'];

export const GET: RequestHandler = async ({ fetch, platform }) => {
  const episodes = await getEpisodes(fetch, platform);
  const staticUrls = pages.map((path) => `<url><loc>https://phases.fm${path === '/' ? '' : path}</loc></url>`);
  const episodeUrls = episodes.map((episode) => (
    `<url><loc>https://phases.fm/episodes/${episodeSlug(episode)}</loc><lastmod>${episode.date.slice(0, 10)}</lastmod></url>`
  ));
  const urls = [...staticUrls, ...episodeUrls].join('');

  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=900, stale-while-revalidate=86400'
    }
  });
};
