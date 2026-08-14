import { error, redirect } from '@sveltejs/kit';
import { episodeSlug, type Episode, type EpisodeReference } from '$lib/episodes';
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
    newerEpisode: episodeReference(episodes[episodeIndex - 1]),
    olderEpisode: episodeReference(episodes[episodeIndex + 1])
  };
};

function episodeReference(episode: Episode | undefined): EpisodeReference | undefined {
  if (!episode) return undefined;
  return { episode: episode.episode, title: episode.title };
}
