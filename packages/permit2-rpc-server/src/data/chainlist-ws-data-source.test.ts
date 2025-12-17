import { assertEquals } from "jsr:@std/assert@1";
import { ChainlistWsDataSource, type RpcWhitelist } from "./chainlist-ws-data-source.ts";

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = Deno.env.get(key);
  if (value === undefined) {
    Deno.env.delete(key);
  } else {
    Deno.env.set(key, value);
  }

  try {
    return fn();
  } finally {
    if (prev === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, prev);
    }
  }
}

Deno.test("ChainlistWsDataSource: prefers explicit WS URLs over derived", () => {
  const data: RpcWhitelist = {
    rpcs: {
      "1": ["https://mainnet.gateway.tenderly.co"],
    },
    wss: {
      "1": ["wss://eth.drpc.org"],
    },
  };

  const urls = withEnv("WS_DERIVE_FROM_HTTP", undefined, () => {
    const ds = new ChainlistWsDataSource(() => {}, data);
    return ds.getRpcUrls(1);
  });

  assertEquals(urls, ["wss://eth.drpc.org"]);
});

Deno.test("ChainlistWsDataSource: derives WS URLs when explicit list missing", () => {
  const data: RpcWhitelist = {
    rpcs: {
      "1": ["https://ethereum-rpc.publicnode.com"],
    },
    wss: {},
  };

  const urls = withEnv("WS_DERIVE_FROM_HTTP", undefined, () => {
    const ds = new ChainlistWsDataSource(() => {}, data);
    return ds.getRpcUrls(1);
  });

  assertEquals(urls, ["wss://ethereum-rpc.publicnode.com"]);
});

Deno.test("ChainlistWsDataSource: can force include derived WS URLs", () => {
  const data: RpcWhitelist = {
    rpcs: {
      "1": ["https://ethereum-rpc.publicnode.com"],
    },
    wss: {
      "1": ["wss://eth.drpc.org"],
    },
  };

  const urls = withEnv("WS_DERIVE_FROM_HTTP", "always", () => {
    const ds = new ChainlistWsDataSource(() => {}, data);
    return ds.getRpcUrls(1);
  });

  assertEquals(urls, ["wss://eth.drpc.org", "wss://ethereum-rpc.publicnode.com"]);
});

