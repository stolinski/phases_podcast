export type EpisodeNoteBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] };

export type Episode = {
  id: string;
  episode: number;
  title: string;
  description: string;
  notes: EpisodeNoteBlock[];
  date: string;
  audio: string;
  duration: number;
  share: string;
};

export function episodeSlug(episode: Pick<Episode, 'episode' | 'title'>): string {
  const title = episode.title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72)
    .replace(/-$/g, '');

  return `${episode.episode}-${title}`;
}
