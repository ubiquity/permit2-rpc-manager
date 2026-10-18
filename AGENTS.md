## Project Overview

This is a monorepo for the Permit2 RPC ecosystem that provides an intelligent, CORS-friendly proxy for EVM-compatible JSON-RPC requests. The service automatically selects the fastest, valid RPC endpoint from a curated whitelist for each incoming request.

## Key Commands

### Development

**Portable server and Workers candidate (root, Bun 1.4.0):**

```bash
bun install --frozen-lockfile --ignore-scripts
bun run dev:bun
bun run dev:worker
bun run deploy:types
bun run check:worker
bun run test:bun
bun run test:workers
bun run deploy:dry-run
```

Workers tests execute actual workerd with isolated native upstream services and SQLite Durable Objects; Node 24.20.0 or later is used only for Cloudflare tooling. The diagnostics suite inspects only isolated local storage. Read `docs/DECISIONS.md` before changing runtime, cache, free-tier budgets, or deployment ownership. The existing Deno VPS adapter remains supported.

**Server package (Deno):**

```bash
cd packages/permit2-rpc-server
deno task start        # Run the server locally
deno task dev          # Run with file watching
deno task lint         # Lint the code
deno task fmt          # Format the code
deno task test         # Run tests
```

**Client package:**

```bash
cd packages/permit2-rpc-client
bun run build          # Build the client SDK
bun run dev            # Build with watch mode
bun test               # Run tests
bun run format         # Format code
```

### Root-level maintenance

```bash
bun run whitelist:update  # Update server's RPC whitelist from chainlist
bun run whitelist:test    # Test all RPC endpoints in whitelist
bun run test:client:local # Test client against local server (port 8000)
bun run test:client:remote # Test client against deployed service
bun run perf:test         # Benchmark proxy performance
bun run deploy:manual     # Manually deploy to Deno Deploy
```

## Architecture

### Core Components

**Permit2RpcManager** (`packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`)

- Central orchestrator for all RPC requests
- Manages RPC health tracking with exponential backoff
- Handles error classification and retry logic
- Routes requests through RpcSelector

**RpcSelector** (`packages/permit2-rpc-server/src/core/rpc-selector.ts`)

- Selects optimal RPC endpoint based on latency tests
- Maintains ranked list of usable RPCs per chain

**LatencyTester** (`packages/permit2-rpc-server/src/infra/latency-tester.ts`)

- Tests RPC endpoints for responsiveness
- Validates endpoints support required methods (eth_syncing, eth_getCode)
- Checks for Permit2 contract presence

**CacheManager** (`packages/permit2-rpc-server/src/infra/cache-manager.ts`)

- Handles caching of RPC test results and responses
- Uses the explicit Deno KV adapter on the VPS, in-memory storage for Bun local development, private advisory SQLite HTTP diagnostics on Workers, and separate version-scoped Cache API WebSocket diagnostics

**ChainlistDataSource** (`packages/permit2-rpc-server/src/data/chainlist-data-source.ts`)

- Loads and manages RPC whitelist data from `rpc-whitelist.json`
- Provides RPC URLs for each supported chain

### Request Flow

1. Client sends JSON-RPC request to `/{chainId}` endpoint
2. Server validates request and extracts chain ID
3. Permit2RpcManager checks cache for recent valid response
4. If not cached, RpcSelector picks best available RPC
5. Request forwarded to selected RPC with retry logic
6. Response cached and returned to client with CORS headers

### Error Handling

The system classifies errors into behaviors:

- `RETRY_WITH_BACKOFF`: Rate limits, timeouts (exponential backoff)
- `RETRY_DIFFERENT_RPC`: Provider-specific issues (try another RPC)
- `DO_NOT_RETRY`: Client errors like invalid params
- `BLOCKCHAIN_ERROR`: Execution reverts, insufficient funds

### MCP Integration

The server implements Model Context Protocol (MCP) compliance:

- Exposes Ethereum JSON-RPC methods as MCP tools
- Handles both standard JSON-RPC and MCP-formatted requests
- Portable dispatch is in `packages/permit2-rpc-server/src/server.ts`

## Deployment

- **Production**: `rpc.ubq.fi` remains on the unchanged VPS service
- **Workers candidate**: `.github/workflows/workers-deploy.yml` checks PRs and deploys `uos-rpc-candidate` from main with no canonical routes or cron
- **Legacy Deno recovery**: `.github/workflows/deno-deploy.yml` is manual-only
- **Whitelist Updates**: Automated weekly updates via GitHub Actions workflow
- **Manual Deploy**: Use `bun run deploy:manual` from root

## Monitoring & Logs

### Viewing Deno Deploy Logs

Use the Deno 2 CLI to access the retained recovery application's logs; these are not VPS production logs:

```bash
# View live logs
deno deploy logs --org=ubiquity-dao --app=rpc-ubq-fi

# Capture recent logs and exit
deno deploy logs --org=ubiquity-dao --app=rpc-ubq-fi --once

# Search for specific terms
deno deploy logs --org=ubiquity-dao --app=rpc-ubq-fi --once | rg -i "failed|error"
```

The Deno Deploy token should be available in the environment as `DENO_DEPLOY_TOKEN`.

## Testing Approach

- Server tests use Deno's built-in test runner
- The server delivery gate is `deno task build`, `deno task test`, `deno lint`, and `deno fmt --check` from `packages/permit2-rpc-server`, plus the root Worker/Bun commands above
- Root `bun run test` invokes live remote client tests; it is not the portable server gate
- Client tests use Bun's test runner
- Performance testing via Puppeteer (`scripts/perf-test.mjs`)
- Whitelist validation via `scripts/test-whitelist.mjs`

## Critical Files

- `packages/permit2-rpc-server/rpc-whitelist.json` - Curated list of RPC endpoints
- `packages/permit2-rpc-server/src/deno-server.ts` - Main server entry point
- `packages/permit2-rpc-client/src/index.ts` - Client SDK entry point
- `.github/workflows/update-whitelist.yml` - Automated whitelist updates
- `.github/workflows/deno-deploy.yml` - Deployment pipeline

## VPS hosting (2026-10-12)

`rpc.ubq.fi` runs on the VPS, not Deno Deploy: `deploy/ubiquity-rpc.service`
runs `packages/permit2-rpc-server/src/deno-server.ts` on 127.0.0.1:8020 and
Caddy terminates TLS for `rpc.ubq.fi` (DNS-only A record, no Deno hop). HTTP,
websockets, and the same-origin `/rpc/:chainId` router path are verified. Deno
Deploy shuts down in April 2027, so the Deno app `rpc-ubq-fi` is no longer the
production target.
