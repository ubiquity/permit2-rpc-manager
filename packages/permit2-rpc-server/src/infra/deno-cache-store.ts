/// <reference lib="deno.ns" />
import type { CacheData, CacheStore } from "./cache-manager.ts";

/** Retains the existing VPS Deno KV keys and structured value schema. */
export function createDenoCacheStore(): CacheStore {
  let kv: Deno.Kv | undefined;
  const open = async () => kv ??= await Deno.openKv();
  return {
    async load(key) {
      return (await (await open()).get<CacheData>([key])).value;
    },
    async save(key, value) {
      await (await open()).set([key], value);
    },
  };
}
