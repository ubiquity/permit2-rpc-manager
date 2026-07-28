const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const FNV_64_MASK = 0xffffffffffffffffn;
// URL paths and queries can contain brackets and punctuation, so consume the
// complete non-whitespace token rather than leaving a sensitive suffix behind.
const RPC_URL_PATTERN = /(?:https?|wss?):\/\/\S+/gi;
const MAX_REDACTION_DEPTH = 16;
const REDACTED_DEPTH_MARKER = "[redacted: maximum depth]";
const REDACTED_CIRCULAR_MARKER = "[redacted: circular reference]";

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/$/, "");
}

function hasUnmatchedClosingDelimiter(value: string, opening: string, closing: string): boolean {
  let openings = 0;
  let closings = 0;
  for (const char of value) {
    if (char === opening) openings++;
    if (char === closing) closings++;
  }
  return closings > openings;
}

function splitTrailingUrlPunctuation(value: string): { endpoint: string; suffix: string } {
  let endpointEnd = value.length;
  let suffix = "";

  while (endpointEnd > 0) {
    const char = value[endpointEnd - 1];
    const candidate = value.slice(0, endpointEnd);
    const isUnmatchedClosingDelimiter = (char === ")" && hasUnmatchedClosingDelimiter(candidate, "(", ")")) ||
      (char === "]" && hasUnmatchedClosingDelimiter(candidate, "[", "]")) ||
      (char === "}" && hasUnmatchedClosingDelimiter(candidate, "{", "}"));
    const isSentencePunctuation = ",.!?".includes(char);
    if (!isUnmatchedClosingDelimiter && !isSentencePunctuation) break;

    endpointEnd--;
    suffix = `${char}${suffix}`;
  }

  return { endpoint: value.slice(0, endpointEnd), suffix };
}

function redactUrlString(value: string): string {
  return value.replace(RPC_URL_PATTERN, (matchedUrl) => {
    const { endpoint, suffix } = splitTrailingUrlPunctuation(matchedUrl);
    return `${getRpcEndpointId(endpoint)}${suffix}`;
  });
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
export function redactRpcDiagnostic(value: Error): { name: string; message: string };
export function redactRpcDiagnostic(value: unknown): unknown;
/**
 * Replaces URL-shaped values in diagnostic payloads while retaining their shape.
 */
export function redactRpcDiagnostic(value: unknown): unknown {
  return redactRpcDiagnosticValue(value, 0, new WeakSet<object>());
}

function redactRpcDiagnosticValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactUrlString(value);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactUrlString(value.message),
    };
  }

  if (depth >= MAX_REDACTION_DEPTH) return REDACTED_DEPTH_MARKER;

  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACTED_CIRCULAR_MARKER;
    seen.add(value);
    return value.map((entry) => redactRpcDiagnosticValue(entry, depth + 1, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return REDACTED_CIRCULAR_MARKER;
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map((
        [key, entry],
      ) => [redactUrlString(key), redactRpcDiagnosticValue(entry, depth + 1, seen)]),
    );
  }

  return value;
}
