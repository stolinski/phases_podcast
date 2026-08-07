<script lang="ts">
  import CourtneyPage from './CourtneyPage.svelte';
  import HomePage from './HomePage.svelte';

  const isCourtneyPage = window.location.pathname.replace(/\/$/, '') === '/courtney';
</script>

{#if isCourtneyPage}
  <CourtneyPage />
{:else}
  <HomePage />
{/if}
