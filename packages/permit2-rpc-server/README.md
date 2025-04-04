# Permit2 RPC Server Package

This package contains the Deno Deploy service code for the Permit2 RPC Proxy.

Refer to the [root README.md](../../README.md) for overall project information
and core features.

## API Endpoint

The service exposes the following endpoint:

`POST /{chainId}`

-   Replace `{chainId}` with the desired EVM chain ID.
-   The request body should be a standard JSON-RPC 2.0 request object or an array of request objects (for batching).
-   The response will be a JSON-RPC 2.0 response object or an array of response objects.

## Development

Use Deno tasks defined in `deno.jsonc`:

- `deno task start`: Run the server.
- `deno task dev`: Run the server with file watching.
- `deno task lint`: Lint the code.
- `deno task fmt`: Format the code.
- `deno task test`: Run tests (requires tests to be added/adapted).

## Deployment

Deployment is handled automatically via the GitHub Actions workflow defined in
the repository root (`.github/workflows/deno-deploy.yml`).

## Configuration

- The RPC whitelist is managed by `rpc-whitelist.json` in this directory. Use
  root-level scripts (`bun run whitelist:update`, `bun run whitelist:test`) to
  manage it.
- Deno Deploy environment variables can be used if needed (e.g., for CORS origin
  restriction, API keys if implemented).
