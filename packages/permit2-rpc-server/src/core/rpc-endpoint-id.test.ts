import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { getRpcEndpointId, redactRpcDiagnostic } from "./rpc-endpoint-id.ts";

Deno.test("RPC endpoint diagnostics are stable and redact nested URL values", () => {
  const endpoint = "https://user:secret@rpc.example/private?token=token-value";
  const endpointId = getRpcEndpointId(endpoint);
  const diagnostic = redactRpcDiagnostic({
    message: `failed ${endpoint}`,
    nested: [endpoint, { url: endpoint }],
  });

  assertEquals(getRpcEndpointId(endpoint), endpointId);
  assertMatch(endpointId, /^rpc-[0-9a-f]{16}$/);
  assertEquals(JSON.stringify(diagnostic).includes("secret"), false);
  assertEquals(JSON.stringify(diagnostic).includes("rpc.example"), false);
  assertEquals(JSON.stringify(diagnostic).includes(endpointId), true);
});
