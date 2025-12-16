# Permit2 RPC Server Package

This package contains the Deno Deploy service code for the Permit2 RPC Proxy.

Refer to the [root README.md](../../README.md) for overall project information
and core features.

## Quick Start

```bash
cd packages/permit2-rpc-server
deno task dev
```

- HTTP JSON-RPC: `POST http://127.0.0.1:8000/1`
- WS JSON-RPC: connect to `ws://127.0.0.1:8000/1`
- Live UI: open `http://127.0.0.1:8000/` (streams `pending_sample`)

## API Endpoint

The service exposes the following endpoint:

`POST /{chainId}`

- Replace `{chainId}` with the desired EVM chain ID.
- The request body should be a standard JSON-RPC 2.0 request object or an array of request objects (for batching).
- The response will be a JSON-RPC 2.0 response object or an array of response objects.

## WebSocket (ws/wss)

The server also accepts JSON-RPC over WebSocket at:

- `ws(s)://<host>/{chainId}` (defaults to chain `1` if omitted)

This is a proxy to an upstream WS RPC endpoint. Upstream selection is automatic
and isolated from HTTP selection:

- Uses `rpc-whitelist.json` `wss[{chainId}]` if present (otherwise derives
  candidates from `rpcs[{chainId}]` by swapping schemes, e.g. `https://…` →
  `wss://…`).
- Runs WS latency + Permit2 bytecode checks and caches results under a separate
  Deno KV key (`permit2RpcManagerWsCache`) so there’s no overlap with the HTTP
  cache (`permit2RpcManagerCache`).

You can override/force a specific upstream via environment variables:

- `ETH_WSS_URL` (chain `1` shortcut)
- `RPC_WSS_URL` (default for any chain)
- `RPC_WSS_URL_<chainId>` (per-chain override, e.g. `RPC_WSS_URL_1`)

These variables control which upstream WS endpoint the **server** proxies to;
clients still connect to `ws(s)://<host>/{chainId}`.

Overrides are tried first and fall back to the whitelist selector if they fail.

For mempool-style subscriptions (`newPendingTransactions`), providers vary widely. The weekly whitelist update workflow
now validates mainnet WS candidates by requiring they actually emit pending-tx events, so you typically shouldn’t need an
override. If you want to force/debug a specific upstream anyway:

```bash
RPC_WSS_URL_1=wss://<upstream-ws-endpoint> deno task dev
```

The root UI supports a few query params for quick tweaking:

- `/?chainId=1` (default `1`)
- `/?interval=1000` (ms)
- `/?sampleRate=0.02`
- `/?maxSamples=5`
- `/?maxInflight=10`
- `/?autostart=0` (disable auto-start)

## Development

Use Deno tasks defined in `deno.jsonc`:

- `deno task start`: Run the server.
- `deno task dev`: Run the server with file watching.
- `deno task lint`: Lint the code.
- `deno task fmt`: Format the code.
- `deno task test`: Run tests (requires tests to be added/adapted).
- `deno task mempool:preview`: Preview candidate mempool stream payloads (defaults to `ws://127.0.0.1:8000/1`; use `--rpc http://...` for HTTP polling with pending-block fallback).

Example:

```bash
cd packages/permit2-rpc-server
deno task start
deno task mempool:preview --preset pending-sample --format pretty --max-events 10
deno task mempool:preview --rpc http://127.0.0.1:8000/1 --preset pending-counts --max-events 5
```

## Deployment

Deployment is handled automatically via the GitHub Actions workflow defined in
the repository root (`.github/workflows/deno-deploy.yml`).

## Configuration

- The RPC whitelist is managed by `rpc-whitelist.json` in this directory. Use
  root-level scripts (`bun run whitelist:update`, `bun run whitelist:test`) to
  manage it.
- Deno Deploy environment variables can be used if needed (e.g., for CORS origin
  restriction, API keys if implemented).
