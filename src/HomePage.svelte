<script lang="ts">
  import { resolve } from '$app/paths';
  import { onMount, tick } from 'svelte';
  import type { Episode } from './lib/episodes';

  let { episodes }: { episodes: Episode[] } = $props();
  let query = $state('');
  let selected = $derived(episodes[0]);
  let isPlaying = $state(false);
  let audioElement!: HTMLAudioElement;
  let filteredEpisodes = $derived(
    episodes.filter((episode) =>
      `${episode.title} ${episode.description}`.toLowerCase().includes(query.trim().toLowerCase())
    )
  );

  onMount(() => {
    void import('media-chrome');
  });

  const platforms = [
    { name: 'Apple Podcasts', icon: '/icons/applepodcasts.svg', href: 'https://podcasts.apple.com/podcast/phases-a-parenting-podcast-with-dr-courtney/id1879900591' },
    { name: 'Spotify', icon: '/icons/spotify.svg', href: 'https://open.spotify.com/show/0K4GkKLtEQHfDvxHcCUmnU' },
    { name: 'YouTube', icon: '/icons/youtube.svg', href: 'https://www.youtube.com/@phasesfm' },
    { name: 'YouTube Music', icon: '/icons/youtubemusic.svg', href: 'https://music.youtube.com/channel/UCKC_qfYDUsiRej_-dGHIT2A' },
    { name: 'Pocket Casts', icon: '/icons/pocketcasts.svg', href: 'https://pca.st/itunes/1879900591' },
    { name: 'Overcast', icon: '/icons/overcast.svg', href: 'https://overcast.fm/itunes1879900591' },
    { name: 'Amazon Music', icon: '/icons/amazon-music.png', href: 'https://music.amazon.com/podcasts/371b3aac-1fb4-4749-b62e-409e5c43cfa5' },
    { name: 'RSS feed', icon: '/icons/rss.svg', href: 'https://feeds.transistor.fm/phases-a-parenting-podcast-with-dr-courtney' }
  ];

  function formatDate(date: string) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(date));
  }

  function formatDuration(seconds: number) {
    return `${Math.floor(seconds / 60)} min`;
  }

  async function playEpisode(episode: Episode) {
    const isNewEpisode = episode.id !== selected.id;
    selected = episode;
    await tick();
    if (isNewEpisode) audioElement.load();
    await audioElement.play().catch(() => undefined);
  }
</script>

<svelte:head>
  <meta property="og:title" content="Phases — A Parenting Podcast" />
  <meta property="og:description" content="Research-backed parenting conversations with Dr. Courtney Tolinski and Scott Tolinski." />
  <meta property="og:image" content="https://phases.fm/artwork.jpg" />
</svelte:head>

<header class="site-header">
  <a class="wordmark" href="#top" aria-label="Phases home">phases<span>.fm</span></a>
  <nav aria-label="Primary navigation">
    <a href="#episodes">Episodes</a>
    <a href={resolve('/courtney')}>Courtney</a>
    <a href={resolve('/questions')}>Ask a question</a>
    <a class="nav-cta" href="#subscribe">Listen now</a>
  </nav>
</header>

<main id="top">
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-copy">
      <p class="eyebrow">A parenting podcast with Dr. Courtney</p>
      <h1 id="hero-title">Growing up happens in <em>phases.</em></h1>
      <p class="hero-intro">Clear, compassionate conversations about raising kids—and becoming the people we want to be alongside them.</p>
      <div class="hero-actions">
        <button class="primary-button" onclick={() => playEpisode(episodes[0])}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z" fill="currentColor" /></svg>
          Play latest episode
        </button>
        <a class="text-link" href="#subscribe">Follow the show <span aria-hidden="true">↗</span></a>
      </div>
      <p class="host-note">Hosted by <strong>Dr. Courtney Tolinski</strong> &amp; <strong>Scott Tolinski</strong></p>
    </div>

    <div class="artwork-wrap" aria-label="Phases podcast cover artwork">
      <div class="phase-ring phase-ring-one"></div>
      <div class="phase-ring phase-ring-two"></div>
      <img src="/artwork.jpg" alt="Phases, a parenting podcast" width="1400" height="1400" />
    </div>
  </section>

  <section class="player-panel" id="player" aria-labelledby="now-playing-title">
    <div class="player-heading">
      <div class="now-playing" aria-live="polite">
        <img src="/artwork.jpg" alt="" width="88" height="88" />
        <div>
          <p>Now playing · Episode {selected.episode}</p>
          <h2 id="now-playing-title">{selected.title}</h2>
        </div>
      </div>
      <a class="player-notes" href={selected.share} target="_blank" rel="noreferrer">Episode notes <span aria-hidden="true">↗</span></a>
    </div>

    <media-controller audio class="media-player">
      <audio bind:this={audioElement} slot="media" src={selected.audio} preload="metadata" onplay={() => isPlaying = true} onpause={() => isPlaying = false} onended={() => isPlaying = false}></audio>
      <media-control-bar>
        <media-seek-backward-button seek-offset="15" aria-label="Go back 15 seconds"></media-seek-backward-button>
        <media-play-button aria-label="Play or pause"></media-play-button>
        <media-seek-forward-button seek-offset="30" aria-label="Go forward 30 seconds"></media-seek-forward-button>
        <media-time-display></media-time-display>
        <media-time-range></media-time-range>
        <media-duration-display></media-duration-display>
        <media-playback-rate-button rates="1 1.25 1.5 1.75 2"></media-playback-rate-button>
        <media-mute-button aria-label="Mute"></media-mute-button>
      </media-control-bar>
    </media-controller>
  </section>

  <section class="subscribe" id="subscribe" aria-labelledby="subscribe-title">
    <div>
      <p class="eyebrow">Never miss a phase</p>
      <h2 id="subscribe-title">Listen wherever you get your podcasts.</h2>
    </div>
    <ul class="platforms">
      {#each platforms as platform (platform.name)}
        <li>
          <a href={platform.href} target="_blank" rel="noreferrer" aria-label={`Listen on ${platform.name}`}>
            <img src={platform.icon} alt="" width="32" height="32" />
            <span><small>Listen on</small>{platform.name}</span>
            <span class="platform-arrow" aria-hidden="true">↗</span>
          </a>
        </li>
      {/each}
    </ul>
  </section>

  <section class="episodes-section" id="episodes" aria-labelledby="episodes-title">
    <header class="section-heading">
      <div>
        <p class="eyebrow">The full collection</p>
        <h2 id="episodes-title">Every episode, for every phase.</h2>
      </div>
      <label class="search-field">
        <span class="sr-only">Search episodes</span>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4 4"></path></svg>
        <input type="search" bind:value={query} placeholder="Search episodes" />
      </label>
    </header>

    {#if filteredEpisodes.length}
      <ol class="episode-list">
        {#each filteredEpisodes as episode (episode.id)}
          <li class:active={episode.id === selected.id}>
            <button class="episode-play" onclick={() => playEpisode(episode)} aria-label={`Play ${episode.title}`}>
              {#if episode.id === selected.id && isPlaying}
                <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="7" y="6" width="3.5" height="12" rx="1"></rect><rect x="13.5" y="6" width="3.5" height="12" rx="1"></rect></svg>
              {:else}
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z" fill="currentColor"></path></svg>
              {/if}
            </button>
            <article>
              <div class="episode-meta"><span>Episode {episode.episode}</span><time datetime={episode.date}>{formatDate(episode.date)}</time><span>{formatDuration(episode.duration)}</span></div>
              <h3><button onclick={() => playEpisode(episode)}>{episode.title}</button></h3>
              <p>{episode.description}</p>
              <a href={episode.share} target="_blank" rel="noreferrer">Episode notes <span aria-hidden="true">↗</span></a>
            </article>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="empty-state">No episodes found. Try a different search.</p>
    {/if}
  </section>

  <section class="about-newsletter" id="about">
    <article class="about-card">
      <p class="eyebrow">Meet your hosts</p>
      <h2>Science-backed. Real-life tested.</h2>
      <p>Dr. Courtney Tolinski is a licensed clinical and school psychologist. Her husband Scott is a professional question-asker and fellow parent. Together, they make the science and psychology of parenting and human development useful, honest, and fun.</p>
      <a class="about-link" href={resolve('/courtney')}>Meet Dr. Courtney <span aria-hidden="true">→</span></a>
      <p class="signature">Courtney &amp; Scott</p>
    </article>

    <aside class="newsletter" aria-labelledby="newsletter-title">
      <div class="newsletter-orbit" aria-hidden="true"></div>
      <p class="eyebrow">Free parent resource</p>
      <h2 id="newsletter-title">Get the Neurodivergent Back-to-School Toolkit.</h2>
      <p>Join the Phases newsletter and we'll send the free toolkit straight to your inbox—plus new episodes and practical ideas for the phase you're in.</p>
      <form action="https://app.kit.com/forms/9773999/subscriptions" class="seva-form formkit-form" method="post" data-sv-form="9773999" data-uid="135096e448" data-format="inline" data-version="5">
        <ul class="formkit-alert formkit-alert-error" data-element="errors" data-group="alert"></ul>
        <div data-element="fields" class="formkit-fields">
          <label class="formkit-field">
            <span class="sr-only">Email address</span>
            <input class="formkit-input" name="email_address" aria-label="Email address" placeholder="you@example.com" required type="email" />
          </label>
          <button data-element="submit" class="formkit-submit" type="submit"><span>Send me the toolkit</span></button>
        </div>
        <p class="formkit-guarantee">No spam. Unsubscribe anytime.</p>
      </form>
    </aside>
  </section>
</main>

<footer>
  <a class="wordmark" href="#top">phases<span>.fm</span></a>
  <p>Parenting changes. You don't have to figure it out alone.</p>
  <div>
    <a href={resolve('/courtney')}>Courtney</a>
    <a href={resolve('/questions')}>Questions</a>
    <a href="https://www.youtube.com/@phasesfm" target="_blank" rel="noreferrer">YouTube</a>
    <a href="https://feeds.transistor.fm/phases-a-parenting-podcast-with-dr-courtney" target="_blank" rel="noreferrer">RSS</a>
  </div>
  <small>© {new Date().getFullYear()} Phases</small>
</footer>
