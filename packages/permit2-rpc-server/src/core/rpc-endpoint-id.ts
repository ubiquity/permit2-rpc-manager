const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const FNV_64_MASK = 0xffffffffffffffffn;
const RPC_URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s\]\[<>"'`),;]+/gi;

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/$/, "");
}

/**
 * Produces a stable diagnostic identifier without exposing an upstream URL.
 */
export function getRpcEndpointId(url: string): string {
  const normalized = normalizeEndpoint(url);
  let hash = FNV_64_OFFSET_BASIS;

  for (let index = 0; index < normalized.length; index++) {
    hash ^= BigInt(normalized.charCodeAt(index));
    hash = (hash * FNV_64_PRIME) & FNV_64_MASK;
  }

  return `rpc-${hash.toString(16).padStart(16, "0")}`;
}

export function redactRpcDiagnostic(value: string): string;
export function redactRpcDiagnostic<T>(value: T): T;
/**
 * Replaces URL-shaped values in diagnostic payloads while retaining their shape.
 */
export function redactRpcDiagnostic(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(RPC_URL_PATTERN, (url) => getRpcEndpointId(url));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactRpcDiagnostic(value.message),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactRpcDiagnostic(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactRpcDiagnostic(entry)]));
  }

  return value;
}
