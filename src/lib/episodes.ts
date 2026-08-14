export type EpisodeNoteBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] };

export type EpisodeResource = {
  label: string;
  url: string;
};

export type Episode = {
  id: string;
  episode: number;
  title: string;
  description: string;
  notes: EpisodeNoteBlock[];
  resources: EpisodeResource[];
  date: string;
  audio: string;
  duration: number;
  share: string;
};

export type EpisodeReference = Pick<Episode, 'episode' | 'title'>;
export type EpisodeDetail = Omit<Episode, 'description'>;
export type EpisodeListing = Pick<
  Episode,
  'id' | 'episode' | 'title' | 'description' | 'date' | 'audio' | 'duration'
>;

export function episodeDescription(notes: EpisodeNoteBlock[]): string {
  return notes
    .flatMap((block) => block.type === 'paragraph' ? block.text : block.items)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
