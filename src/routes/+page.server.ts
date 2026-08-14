import { error } from '@sveltejs/kit';
import { getEpisodes } from '$lib/server/podcast';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, platform, setHeaders }) => {
  try {
    const episodes = await getEpisodes(fetch, platform);
    setHeaders({
      'cache-control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=86400'
    });
    return { episodes };
  } catch (cause) {
    console.error('Unable to load the podcast RSS feed', cause);
    error(503, 'Episodes are temporarily unavailable. Please try again soon.');
  }
};
