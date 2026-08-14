/// <reference types="@cloudflare/workers-types" />

declare global {
  namespace App {
    interface Platform {
      caches: CacheStorage & { default: Cache };
      ctx: ExecutionContext;
    }
  }
}

export {};
