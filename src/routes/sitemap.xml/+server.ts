import type { RequestHandler } from './$types';

const pages = ['/', '/courtney', '/questions'];

export const GET: RequestHandler = () => {
  const urls = pages
    .map((path) => `<url><loc>https://phases.fm${path === '/' ? '' : path}</loc></url>`)
    .join('');

  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600'
    }
  });
};
