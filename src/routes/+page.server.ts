import { error } from '@sveltejs/kit';
import type { EpisodeListing } from '$lib/episodes';
import { getEpisodes } from '$lib/server/podcast';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, platform, setHeaders }) => {
  try {
    const episodes: EpisodeListing[] = (await getEpisodes(fetch, platform)).map((episode) => ({
      episode: episode.episode,
      title: episode.title,
      description: episode.description,
      date: episode.date,
      audio: episode.audio,
      duration: episode.duration
    }));
    setHeaders({
      'cache-control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=86400'
    });
    return { episodes };
  } catch (cause) {
    console.error('Unable to load the podcast RSS feed', cause);
    error(503, 'Episodes are temporarily unavailable. Please try again soon.');
  }
};
