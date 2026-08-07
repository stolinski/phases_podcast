/// <reference types="vite/client" />

declare namespace svelteHTML {
  interface IntrinsicElements {
    [name: `media-${string}`]: Record<string, unknown>;
  }
}
