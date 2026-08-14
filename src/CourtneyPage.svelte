<script lang="ts">
  import { resolve } from '$app/paths';

  const personSchema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Person',
        '@id': 'https://phases.fm/courtney#person',
        name: 'Dr. Courtney Tolinski',
        url: 'https://phases.fm/courtney',
        image: 'https://phases.fm/family.jpg',
        jobTitle: ['Licensed Psychologist', 'Nationally Certified School Psychologist', 'Podcast Host'],
        description: 'Licensed psychologist and nationally certified school psychologist with more than 15 years of experience across school, clinical, and community settings.',
        knowsAbout: ['child psychology', 'school psychology', 'child development', 'neurodiversity', 'parenting'],
        worksFor: { '@id': 'https://phases.fm/#organization' },
        hasCredential: [
          { '@type': 'EducationalOccupationalCredential', name: 'PhD' },
          { '@type': 'EducationalOccupationalCredential', name: 'Licensed Psychologist (LP)' },
          { '@type': 'EducationalOccupationalCredential', name: 'Nationally Certified School Psychologist (NCSP)' }
        ]
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Phases', item: 'https://phases.fm' },
          { '@type': 'ListItem', position: 2, name: 'Dr. Courtney Tolinski', item: 'https://phases.fm/courtney' }
        ]
      }
    ]
  };
</script>

<svelte:head>
  <title>Dr. Courtney Tolinski, Psychologist and Phases Host</title>
  <meta name="description" content="Meet Dr. Courtney Tolinski, a licensed psychologist and nationally certified school psychologist with 15+ years of experience supporting children and families." />
  <link rel="canonical" href="https://phases.fm/courtney" />
  <meta property="og:type" content="profile" />
  <meta property="og:url" content="https://phases.fm/courtney" />
  <meta property="og:title" content="Dr. Courtney Tolinski, Psychologist and Phases Host" />
  <meta property="og:description" content="Licensed psychologist, nationally certified school psychologist, mom of two, and co-host of Phases." />
  <meta property="og:image" content="https://phases.fm/family.jpg" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Dr. Courtney Tolinski, Psychologist and Phases Host" />
  <meta name="twitter:description" content="Meet the licensed psychologist and nationally certified school psychologist who co-hosts Phases." />
  <meta name="twitter:image" content="https://phases.fm/family.jpg" />
  {@html '<script type="application/ld+json">' + JSON.stringify(personSchema).replace(/</g, '\\u003c') + '</' + 'script>'}
</svelte:head>

<header class="site-header bio-header">
  <a class="wordmark" href={resolve('/')} aria-label="Phases home">phases<span>.fm</span></a>
  <nav aria-label="Primary navigation">
    <a href={resolve('/')}>Home</a>
    <a href={resolve('/#episodes')}>Episodes</a>
    <a href={resolve('/questions')}>Ask a question</a>
    <a class="nav-cta" href={resolve('/#subscribe')}>Listen now</a>
  </nav>
</header>

<main class="bio-main">
  <section class="courtney-hero" aria-labelledby="courtney-title">
    <div class="courtney-copy">
      <a class="back-link" href={resolve('/')}><span aria-hidden="true">←</span> Back to Phases</a>
      <p class="eyebrow">About your host</p>
      <h1 id="courtney-title">Dr. Courtney Tolinski</h1>
      <p class="courtney-lede">Licensed psychologist, nationally certified school psychologist, and mom of two.</p>
      <div class="courtney-bio">
        <p>Dr. Courtney Tolinski is a licensed psychologist, nationally certified school psychologist, and mom of two. She is passionate about helping individuals and families better understand their child’s learning and emotional needs through compassionate, neuroaffirming care.</p>
        <p>Dr. Tolinski brings more than 15 years of experience working across school, clinical, and community settings. For the past decade, she served as Director of the Learning Evaluation Center in Colorado, specializing in diagnostic assessment and practical recommendations that support long-term growth and success.</p>
        <p>She currently co-hosts the podcast Phases.FM with her husband, professional podcaster Scott Tolinski, where they share insights on child psychology and the everyday challenges and joys of parenting.</p>
      </div>
      <div class="courtney-actions">
        <a class="primary-button" href={resolve('/#episodes')}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z" fill="currentColor" /></svg>
          Listen to Phases
        </a>
        <a class="text-link" href={resolve('/questions')}>Ask Dr. Courtney a question <span aria-hidden="true">→</span></a>
      </div>
    </div>

    <figure class="courtney-photo">
      <div class="bio-ring bio-ring-one" aria-hidden="true"></div>
      <div class="bio-ring bio-ring-two" aria-hidden="true"></div>
      <img src="/family.jpg" alt="Dr. Courtney Tolinski with her family" width="1331" height="1331" />
      <figcaption>Dr. Courtney Tolinski · PhD, LP, NCSP</figcaption>
    </figure>
  </section>

  <section class="bio-values" aria-label="Courtney's experience">
    <article>
      <strong>15+</strong>
      <span>years across school, clinical, and community settings</span>
    </article>
    <article>
      <strong>10</strong>
      <span>years directing the Learning Evaluation Center</span>
    </article>
    <article>
      <strong>PhD · LP · NCSP</strong>
      <span>psychology and school psychology credentials</span>
    </article>
  </section>
</main>

<footer>
  <a class="wordmark" href={resolve('/')}>phases<span>.fm</span></a>
  <p>Parenting changes. You don't have to figure it out alone.</p>
  <div>
    <a href={resolve('/#episodes')}>Episodes</a>
    <a href={resolve('/questions')}>Questions</a>
    <a href={resolve('/#subscribe')}>Newsletter</a>
  </div>
  <small>© {new Date().getFullYear()} Phases</small>
</footer>
