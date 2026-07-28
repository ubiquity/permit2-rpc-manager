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

Deno.test("RPC endpoint diagnostics stop at explicit wrappers and redact compact URL JSON", () => {
  const quotedEndpoint = "https://user:quoted-secret@quoted.example/rpc?token=quoted-token";
  const angleEndpoint = "https://user:angle-secret@angle.example/rpc?token=angle-token";
  const backtickEndpoint = "wss://user:backtick-secret@backtick.example/ws?token=backtick-token";
  const backslashEndpoint = "https://user:backslash-secret@backslash.example/rpc?token=backslash-token";
  const firstJsonEndpoint = "https://user:first-secret@first.example/rpc?token=first-token";
  const secondJsonEndpoint = "https://user:second-secret@second.example/rpc?token=second-token";

  assertEquals(redactRpcDiagnostic(`\"${quotedEndpoint}\"`), `\"${getRpcEndpointId(quotedEndpoint)}\"`);
  assertEquals(redactRpcDiagnostic(`<${angleEndpoint}>`), `<${getRpcEndpointId(angleEndpoint)}>`);
  assertEquals(redactRpcDiagnostic(`\`${backtickEndpoint}\``), `\`${getRpcEndpointId(backtickEndpoint)}\``);
  assertEquals(redactRpcDiagnostic(`\\${backslashEndpoint}\\`), `\\${getRpcEndpointId(backslashEndpoint)}\\`);
  assertEquals(
    redactRpcDiagnostic(`{\"first\":\"${firstJsonEndpoint}\",\"second\":\"${secondJsonEndpoint}\"}`),
    `{\"first\":\"${getRpcEndpointId(firstJsonEndpoint)}\",\"second\":\"${getRpcEndpointId(secondJsonEndpoint)}\"}`,
  );
});

Deno.test("RPC endpoint diagnostics preserve legal URL punctuation unless a matching wrapper proves it external", () => {
  const endpoint = "https://user:secret@rpc.example/v1/path!$&()*+,;=:@?query=one,two!three.";
  const endpointId = getRpcEndpointId(endpoint);

  assertEquals(redactRpcDiagnostic(endpoint), endpointId);
  assertEquals(redactRpcDiagnostic(`(${endpoint}),`), `(${endpointId}),`);
});

Deno.test("RPC endpoint diagnostics preserve IPv6 brackets and semicolon query data", () => {
  const endpoint = "https://user:pass@[2001:db8::1]:8545/rpc?token=[secret];scope=read";
  const endpointId = getRpcEndpointId(endpoint);

  assertEquals(redactRpcDiagnostic(endpoint), endpointId);
  assertEquals(redactRpcDiagnostic(`[${endpoint}]`), `[${endpointId}]`);
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

Deno.test("RPC endpoint diagnostics redact poisoned cached health data", () => {
  const endpoint = "https://user:cache-secret@rpc.example/rpc?token=cache-token";
  const fallbackEndpoint = "https://user:fallback-secret@fallback.example/rpc?token=fallback-token";
  const diagnostic = redactRpcDiagnostic({
    cache: {
      fastestRpc: endpoint,
      latencyMap: {
        [endpoint]: {
          error: `failed <${endpoint}> before trying ${fallbackEndpoint}`,
          url: endpoint,
        },
      },
    },
  });
  const serialized = JSON.stringify(diagnostic);

  assertEquals(serialized.includes("cache-secret"), false);
  assertEquals(serialized.includes("fallback-secret"), false);
  assertEquals(serialized.includes("rpc.example"), false);
  assertEquals(serialized.includes("fallback.example"), false);
  assertEquals(serialized.includes(getRpcEndpointId(endpoint)), true);
  assertEquals(serialized.includes(getRpcEndpointId(fallbackEndpoint)), true);
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
