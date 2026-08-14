import { error, redirect } from '@sveltejs/kit';
import { episodeSlug } from '$lib/episodes';
import { getEpisodes } from '$lib/server/podcast';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, platform, setHeaders }) => {
  const episodes = await getEpisodes(fetch, platform);
  const requestedNumber = Number(params.slug.match(/^(\d+)-/)?.[1]);
  const episode = episodes.find((candidate) => episodeSlug(candidate) === params.slug)
    ?? episodes.find((candidate) => candidate.episode === requestedNumber);

  if (!episode) error(404, 'Episode not found');

  const canonicalSlug = episodeSlug(episode);
  if (params.slug !== canonicalSlug) redirect(308, `/episodes/${canonicalSlug}`);

  const episodeIndex = episodes.findIndex((candidate) => candidate.id === episode.id);

  setHeaders({
    'cache-control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=86400'
  });

  return {
    episode,
    newerEpisode: episodes[episodeIndex - 1],
    olderEpisode: episodes[episodeIndex + 1]
  };
};
