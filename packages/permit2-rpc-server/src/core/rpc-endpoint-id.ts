const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const FNV_64_MASK = 0xffffffffffffffffn;
// Quotes and common diagnostic wrappers terminate URL tokens. Brackets,
// semicolons, and URL punctuation stay in the token because they are legal
// URL characters (notably for IPv6 authorities and query strings).
const RPC_URL_PATTERN = /(?:https?|wss?):\/\/[^\s"'<>`\\]+/gi;
const MAX_REDACTION_DEPTH = 16;
const REDACTED_DEPTH_MARKER = "[redacted: maximum depth]";
const REDACTED_CIRCULAR_MARKER = "[redacted: circular reference]";
const WRAPPER_CLOSERS: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
};
const TRAILING_WRAPPER_PUNCTUATION = new Set([",", ".", "!", "?", ";", ":"]);

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/$/, "");
}

function getExpectedClosingWrappers(value: string, urlOffset: number): string {
  let expected = "";

  for (let index = urlOffset - 1; index >= 0; index--) {
    const closing = WRAPPER_CLOSERS[value[index]];
    if (!closing) break;
    expected += closing;
  }

  return expected;
}

function splitTrailingUrlWrappers(
  matchedUrl: string,
  diagnostic: string,
  urlOffset: number,
): { endpoint: string; suffix: string } {
  const expectedClosers = getExpectedClosingWrappers(diagnostic, urlOffset);
  if (!expectedClosers) return { endpoint: matchedUrl, suffix: "" };

  let punctuationStart = matchedUrl.length;
  while (punctuationStart > 0 && TRAILING_WRAPPER_PUNCTUATION.has(matchedUrl[punctuationStart - 1])) {
    punctuationStart--;
  }

  for (let length = Math.min(expectedClosers.length, punctuationStart); length > 0; length--) {
    if (matchedUrl.slice(punctuationStart - length, punctuationStart) === expectedClosers.slice(0, length)) {
      const endpointEnd = punctuationStart - length;
      return {
        endpoint: matchedUrl.slice(0, endpointEnd),
        suffix: matchedUrl.slice(endpointEnd),
      };
    }
  }

  return { endpoint: matchedUrl, suffix: "" };
}

function redactUrlString(value: string): string {
  return value.replace(RPC_URL_PATTERN, (matchedUrl, urlOffset) => {
    const { endpoint, suffix } = splitTrailingUrlWrappers(matchedUrl, value, urlOffset);
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
