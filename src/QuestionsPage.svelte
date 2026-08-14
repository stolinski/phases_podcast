<script lang="ts">
  import { resolve } from '$app/paths';

  const formUrl = 'https://docs.google.com/forms/d/e/1FAIpQLSdoDg_K7zlYbv8Rxx4P9bL9B1dcr09ehCIzzVyfc9zbRj1m_Q/viewform';
  const pageSchema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ContactPage',
        '@id': 'https://phases.fm/questions#page',
        name: 'Ask Dr. Courtney',
        url: 'https://phases.fm/questions',
        description: 'Submit a parenting, child development, learning, or neurodiversity question for a future episode of Phases.',
        isPartOf: { '@id': 'https://phases.fm/#website' },
        about: { '@id': 'https://phases.fm/#podcast' }
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Phases', item: 'https://phases.fm' },
          { '@type': 'ListItem', position: 2, name: 'Ask Dr. Courtney', item: 'https://phases.fm/questions' }
        ]
      }
    ]
  };

  function preventFormFocusScroll(event: Event) {
    const frame = event.currentTarget as HTMLIFrameElement;
    if (document.activeElement === frame && !window.location.hash) {
      frame.blur();
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }
</script>

<svelte:head>
  <title>Ask Dr. Courtney Your Parenting Question — Phases</title>
  <meta name="description" content="Ask psychologist Dr. Courtney Tolinski your question about parenting, child development, learning, or neurodiversity for a future Phases episode." />
  <link rel="canonical" href="https://phases.fm/questions" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://phases.fm/questions" />
  <meta property="og:title" content="Ask Dr. Courtney Your Parenting Question — Phases" />
  <meta property="og:description" content="Send Dr. Courtney your parenting and child development questions for a future episode of Phases." />
  <meta property="og:image" content="https://phases.fm/artwork.jpg" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Ask Dr. Courtney Your Parenting Question — Phases" />
  <meta name="twitter:description" content="Send Dr. Courtney your parenting or child development question for a future episode." />
  <meta name="twitter:image" content="https://phases.fm/artwork.jpg" />
  {@html '<script type="application/ld+json">' + JSON.stringify(pageSchema).replace(/</g, '\\u003c') + '</' + 'script>'}
</svelte:head>

<header class="site-header questions-header">
  <a class="wordmark" href={resolve('/')} aria-label="Phases home">phases<span>.fm</span></a>
  <nav aria-label="Primary navigation">
    <a href={resolve('/')}>Home</a>
    <a href={resolve('/#episodes')}>Episodes</a>
    <a class="nav-cta" href={resolve('/#subscribe')}>Listen now</a>
  </nav>
</header>

<main class="questions-main">
  <header class="questions-intro">
    <a class="back-link" href={resolve('/')}><span aria-hidden="true">←</span> Back to Phases</a>
    <p class="eyebrow">Send us your question</p>
    <h1><span>Ask Dr.</span> <span>Courtney.</span></h1>
    <p>Have a question about parenting, child development, learning, or neurodiversity? Send it our way and we may answer it on a future episode of Phases.</p>
  </header>

  <section class="question-form" aria-labelledby="question-form-title">
    <h2 class="sr-only" id="question-form-title">Question submission form</h2>
    <iframe
      src={`${formUrl}?embedded=true`}
      title="Ask Dr. Courtney a question"
      onload={preventFormFocusScroll}
      width="640"
      height="629"
    >Loading…</iframe>
    <p>Having trouble with the embedded form? <a href={formUrl} target="_blank" rel="noreferrer">Open it in a new tab <span aria-hidden="true">↗</span></a></p>
  </section>
</main>

<footer>
  <a class="wordmark" href={resolve('/')}>phases<span>.fm</span></a>
  <p>Parenting changes. You don't have to figure it out alone.</p>
  <div>
    <a href={resolve('/#episodes')}>Episodes</a>
    <a href={resolve('/#subscribe')}>Newsletter</a>
  </div>
  <small>© {new Date().getFullYear()} Phases</small>
</footer>
