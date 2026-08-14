<script lang="ts">
  import EpisodePage from '../../../EpisodePage.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<EpisodePage episode={data.episode} newerEpisode={data.newerEpisode} olderEpisode={data.olderEpisode} />
