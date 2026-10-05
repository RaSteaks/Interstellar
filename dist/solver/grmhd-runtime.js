"use strict";

/*
 * The worker owns the instance, but this loader is kept as a separate static
 * resource so a server with an incorrect Wasm MIME type can still recover by
 * fetching bytes and calling WebAssembly.instantiate directly.
 */
(() => {
  async function instantiate(url) {
    const response = await fetch(url, {cache: "force-cache"});
    if (!response.ok) throw new Error(`Wasm request failed (${response.status})`);
    const fallback = response.clone();
    if (WebAssembly.instantiateStreaming) {
      try {
        return await WebAssembly.instantiateStreaming(response, {});
      } catch {
        /* A text/plain or application/octet-stream MIME type reaches this path. */
      }
    }
    return WebAssembly.instantiate(await fallback.arrayBuffer(), {});
  }
  globalThis.InterstellarGrmhdWasmLoader = Object.freeze({instantiate});
})();
