<script lang="ts">
  import HomePage from '../HomePage.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<HomePage episodes={data.episodes} />
