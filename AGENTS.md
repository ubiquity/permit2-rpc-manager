## Project Overview

This is a monorepo for the Permit2 RPC ecosystem that provides an intelligent, CORS-friendly proxy for EVM-compatible JSON-RPC requests. The service automatically selects the fastest, valid RPC endpoint from a curated whitelist for each incoming request.

## Key Commands

### Development

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
- Uses Deno KV for persistent storage in production

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
- Located in `packages/permit2-rpc-server/src/deno-server.ts`

## Deployment

- **Production**: Automatically deployed to Deno Deploy via GitHub Actions on push to main
- **Preview**: Pull requests trigger preview deployments
- **Whitelist Updates**: Automated weekly updates via GitHub Actions workflow
- **Manual Deploy**: Use `bun run deploy:manual` from root

## Monitoring & Logs

### Viewing Deno Deploy Logs

Use the `deployctl` CLI to access production logs:

```bash
# View live logs
deployctl logs --project=permit2-rpc-proxy

# View logs from the last hour
deployctl logs --project=permit2-rpc-proxy --since="$(date -Iseconds -v-1H)" --limit=100

# Filter logs by error level
deployctl logs --project=permit2-rpc-proxy --levels=error,warn

# Search for specific terms
deployctl logs --project=permit2-rpc-proxy --grep="failed" --grep="error"
```

Note: The Deno Deploy token should be available in environment as `DENO_DEPLOY_TOKEN`. Logs older than 24 hours are not available.

## Testing Approach

- Server tests use Deno's built-in test runner
- Client tests use Bun's test runner
- Performance testing via Puppeteer (`scripts/perf-test.mjs`)
- Whitelist validation via `scripts/test-whitelist.mjs`

## Critical Files

- `packages/permit2-rpc-server/rpc-whitelist.json` - Curated list of RPC endpoints
- `packages/permit2-rpc-server/src/deno-server.ts` - Main server entry point
- `packages/permit2-rpc-client/src/index.ts` - Client SDK entry point
- `.github/workflows/update-whitelist.yml` - Automated whitelist updates
- `.github/workflows/deno-deploy.yml` - Deployment pipeline
