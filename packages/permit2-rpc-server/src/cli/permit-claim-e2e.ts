type PermitCall = {
  from?: string;
  to: string;
  data: string;
  value?: string;
};

type PermitInput = {
  label?: string;
  chainId?: number;
  blockTag?: string | number;
  methods?: string[];
  call?: PermitCall;
  preparedRequest?: Record<string, unknown>;
};

type PermitFile = {
  chainId?: number;
  blockTag?: string | number;
  permits?: PermitInput[];
};

type NormalizedPermit = {
  label: string;
  chainId: number;
  blockTag: string | number;
  methods: string[];
  call: PermitCall;
};

type RpcErrorDetails = {
  code?: number;
  message?: string;
  data?: string;
  selector?: string;
  knownError?: string;
};

type CallResult = {
  rpcUrl: string;
  permitLabel: string;
  chainId: number;
  method: string;
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  error?: RpcErrorDetails;
  result?: string;
  category: string;
};

type CliArgs = {
  permitsPath?: string;
  chainId?: number;
  blockTag?: string | number;
  limit: number;
  timeoutMs: number;
  concurrency: number;
  method: "call" | "estimate" | "both";
  rpcs: string[];
  whitelistPath?: string;
  outPath: string;
  verbose: boolean;
  help: boolean;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_OUT_PATH = "permit-claim-report.json";

const KNOWN_SELECTORS = new Map<string, string>([
  ["0x756688fe", "InvalidSignature()"],
  ["0x08c379a0", "Error(string)"],
  ["0x4e487b71", "Panic(uint256)"],
]);

function parseBlockTag(value: string): string | number {
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {
    limit: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    method: "call",
    rpcs: [],
    outPath: DEFAULT_OUT_PATH,
    verbose: false,
    help: false,
  };

  const needsValue = (flag: string) => {
    throw new Error(`Missing value for ${flag}`);
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--permits") {
      parsed.permitsPath = args[++i] ?? needsValue(arg);
      continue;
    }
    if (arg === "--chain") {
      const value = args[++i] ?? needsValue(arg);
      parsed.chainId = Number.parseInt(value, 10);
      continue;
    }
    if (arg === "--block-tag") {
      const value = args[++i] ?? needsValue(arg);
      parsed.blockTag = parseBlockTag(value);
      continue;
    }
    if (arg === "--limit") {
      const value = args[++i] ?? needsValue(arg);
      parsed.limit = Number.parseInt(value, 10);
      continue;
    }
    if (arg === "--timeout") {
      const value = args[++i] ?? needsValue(arg);
      parsed.timeoutMs = Number.parseInt(value, 10);
      continue;
    }
    if (arg === "--concurrency") {
      const value = args[++i] ?? needsValue(arg);
      parsed.concurrency = Number.parseInt(value, 10);
      continue;
    }
    if (arg === "--method") {
      const value = (args[++i] ?? needsValue(arg)).toLowerCase();
      if (value !== "call" && value !== "estimate" && value !== "both") {
        throw new Error(`--method must be one of: call, estimate, both (got '${value}')`);
      }
      parsed.method = value as CliArgs["method"];
      continue;
    }
    if (arg === "--rpc") {
      parsed.rpcs.push(args[++i] ?? needsValue(arg));
      continue;
    }
    if (arg === "--whitelist") {
      parsed.whitelistPath = args[++i] ?? needsValue(arg);
      continue;
    }
    if (arg === "--out") {
      parsed.outPath = args[++i] ?? needsValue(arg);
      continue;
    }
    if (arg === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp(): void {
  console.log(`Permit claim E2E tester

Usage:
  deno run --allow-net --allow-read src/cli/permit-claim-e2e.ts --permits <file> [options]

Options:
  --permits <file>      JSON file containing permits (required)
  --chain <id>          ChainId override (e.g. 100)
  --block-tag <tag>     Block tag override (default: latest)
  --limit <n>           Limit number of RPCs from whitelist
  --timeout <ms>        Request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --concurrency <n>     Max inflight requests (default: ${DEFAULT_CONCURRENCY})
  --method <mode>       call | estimate | both (default: call)
  --rpc <url>           Explicit RPC URL (repeatable)
  --whitelist <file>    Whitelist JSON override
  --out <file>          Output report path (default: ${DEFAULT_OUT_PATH})
  --verbose             Print per-request results
  --help, -h            Show help

Permit JSON format:
  [
    {
      "label": "example",
      "chainId": 100,
      "blockTag": "latest",
      "methods": ["eth_call", "eth_estimateGas"],
      "call": {
        "from": "0x...",
        "to": "0x...",
        "data": "0x...",
        "value": "0x0"
      }
    }
  ]

You can also use { "chainId": 100, "permits": [...] } and/or
provide "preparedRequest" from the UI log (account/from/to/data/value).
`);
}

async function readJsonFile(path: string | URL): Promise<unknown> {
  const text = await Deno.readTextFile(path);
  return JSON.parse(text);
}

function extractCallFromPreparedRequest(prepared: Record<string, unknown>): PermitCall | null {
  const to = typeof prepared.to === "string" ? prepared.to : undefined;
  const data = typeof prepared.data === "string" ? prepared.data : undefined;
  const from = typeof prepared.from === "string"
    ? prepared.from
    : (typeof prepared.account === "string" ? prepared.account : undefined);
  const value = typeof prepared.value === "string" ? prepared.value : undefined;
  if (!to || !data) return null;
  return { to, data, from, value };
}

function normalizePermits(
  raw: unknown,
  defaultChainId?: number,
  defaultBlockTag?: string | number,
  defaultMethods: string[] = ["eth_call"],
): NormalizedPermit[] {
  const file = raw as PermitFile;
  const permits = Array.isArray(raw) ? raw : file.permits;

  if (!Array.isArray(permits) || permits.length === 0) {
    throw new Error("Permits file must be a non-empty array or { permits: [...] }");
  }

  const chainFallback = file.chainId ?? defaultChainId;
  const blockFallback = file.blockTag ?? defaultBlockTag ?? "latest";

  return permits.map((entry, index) => {
    const permit = entry as PermitInput;
    const label = permit.label ?? `permit-${index + 1}`;
    const chainId = permit.chainId ?? chainFallback;
    if (!chainId || Number.isNaN(chainId)) {
      throw new Error(`Missing chainId for ${label}`);
    }

    const blockTag = permit.blockTag ?? blockFallback;
    const rawMethods = Array.isArray(permit.methods) && permit.methods.length > 0
      ? permit.methods
      : defaultMethods;
    const methods = Array.from(new Set(rawMethods.map((method) => String(method).toLowerCase())));
    for (const method of methods) {
      if (method !== "eth_call" && method !== "eth_estimateGas") {
        throw new Error(`Unsupported method '${method}' for ${label}`);
      }
    }

    let call = permit.call ?? null;
    if (!call && permit.preparedRequest) {
      const prepared = permit.preparedRequest;
      call = extractCallFromPreparedRequest(prepared);
    }

    if (!call || typeof call.to !== "string" || typeof call.data !== "string") {
      throw new Error(`Missing call data for ${label}`);
    }

    return {
      label,
      chainId,
      blockTag,
      methods,
      call,
    };
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function parseRpcError(error: Record<string, unknown> | undefined): RpcErrorDetails | undefined {
  if (!error) return undefined;
  const code = typeof error.code === "number" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message : undefined;
  const data = typeof error.data === "string" ? error.data : undefined;
  const selector = data && data.startsWith("0x") && data.length >= 10 ? data.slice(0, 10).toLowerCase() : undefined;
  const knownError = selector ? KNOWN_SELECTORS.get(selector) : undefined;
  return { code, message, data, selector, knownError };
}

function classifyResult(result: CallResult): string {
  if (result.ok) return "ok";
  if (result.httpStatus && result.httpStatus >= 400) return `http_${result.httpStatus}`;
  const message = result.error?.message?.toLowerCase() ?? "";
  if (result.error?.code === -32601 || message.includes("method not found") || message.includes("not supported")) {
    return "method_not_supported";
  }
  if (message.includes("execution reverted")) return "execution_reverted";
  if (message.includes("internal json-rpc error")) return "internal_rpc_error";
  if (result.error?.selector) return `revert_${result.error.selector}`;
  return "rpc_error";
}

async function rpcRequest(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
  id: number,
): Promise<{ httpStatus: number; json?: Record<string, unknown>; text?: string; latencyMs: number; parseError?: string }> {
  const started = performance.now();
  const controller = new AbortController();
  const requestBody = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  try {
    const response = await withTimeout(
      fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      }),
      timeoutMs,
      `${method} (${rpcUrl})`,
    );

    const latencyMs = Math.round(performance.now() - started);
    const text = await response.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return { httpStatus: response.status, json, latencyMs, text };
    } catch (error) {
      return {
        httpStatus: response.status,
        text,
        latencyMs,
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    controller.abort();
  }
}

async function runRequests(
  rpcUrl: string,
  permit: NormalizedPermit,
  methods: string[],
  timeoutMs: number,
  nextId: () => number,
): Promise<CallResult[]> {
  const results: CallResult[] = [];

  for (const method of methods) {
    const params = method === "eth_call"
      ? [permit.call, permit.blockTag]
      : [permit.call];
    let response: {
      httpStatus: number;
      json?: Record<string, unknown>;
      text?: string;
      latencyMs: number;
      parseError?: string;
    };
    try {
      response = await rpcRequest(rpcUrl, method, params, timeoutMs, nextId());
    } catch (error) {
      const latencyMs = 0;
      results.push({
        rpcUrl,
        permitLabel: permit.label,
        chainId: permit.chainId,
        method,
        ok: false,
        latencyMs,
        error: { message: error instanceof Error ? error.message : String(error) },
        category: "request_failed",
      });
      continue;
    }

    const json = response.json;
    let errorDetails = parseRpcError(json?.error as Record<string, unknown> | undefined);
    if (response.parseError) {
      errorDetails = errorDetails ?? { message: `Invalid JSON response: ${response.parseError}` };
    }
    const ok = Boolean(json && "result" in json && json.result !== undefined && !json.error);
    const resultValue = typeof json?.result === "string" ? json.result : undefined;
    const callResult: CallResult = {
      rpcUrl,
      permitLabel: permit.label,
      chainId: permit.chainId,
      method,
      ok,
      httpStatus: response.httpStatus,
      latencyMs: response.latencyMs,
      error: ok ? undefined : errorDetails,
      result: resultValue,
      category: "pending",
    };
    callResult.category = classifyResult(callResult);
    results.push(callResult);
  }

  return results;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, maxInflight: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  const worker = async () => {
    while (true) {
      const current = index++;
      if (current >= tasks.length) return;
      results[current] = await tasks[current]();
    }
  };

  const workers = Array.from(
    { length: Math.min(maxInflight, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list));
}

function summarizeResults(results: CallResult[]): string[] {
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const errors = total - ok;
  const summaries: string[] = [];
  summaries.push(`Total requests: ${total}`);
  summaries.push(`OK: ${ok}`);
  summaries.push(`Errors: ${errors}`);

  const byRpc = new Map<string, { total: number; ok: number; categories: Map<string, number> }>();
  for (const result of results) {
    const entry = byRpc.get(result.rpcUrl) ?? { total: 0, ok: 0, categories: new Map() };
    entry.total += 1;
    if (result.ok) entry.ok += 1;
    entry.categories.set(result.category, (entry.categories.get(result.category) ?? 0) + 1);
    byRpc.set(result.rpcUrl, entry);
  }

  summaries.push("RPC breakdown:");
  for (const [rpcUrl, data] of byRpc) {
    const categories = Array.from(data.categories.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    summaries.push(`  ${rpcUrl} ok=${data.ok}/${data.total} ${categories}`);
  }

  return summaries;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(Deno.args);
  } catch (error) {
    console.error((error as Error).message);
    console.error("");
    printHelp();
    Deno.exit(1);
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.permitsPath) {
    console.error("--permits is required.");
    printHelp();
    Deno.exit(1);
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    console.error("--timeout must be a positive integer (ms).");
    Deno.exit(1);
  }

  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) {
    console.error("--concurrency must be a positive integer.");
    Deno.exit(1);
  }

  if (args.limit < 0 || !Number.isFinite(args.limit)) {
    console.error("--limit must be a non-negative integer.");
    Deno.exit(1);
  }

  const permitsRaw = await readJsonFile(args.permitsPath);
  const methods = args.method === "both"
    ? ["eth_call", "eth_estimateGas"]
    : [args.method === "call" ? "eth_call" : "eth_estimateGas"];
  const permits = normalizePermits(permitsRaw, args.chainId, args.blockTag, methods);

  const chainIds = dedupe(permits.map((permit) => String(permit.chainId)));
  if (chainIds.length > 1) {
    console.warn(`Multiple chainIds in permit file: ${chainIds.join(", ")}`);
  }

  let rpcUrls: string[] = [];
  if (args.rpcs.length > 0) {
    rpcUrls = args.rpcs;
  } else {
    if (chainIds.length !== 1) {
      console.error("Multiple chainIds detected. Use --chain with a single chain, or pass explicit --rpc values.");
      Deno.exit(1);
    }
    const whitelistPath = args.whitelistPath ??
      new URL("../../rpc-whitelist.json", import.meta.url);
    const whitelistRaw = await readJsonFile(whitelistPath);
    const whitelist = whitelistRaw as { rpcs?: Record<string, string[]> };
    const chainId = args.chainId ?? permits[0].chainId;
    rpcUrls = (whitelist.rpcs?.[String(chainId)] ?? []).filter(
      (url) => typeof url === "string" && /^https?:\/\//.test(url) && !url.includes("${"),
    );
  }

  rpcUrls = dedupe(rpcUrls);
  if (args.limit > 0) {
    rpcUrls = rpcUrls.slice(0, args.limit);
  }

  if (rpcUrls.length === 0) {
    console.error("No RPC URLs resolved. Use --rpc or check whitelist.");
    Deno.exit(1);
  }

  const tasks: Array<() => Promise<CallResult[]>> = [];
  let idCounter = 1;
  const nextId = () => idCounter++;
  for (const rpcUrl of rpcUrls) {
    for (const permit of permits) {
      const permitMethods = permit.methods.length > 0 ? permit.methods : methods;
      tasks.push(() => runRequests(rpcUrl, permit, permitMethods, args.timeoutMs, nextId));
    }
  }

  console.log(`Testing ${permits.length} permit(s) across ${rpcUrls.length} RPC(s)...`);
  const resultBatches = await runWithConcurrency(tasks, args.concurrency);
  const results = resultBatches.flat();

  if (args.verbose) {
    for (const result of results) {
      const base = `${result.rpcUrl} ${result.permitLabel} ${result.method} ${result.category}`;
      if (result.ok) {
        console.log(`${base} ok (${result.latencyMs}ms)`);
      } else {
        console.log(`${base} error=${result.error?.message ?? "unknown"} (${result.latencyMs}ms)`);
      }
    }
  }

  const summary = summarizeResults(results);
  console.log(summary.join("\n"));

  const report = {
    generatedAt: new Date().toISOString(),
    permits: permits.map((permit) => ({
      label: permit.label,
      chainId: permit.chainId,
      blockTag: permit.blockTag,
      methods: permit.methods,
      call: permit.call,
    })),
    rpcUrls,
    results,
  };

  await Deno.writeTextFile(args.outPath, JSON.stringify(report, null, 2));
  console.log(`Report saved to ${args.outPath}`);
}

if (import.meta.main) {
  main();
}
