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

Deno.test("RPC endpoint diagnostics redact complete bracketed IPv6 URLs", () => {
  const endpoint = "https://user:pass@[2001:db8::1]/rpc?token=[secret];scope=read";
  const endpointId = getRpcEndpointId(endpoint);

  assertEquals(redactRpcDiagnostic(`failed ${endpoint}`), `failed ${endpointId}`);
  assertEquals(redactRpcDiagnostic(`provider_${endpoint}`), `provider_${endpointId}`);
});

Deno.test("RPC endpoint diagnostics preserve trailing punctuation outside URL identifiers", () => {
  const endpoint = "https://user:pass@rpc.example/rpc?token=secret";
  const endpointId = getRpcEndpointId(endpoint);

  assertEquals(redactRpcDiagnostic(`failed (${endpoint}), then retried.`), `failed (${endpointId}), then retried.`);
});

Deno.test("RPC endpoint diagnostics redact URL-shaped object keys", () => {
  const endpoint = "https://user:pass@[2001:db8::1]/rpc?token=[secret];scope=read";
  const endpointId = getRpcEndpointId(endpoint);
  const diagnostic = redactRpcDiagnostic({
    [endpoint]: { endpoint },
    kind: "provider-error",
  });
  const serialized = JSON.stringify(diagnostic);
  const diagnosticRecord = diagnostic as Record<string, unknown>;

  assertEquals(Object.keys(diagnosticRecord).sort(), ["kind", endpointId].sort());
  assertEquals(serialized.includes("user:pass"), false);
  assertEquals(serialized.includes("2001:db8::1"), false);
  assertEquals(serialized.includes("secret"), false);
  assertEquals(serialized.includes("scope=read"), false);
  assertEquals(serialized.includes(endpointId), true);
});

Deno.test("RPC endpoint diagnostic errors expose only redacted fields", () => {
  const endpoint = "https://user:pass@rpc.example/rpc?token=secret";

  assertEquals(redactRpcDiagnostic(new Error(`failed ${endpoint}`)), {
    name: "Error",
    message: `failed ${getRpcEndpointId(endpoint)}`,
  });
});

Deno.test("RPC endpoint diagnostics cap deep and circular payloads without leaking URLs", () => {
  const endpoint = "https://user:pass@rpc.example/rpc?token=secret";
  let deepPayload: unknown = endpoint;
  for (let depth = 0; depth < 32; depth++) {
    deepPayload = { nested: deepPayload };
  }

  const circularPayload: Record<string, unknown> = { endpoint };
  circularPayload.self = circularPayload;
  const serialized = JSON.stringify({
    deep: redactRpcDiagnostic(deepPayload),
    circular: redactRpcDiagnostic(circularPayload),
  });

  assertEquals(serialized.includes(endpoint), false);
  assertEquals(serialized.includes("maximum depth"), true);
  assertEquals(serialized.includes("circular reference"), true);
});
