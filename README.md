# Permit2 RPC Manager - Monorepo

This repository contains the code for the Permit2 RPC ecosystem, managed as a
monorepo.

The canonical production endpoint is `https://rpc.ubq.fi`. JSON-RPC, MCP, and
client SDK APIs are served from that endpoint without a compatibility URL.

## Packages

This monorepo includes the following packages:

- **`packages/permit2-rpc-server`**: A Deno Deploy service that acts as an
  intelligent, CORS-friendly proxy for EVM-compatible JSON-RPC requests. It
  automatically selects the fastest, valid RPC endpoint from a curated whitelist
  for each incoming request, handling fallback and caching internally. See the
  [server package README](./packages/permit2-rpc-server/README.md) for details
  on deployment and usage.
- **`packages/permit2-rpc-client`**: A lightweight TypeScript client SDK for
  easily interacting with the deployed `permit2-rpc-server` service from
  frontend applications or other JavaScript/TypeScript environments. See the
  [client package README](./packages/permit2-rpc-client/README.md) for
  installation and usage instructions.

## Core Features (Provided by the Server)

- **Automatic RPC Selection:** Dynamically tests whitelisted RPCs for latency,
  sync status (`eth_syncing`), and specific contract bytecode (Permit2 via
  `eth_getCode`) to find the best endpoint.
- **Robust Fallback:** Automatically iterates through ranked usable RPCs if the
  initial attempt fails.
- **Caching:** Uses Deno KV for server-side caching of test results.
- **CORS Enabled:** Handles CORS preflight requests and headers, allowing direct
  browser access.
- **Batch Request Support:** Accepts arrays of JSON-RPC requests for efficient
  data fetching.
- **WebSocket JSON-RPC (ws/wss):** WebSocket proxy support at `ws://<host>/{chainId}` with separate WS selection + caching (no overlap with HTTP); WS endpoints are validated and written under `wss` in `packages/permit2-rpc-server/rpc-whitelist.json` by the weekly whitelist workflow.
- **Live Mempool Preview UI:** Visit `GET /` to see a `pending_sample` stream (uses WS when available, with HTTP fallback).

## CI/CD & Automation

This repository uses GitHub Actions for automated deployment and maintenance:

- **Whitelist Updates (`update-whitelist.yml`):**

  - Runs automatically every Sunday at midnight UTC
  - Can be manually triggered with optional force update
  - Tests RPC endpoints for each critical chain
  - Auto-commits changes if whitelist is updated
  - Triggers deployment workflow after successful updates

- **Deployment (`deno-deploy.yml`):**
  - Deploys server to Deno Deploy platform
  - Triggered by:
    - Pushes to main branch
    - Pull requests (preview deployments)
    - Successful whitelist updates (via workflow dispatch)
  - Runs the Deno 2 dependency install, server build, and server test suite
  - Probes the deployed root, static assets, and `/health`

## Development

This repository uses `bun` for managing root-level scripts and potentially
workspaces in the future.

### Scripts

The `scripts/` directory contains helper scripts for project maintenance and testing:

- **merge-whitelists.mjs**: Merges multiple per-chain whitelist JSON files from an artifacts directory into a single `rpc-whitelist.json` for the server. Usage:
  `bun run scripts/merge-whitelists.mjs [artifactsDir] [outputPath]`
- **perf-test.mjs**: Benchmarks the latency and reliability of the Permit2 RPC proxy versus direct RPC calls using Puppeteer. Useful for performance regression testing and validation.
- **manual-deploy.sh**: Manually deploys the server package to Deno Deploy.
- **update-whitelist.mjs**: Updates the server's whitelist file from generated chainlist data.
- **test-whitelist.mjs**: Tests connectivity and validity of all RPC endpoints in the whitelist.

Other common tasks:

- **Update Whitelist Source Data:** `bun run submodule:update` (Updates
  `lib/chainlist`)
- **Generate Whitelist JSON:** `bun run chainlist:generate` (Generates JSON in
  `lib/chainlist`)
- **Update Server Whitelist:** `bun run whitelist:update` (Runs `chainlist:generate`, then tests endpoints and writes `packages/permit2-rpc-server/rpc-whitelist.json`)
- **Test Whitelist Connectivity:** `bun run whitelist:test` (Tests URLs in the
  server package's whitelist)
- **Format Root:** `bun run format:root` (Formats root-level files with
  Prettier)

Development, building, testing, and running specific packages should be done
within their respective directories (`packages/permit2-rpc-server` or
`packages/permit2-rpc-client`). Refer to the README file within each package for
specific commands (e.g., `deno task start` for the server, `bun run build` for
the client).
