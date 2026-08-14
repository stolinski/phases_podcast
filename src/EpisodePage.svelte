<script lang="ts">
  import { resolve } from '$app/paths';
  import { episodeSlug, type Episode } from '$lib/episodes';

  let {
    episode,
    newerEpisode,
    olderEpisode
  }: {
    episode: Episode;
    newerEpisode?: Episode;
    olderEpisode?: Episode;
  } = $props();

  const slug = $derived(episodeSlug(episode));
  const canonicalUrl = $derived(`https://phases.fm/episodes/${slug}`);
  const pageTitle = $derived(truncate(`${episode.title} — Phases`, 65));
  const metaDescription = $derived(truncate(episode.description, 165));
  const schema = $derived({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'PodcastEpisode',
        '@id': `${canonicalUrl}#episode`,
        name: episode.title,
        url: canonicalUrl,
        description: episode.description,
        datePublished: episode.date,
        duration: isoDuration(episode.duration),
        episodeNumber: episode.episode,
        image: 'https://phases.fm/artwork.jpg',
        associatedMedia: {
          '@type': 'AudioObject',
          contentUrl: episode.audio,
          encodingFormat: 'audio/mpeg'
        },
        partOfSeries: { '@id': 'https://phases.fm/#podcast' },
        author: { '@id': 'https://phases.fm/courtney#person' },
        inLanguage: 'en-US'
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Phases', item: 'https://phases.fm' },
          { '@type': 'ListItem', position: 2, name: 'Episodes', item: 'https://phases.fm/#episodes' },
          { '@type': 'ListItem', position: 3, name: episode.title, item: canonicalUrl }
        ]
      }
    ]
  });

  function truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    const shortened = value.slice(0, maxLength - 1).replace(/\s+\S*$/, '').trimEnd();
    return `${shortened}…`;
  }

  function isoDuration(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `PT${minutes}M${remainingSeconds}S`;
  }

  function formatDate(date: string): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(new Date(date));
  }

  function formatDuration(seconds: number): string {
    return `${Math.floor(seconds / 60)} min`;
  }
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content={metaDescription} />
  <link rel="canonical" href={canonicalUrl} />
  <meta property="og:type" content="article" />
  <meta property="og:url" content={canonicalUrl} />
  <meta property="og:title" content={episode.title} />
  <meta property="og:description" content={metaDescription} />
  <meta property="og:image" content="https://phases.fm/artwork.jpg" />
  <meta property="article:published_time" content={episode.date} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={episode.title} />
  <meta name="twitter:description" content={metaDescription} />
  <meta name="twitter:image" content="https://phases.fm/artwork.jpg" />
  {@html '<script type="application/ld+json">' + JSON.stringify(schema).replace(/</g, '\\u003c') + '</' + 'script>'}
</svelte:head>

<header class="site-header episode-header">
  <a class="wordmark" href={resolve('/')} aria-label="Phases home">phases<span>.fm</span></a>
  <nav aria-label="Primary navigation">
    <a href={resolve('/')}>Home</a>
    <a href={resolve('/#episodes')}>All episodes</a>
    <a href={resolve('/courtney')}>Courtney</a>
    <a class="nav-cta" href={resolve('/#subscribe')}>Follow the show</a>
  </nav>
</header>

<main class="episode-main">
  <nav class="episode-breadcrumbs" aria-label="Breadcrumb">
    <a href={resolve('/')}>Phases</a>
    <span aria-hidden="true">/</span>
    <a href={resolve('/#episodes')}>Episodes</a>
    <span aria-hidden="true">/</span>
    <span>Episode {episode.episode}</span>
  </nav>

  <article class="episode-article">
    <header class="episode-hero">
      <div class="episode-copy">
        <p class="eyebrow">Episode {episode.episode} · Phases</p>
        <h1>{episode.title}</h1>
        <p class="episode-byline">
          Hosted by <a href={resolve('/courtney')}>Dr. Courtney Tolinski</a> and Scott Tolinski
        </p>
        <div class="episode-meta">
          <time datetime={episode.date}>{formatDate(episode.date)}</time>
          <span>{formatDuration(episode.duration)}</span>
        </div>
      </div>
      <img src="/artwork.jpg" alt="Phases parenting podcast cover" width="1400" height="1400" />
    </header>

    <section class="episode-player" aria-labelledby="listen-title">
      <h2 id="listen-title">Listen to this episode</h2>
      <audio controls preload="metadata" src={episode.audio}>
        <a href={episode.audio}>Download episode {episode.episode}</a>
      </audio>
    </section>

    <section class="episode-notes" aria-labelledby="notes-title">
      <p class="eyebrow">Episode summary</p>
      <h2 id="notes-title">What this conversation covers</h2>
      <div class="episode-note-body">
        {#each episode.notes as block (block)}
          {#if block.type === 'paragraph'}
            <p>{block.text}</p>
          {:else}
            <ul>
              {#each block.items as item (item)}
                <li>{item}</li>
              {/each}
            </ul>
          {/if}
        {/each}
      </div>
      <p class="episode-source">These notes come from the official Phases podcast feed. <a href={episode.share} target="_blank" rel="noreferrer">View the publisher’s original episode page <span aria-hidden="true">↗</span></a></p>
    </section>

    {#if episode.resources.length}
      <section class="episode-resources" aria-labelledby="resources-title">
        <p class="eyebrow">From the show notes</p>
        <h2 id="resources-title">Resources mentioned in this episode</h2>
        <p>These links come directly from the official episode notes. Retailer links may be affiliate links.</p>
        <ul>
          {#each episode.resources as resource (resource.url)}
            <li><a href={resource.url} target="_blank" rel="noreferrer">{resource.label} <span aria-hidden="true">↗</span></a></li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if newerEpisode || olderEpisode}
      <nav class="episode-pagination" aria-label="More Phases episodes">
        {#if newerEpisode}
          <a href={resolve('/episodes/[slug]', { slug: episodeSlug(newerEpisode) })}>
            <span>Newer episode</span>
            <strong>{newerEpisode.title}</strong>
          </a>
        {/if}
        {#if olderEpisode}
          <a href={resolve('/episodes/[slug]', { slug: episodeSlug(olderEpisode) })}>
            <span>Older episode</span>
            <strong>{olderEpisode.title}</strong>
          </a>
        {/if}
      </nav>
    {/if}

    <aside class="episode-about" aria-labelledby="about-phases-title">
      <div>
        <p class="eyebrow">About the show</p>
        <h2 id="about-phases-title">Parenting changes. You don’t have to figure it out alone.</h2>
      </div>
      <p>Phases is a parenting podcast where psychologist Dr. Courtney Tolinski and Scott Tolinski make research on child development, behavior, emotions, and family life useful in the phase you’re living through now.</p>
      <a class="text-link" href={resolve('/#episodes')}>Explore every episode <span aria-hidden="true">→</span></a>
    </aside>
  </article>
</main>

<footer>
  <a class="wordmark" href={resolve('/')}>phases<span>.fm</span></a>
  <p>Clear, compassionate conversations for every phase of family life.</p>
  <div>
    <a href={resolve('/#episodes')}>Episodes</a>
    <a href={resolve('/questions')}>Questions</a>
    <a href="https://feeds.transistor.fm/phases-a-parenting-podcast-with-dr-courtney" target="_blank" rel="noreferrer">RSS</a>
  </div>
  <small>© {new Date().getFullYear()} Phases</small>
</footer>
