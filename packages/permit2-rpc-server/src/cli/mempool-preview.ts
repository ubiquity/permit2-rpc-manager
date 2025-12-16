/// <reference lib="deno.ns" />

type JsonRpcId = number;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
};

type JsonRpcSubscriptionNotification = {
  jsonrpc: "2.0";
  method: "eth_subscription";
  params: {
    subscription: string;
    result: unknown;
  };
};

type RpcTransaction = {
  hash?: string;
  from?: string;
  to?: string | null;
  value?: string;
  type?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
  input?: string;
};

type TxSummary = {
  hash?: string;
  from?: string;
  to?: string | null;
  valueWei?: string;
  valueEth?: string;
  type?: string;
  gasLimit?: string;
  gasPriceGwei?: string;
  maxFeeGwei?: string;
  priorityFeeGwei?: string;
  nonce?: string;
  dataBytes?: number;
};

type OutputFormat = "jsonl" | "json" | "pretty";

type JsonRpcCaller = {
  call: (method: string, params?: unknown[], options?: { timeoutMs?: number }) => Promise<unknown>;
};

type CliArgs = {
  wsUrl?: string;
  rpcUrl?: string;
  preset: string;
  format: OutputFormat;
  intervalMs: number;
  sampleRate: number;
  maxSamplesPerInterval: number;
  maxInflight: number;
  withBody: boolean;
  maxEvents: number;
  quiet: boolean;
  list: boolean;
  describe?: string;
  help: boolean;
};

type PresetInfo = {
  name: string;
  description: string;
  notes: string[];
  exampleEvent: unknown;
};

const PRESET_ALIASES: Record<string, string> = {
  counts: "pending-counts",
  sample: "pending-sample",
  raw: "pending-raw",
  heads: "new-heads",
  combo: "combo",
  txpool: "txpool-status",
};

const PRESETS: PresetInfo[] = [
  {
    name: "pending-counts",
    description:
      "Aggregated pending-tx throughput (tx/s) from newPendingTransactions (WS subscribe or HTTP filter polling).",
    notes: [
      "Streams 1 event per interval with count + tx/s.",
      "Portable: hashes-only; no per-tx lookups required.",
    ],
    exampleEvent: {
      type: "pending_counts",
      ts: "2025-01-01T00:00:00.000Z",
      data: { intervalMs: 1000, pendingCount: 1234, pendingPerSecond: 1234, totalSeen: 999999 },
    },
  },
  {
    name: "pending-sample",
    description: "Aggregated pending-tx throughput plus a small sample of tx summaries (fee/value/to).",
    notes: [
      "Streams 1 event per interval with count + sampled tx summaries.",
      "Uses eth_getTransactionByHash for sampled hashes (WS unless --with-body works; HTTP always).",
    ],
    exampleEvent: {
      type: "pending_sample",
      ts: "2025-01-01T00:00:00.000Z",
      data: {
        intervalMs: 1000,
        pendingCount: 1234,
        pendingPerSecond: 1234,
        samples: [
          { hash: "0x…", from: "0x…", to: "0x…", valueEth: "0.01", maxFeeGwei: "42.0", dataBytes: 68 },
        ],
      },
    },
  },
  {
    name: "pending-raw",
    description: "Raw pending events (WS subscription notifications; HTTP filter hashes).",
    notes: [
      "Streams every pending event; can be extremely noisy on mainnet.",
      "Use --max-events to stop quickly.",
    ],
    exampleEvent: {
      type: "pending_raw",
      ts: "2025-01-01T00:00:00.000Z",
      data: { result: "0xdeadbeef…" },
    },
  },
  {
    name: "new-heads",
    description: "New block headers (WS subscribe; HTTP polling latest block).",
    notes: ["Streams on each new block; useful alongside mempool stats."],
    exampleEvent: {
      type: "new_heads",
      ts: "2025-01-01T00:00:00.000Z",
      data: { number: "0x1234", hash: "0x…", baseFeePerGas: "0x…" },
    },
  },
  {
    name: "combo",
    description: "pending-counts + latest newHeads combined into a single periodic event.",
    notes: ["Streams 1 event per interval (counts + last seen head)."],
    exampleEvent: {
      type: "combo",
      ts: "2025-01-01T00:00:00.000Z",
      data: { intervalMs: 1000, pendingCount: 1234, pendingPerSecond: 1234, head: { number: "0x1234" } },
    },
  },
  {
    name: "txpool-status",
    description: "Polling txpool_status (requires node/provider support; often unavailable on hosted RPCs).",
    notes: ["Calls txpool_status every interval and prints the response (pending/queued)."],
    exampleEvent: {
      type: "txpool_status",
      ts: "2025-01-01T00:00:00.000Z",
      data: { pending: "0x1a2b", queued: "0x00" },
    },
  },
];

function presetNames(): string[] {
  return PRESETS.map((p) => p.name);
}

function resolvePresetName(input: string): string {
  const normalized = input.trim().toLowerCase();
  return PRESET_ALIASES[normalized] ?? normalized;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const redactedPath = url.pathname
      .split("/")
      .map((seg) => (seg.length >= 16 ? "<redacted>" : seg))
      .join("/");
    const query = url.search ? "?<redacted>" : "";
    return `${url.protocol}//${url.host}${redactedPath}${query}`;
  } catch {
    return "<invalid url>";
  }
}

function printHelp(): void {
  const lines = [
    "Mempool preview CLI (WS or HTTP JSON-RPC)",
    "",
    "Usage:",
    "  deno task mempool:preview [--ws <ws://...> | --rpc <http://...>] [--preset <name>] [options]",
    "",
    "Presets:",
    `  ${presetNames().join(", ")}`,
    "",
    "Options:",
    "  --ws <url>                 WS endpoint to connect to (default: ws://127.0.0.1:8000/1)",
    "  --rpc <url>                HTTP(s) endpoint to poll (auto: filter polling; fallback: pending block)",
    "  --preset <name>            Preset name (default: pending-counts)",
    "  --format <jsonl|json|pretty> Output format (default: jsonl)",
    "  --interval <ms>            Tick/poll interval (WS aggregation; HTTP polling) (default: 1000)",
    "  --sample-rate <0..1>       Sampling probability (pending-sample; default: 0.02)",
    "  --max-samples <n>          Max samples per interval (pending-sample; default: 5)",
    "  --max-inflight <n>         Max concurrent tx lookups (pending-sample; default: 5)",
    "  --with-body                Try non-standard pending-tx bodies in subscription params",
    "  --max-events <n>           Exit after emitting N events (0 = unlimited)",
    "  --list                     List presets and exit",
    "  --describe <name>          Print preset schema + notes and exit",
    "  --quiet                    Suppress non-event logs",
    "  -h, --help                 Show help",
    "",
    "Examples:",
    "  deno task mempool:preview --preset pending-counts",
    "  deno task mempool:preview --preset pending-sample --sample-rate 0.01 --max-samples 3",
    "  deno task mempool:preview --ws wss://... --preset pending-raw --max-events 25",
    "  deno task mempool:preview --rpc http://127.0.0.1:8000/1 --preset pending-sample --max-events 10",
  ];
  console.log(lines.join("\n"));
}

function listPresets(): void {
  for (const preset of PRESETS) {
    console.log(`${preset.name}  - ${preset.description}`);
  }
}

function describePreset(name: string): void {
  const resolved = resolvePresetName(name);
  const preset = PRESETS.find((p) => p.name === resolved);
  if (!preset) {
    console.error(`Unknown preset: ${name}`);
    console.error(`Known presets: ${presetNames().join(", ")}`);
    Deno.exit(1);
  }
  console.log(`${preset.name}\n\n${preset.description}\n`);
  if (preset.notes.length) {
    console.log("Notes:");
    for (const note of preset.notes) console.log(`- ${note}`);
    console.log("");
  }
  console.log("Example event:");
  console.log(JSON.stringify(preset.exampleEvent, null, 2));
}

function parseNumber(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${flagName}: ${value}`);
  }
  return parsed;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    wsUrl: undefined,
    rpcUrl: undefined,
    preset: "pending-counts",
    format: "jsonl",
    intervalMs: 1000,
    sampleRate: 0.02,
    maxSamplesPerInterval: 5,
    maxInflight: 5,
    withBody: false,
    maxEvents: 0,
    quiet: false,
    list: false,
    describe: undefined,
    help: false,
  };

  const remainingPositionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "--") continue;

    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }

    if (!token.startsWith("-")) {
      remainingPositionals.push(token);
      continue;
    }

    const [flag, inlineValue] = token.includes("=") ? token.split("=", 2) : [token, undefined];
    const needsValue = (flagName: string): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${flagName}`);
      }
      i++;
      return next;
    };

    switch (flag) {
      case "--ws":
        args.wsUrl = needsValue("--ws");
        break;
      case "--rpc":
      case "--http":
        args.rpcUrl = needsValue(flag);
        break;
      case "--preset":
        args.preset = needsValue("--preset");
        break;
      case "--format": {
        const fmt = needsValue("--format");
        if (fmt !== "jsonl" && fmt !== "json" && fmt !== "pretty") {
          throw new Error(`Invalid --format: ${fmt}`);
        }
        args.format = fmt;
        break;
      }
      case "--interval":
        args.intervalMs = parseNumber(needsValue("--interval"), "--interval");
        break;
      case "--sample-rate":
        args.sampleRate = parseNumber(needsValue("--sample-rate"), "--sample-rate");
        break;
      case "--max-samples":
        args.maxSamplesPerInterval = parseNumber(needsValue("--max-samples"), "--max-samples");
        break;
      case "--max-inflight":
        args.maxInflight = parseNumber(needsValue("--max-inflight"), "--max-inflight");
        break;
      case "--max-events":
        args.maxEvents = parseNumber(needsValue("--max-events"), "--max-events");
        break;
      case "--with-body":
        args.withBody = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--describe":
        args.describe = needsValue("--describe");
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (remainingPositionals.length === 1 && args.preset === "pending-counts") {
    args.preset = remainingPositionals[0];
  } else if (remainingPositionals.length > 0) {
    throw new Error(`Unexpected positional args: ${remainingPositionals.join(" ")}`);
  }

  args.preset = resolvePresetName(args.preset);
  return args;
}

function isJsonRpcSuccessResponse(value: unknown): value is JsonRpcSuccessResponse {
  return typeof value === "object" && value !== null && (value as any).jsonrpc === "2.0" &&
    typeof (value as any).id === "number" &&
    "result" in (value as any);
}

function isJsonRpcErrorResponse(value: unknown): value is JsonRpcErrorResponse {
  return typeof value === "object" && value !== null && (value as any).jsonrpc === "2.0" &&
    typeof (value as any).id === "number" &&
    "error" in (value as any);
}

function isSubscriptionNotification(value: unknown): value is JsonRpcSubscriptionNotification {
  return typeof value === "object" && value !== null && (value as any).jsonrpc === "2.0" &&
    (value as any).method === "eth_subscription" &&
    typeof (value as any).params?.subscription === "string" && "result" in (value as any).params;
}

class JsonRpcWsClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly subscriptions = new Map<string, (result: unknown) => void>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.onmessage = (event) => this.onMessage(event);
    this.socket.onclose = () => this.onClose();
  }

  static async connect(url: string, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): Promise<JsonRpcWsClient> {
    const socket = new WebSocket(url);
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(true);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
    if (!opened) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      throw new Error("Failed to open WebSocket connection (timeout or error).");
    }
    return new JsonRpcWsClient(socket);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }

  async call(
    method: string,
    params: unknown[] = [],
    { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, params };
    const payload = JSON.stringify(request);

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
    });

    this.socket.send(payload);
    return await responsePromise;
  }

  async subscribe(params: unknown[], onResult: (result: unknown) => void): Promise<string> {
    const subscriptionId = await this.call("eth_subscribe", params);
    if (typeof subscriptionId !== "string") {
      throw new Error("eth_subscribe returned a non-string subscription id.");
    }
    this.subscriptions.set(subscriptionId, onResult);
    return subscriptionId;
  }

  private onMessage(event: MessageEvent): void {
    const raw = typeof event.data === "string" ? event.data : undefined;
    if (!raw) return;

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }

    if (isJsonRpcSuccessResponse(decoded)) {
      const pending = this.pending.get(decoded.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(decoded.id);
      pending.resolve(decoded.result);
      return;
    }

    if (isJsonRpcErrorResponse(decoded)) {
      const pending = this.pending.get(decoded.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(decoded.id);
      pending.reject(new Error(`JSON-RPC error ${decoded.error.code}: ${decoded.error.message}`));
      return;
    }

    if (isSubscriptionNotification(decoded)) {
      const handler = this.subscriptions.get(decoded.params.subscription);
      if (!handler) return;
      handler(decoded.params.result);
      return;
    }
  }

  private onClose(): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WebSocket closed."));
      this.pending.delete(id);
    }
  }
}

class JsonRpcHttpClient {
  private nextId = 1;

  constructor(private readonly url: string) {}

  close(): void {
    // no-op
  }

  async call(
    method: string,
    params: unknown[] = [],
    { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs) as unknown as number;

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`HTTP JSON-RPC request timed out: ${method}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new Error(`HTTP JSON-RPC returned non-JSON (status ${response.status}).`);
    }

    if (isJsonRpcSuccessResponse(decoded)) {
      if ((decoded as any).id !== id) {
        throw new Error(`Mismatched JSON-RPC id for ${method}.`);
      }
      return decoded.result;
    }

    if (isJsonRpcErrorResponse(decoded)) {
      if ((decoded as any).id !== id) {
        throw new Error(`Mismatched JSON-RPC id for ${method}.`);
      }
      throw new Error(`JSON-RPC error ${decoded.error.code}: ${decoded.error.message}`);
    }

    throw new Error(`Unexpected JSON-RPC response for ${method}.`);
  }
}

function isHexString(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function parseHexBigInt(value: unknown): bigint | undefined {
  if (!isHexString(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;

  if (decimals === 0) return `${negative ? "-" : ""}${whole.toString()}`;

  const fractionPadded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const fractionPart = fractionPadded.length ? `.${fractionPadded}` : "";
  return `${negative ? "-" : ""}${whole.toString()}${fractionPart}`;
}

function summarizeTx(tx: RpcTransaction): TxSummary {
  const valueWei = tx.value;
  const valueBig = parseHexBigInt(valueWei);
  const gasPriceWei = parseHexBigInt(tx.gasPrice);
  const maxFeeWei = parseHexBigInt(tx.maxFeePerGas);
  const priorityFeeWei = parseHexBigInt(tx.maxPriorityFeePerGas);

  const input = tx.input;
  const dataBytes = isHexString(input) ? Math.max(0, (input.length - 2) / 2) : undefined;

  return {
    hash: tx.hash,
    from: tx.from,
    to: tx.to ?? null,
    valueWei,
    valueEth: valueBig !== undefined ? formatUnits(valueBig, 18) : undefined,
    type: tx.type,
    gasLimit: tx.gas,
    gasPriceGwei: gasPriceWei !== undefined ? formatUnits(gasPriceWei, 9) : undefined,
    maxFeeGwei: maxFeeWei !== undefined ? formatUnits(maxFeeWei, 9) : undefined,
    priorityFeeGwei: priorityFeeWei !== undefined ? formatUnits(priorityFeeWei, 9) : undefined,
    nonce: tx.nonce,
    dataBytes,
  };
}

type PreviewEvent = { type: string; ts: string; data: unknown };

function createEmitter(
  {
    format,
    maxEvents,
    quiet,
    onStop,
  }: { format: OutputFormat; maxEvents: number; quiet: boolean; onStop: () => void },
): (event: PreviewEvent) => boolean {
  let emitted = 0;

  const emitJsonl = (event: PreviewEvent) => console.log(JSON.stringify(event));
  const emitJson = (event: PreviewEvent) => console.log(JSON.stringify(event, null, 2));
  const emitPretty = (event: PreviewEvent) => {
    if (event.type === "pending_counts") {
      const data = event.data as any;
      const txps = typeof data.pendingPerSecond === "number"
        ? data.pendingPerSecond.toFixed(0)
        : String(data.pendingPerSecond);
      console.log(`[${event.ts}] pending: ${data.pendingCount} (${txps}/s) totalSeen=${data.totalSeen}`);
      return;
    }
    if (event.type === "pending_sample") {
      const data = event.data as any;
      const txps = typeof data.pendingPerSecond === "number"
        ? data.pendingPerSecond.toFixed(0)
        : String(data.pendingPerSecond);
      console.log(
        `[${event.ts}] pending: ${data.pendingCount} (${txps}/s) samples=${
          Array.isArray(data.samples) ? data.samples.length : 0
        }`,
      );
      if (Array.isArray(data.samples)) {
        for (const sample of data.samples) {
          const to = sample.to ? `${sample.to}` : "<contract-create>";
          const fee = sample.maxFeeGwei
            ? `${sample.maxFeeGwei} gwei`
            : sample.gasPriceGwei
            ? `${sample.gasPriceGwei} gwei`
            : "?";
          const value = sample.valueEth ? `${sample.valueEth} ETH` : "?";
          console.log(`  ${sample.hash ?? "?"}  to=${to}  value=${value}  fee≈${fee}`);
        }
      }
      return;
    }
    console.log(`[${event.ts}] ${event.type}`);
    console.log(JSON.stringify(event.data, null, 2));
  };

  return (event: PreviewEvent): boolean => {
    if (event.type !== "meta") emitted++;
    if (format === "jsonl") emitJsonl(event);
    else if (format === "json") emitJson(event);
    else emitPretty(event);

    if (maxEvents > 0 && emitted >= maxEvents) {
      if (!quiet) console.error(`Reached --max-events=${maxEvents}, exiting.`);
      onStop();
      return false;
    }
    return true;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAsyncPool(maxConcurrent: number): {
  enqueue: (task: () => Promise<void>) => void;
  stats: () => { inflight: number; queued: number };
} {
  const queue: Array<() => Promise<void>> = [];
  let inflight = 0;
  let draining = false;

  const drain = () => {
    if (draining) return;
    draining = true;
    try {
      while (inflight < maxConcurrent && queue.length > 0) {
        const task = queue.shift();
        if (!task) break;
        inflight++;
        task()
          .catch(() => undefined)
          .finally(() => {
            inflight--;
            void drain();
          });
      }
    } finally {
      draining = false;
    }
  };

  return {
    enqueue: (task) => {
      queue.push(task);
      void drain();
    },
    stats: () => ({ inflight, queued: queue.length }),
  };
}

async function emitMeta(client: JsonRpcCaller, emit: (event: PreviewEvent) => boolean): Promise<void> {
  const ts = new Date().toISOString();
  let chainId: unknown = undefined;
  let clientVersion: unknown = undefined;

  try {
    chainId = await client.call("eth_chainId", []);
  } catch {
    // ignore
  }

  try {
    clientVersion = await client.call("web3_clientVersion", []);
  } catch {
    // ignore
  }

  emit({ type: "meta", ts, data: { chainId, clientVersion } });
}

async function runPendingCounts(
  client: JsonRpcWsClient,
  emit: (event: PreviewEvent) => boolean,
  { intervalMs, withBody }: { intervalMs: number; withBody: boolean },
): Promise<void> {
  let windowCount = 0;
  let totalSeen = 0;

  const subscribeParams = withBody ? ["newPendingTransactions", true] : ["newPendingTransactions"];
  try {
    await client.subscribe(subscribeParams, (_result) => {
      windowCount++;
      totalSeen++;
    });
  } catch (error) {
    if (withBody) {
      await client.subscribe(["newPendingTransactions"], (_result) => {
        windowCount++;
        totalSeen++;
      });
    } else {
      throw error;
    }
  }

  while (true) {
    await sleep(intervalMs);
    const perSecond = windowCount / (intervalMs / 1000);
    const shouldContinue = emit({
      type: "pending_counts",
      ts: new Date().toISOString(),
      data: { intervalMs, pendingCount: windowCount, pendingPerSecond: perSecond, totalSeen },
    });
    windowCount = 0;
    if (!shouldContinue) return;
  }
}

async function runPendingRaw(
  client: JsonRpcWsClient,
  emit: (event: PreviewEvent) => boolean,
  { withBody }: { withBody: boolean },
): Promise<void> {
  const subscribeParams = withBody ? ["newPendingTransactions", true] : ["newPendingTransactions"];
  try {
    await client.subscribe(subscribeParams, (result) => {
      emit({ type: "pending_raw", ts: new Date().toISOString(), data: { result } });
    });
  } catch (error) {
    if (withBody) {
      await client.subscribe(["newPendingTransactions"], (result) => {
        emit({ type: "pending_raw", ts: new Date().toISOString(), data: { result } });
      });
    } else {
      throw error;
    }
  }

  while (true) await sleep(60_000);
}

async function runNewHeads(client: JsonRpcWsClient, emit: (event: PreviewEvent) => boolean): Promise<void> {
  await client.subscribe(["newHeads"], (result) => {
    emit({ type: "new_heads", ts: new Date().toISOString(), data: result });
  });
  while (true) await sleep(60_000);
}

async function runTxpoolStatus(
  client: JsonRpcCaller,
  emit: (event: PreviewEvent) => boolean,
  { intervalMs }: { intervalMs: number },
): Promise<void> {
  while (true) {
    const ts = new Date().toISOString();
    let result: unknown;
    try {
      result = await client.call("txpool_status", []);
    } catch (error) {
      result = { error: (error as Error).message };
    }
    const shouldContinue = emit({ type: "txpool_status", ts, data: result });
    if (!shouldContinue) return;
    await sleep(intervalMs);
  }
}

async function runPendingSample(
  client: JsonRpcWsClient,
  emit: (event: PreviewEvent) => boolean,
  {
    intervalMs,
    sampleRate,
    maxSamplesPerInterval,
    maxInflight,
    withBody,
  }: { intervalMs: number; sampleRate: number; maxSamplesPerInterval: number; maxInflight: number; withBody: boolean },
): Promise<void> {
  let windowPending = 0;
  let windowSampled = 0;
  let totalSeen = 0;
  let sampleNulls = 0;
  let sampleErrors = 0;
  const samples: TxSummary[] = [];

  const pool = createAsyncPool(maxInflight);

  const enqueueLookup = (hash: string) => {
    pool.enqueue(async () => {
      try {
        const tx = await client.call("eth_getTransactionByHash", [hash]);
        if (tx && typeof tx === "object") {
          samples.push(summarizeTx(tx as RpcTransaction));
        } else {
          sampleNulls++;
        }
      } catch {
        sampleErrors++;
      }
    });
  };

  const onPendingResult = (result: unknown) => {
    windowPending++;
    totalSeen++;
    if (windowSampled >= maxSamplesPerInterval) return;
    if (Math.random() > sampleRate) return;

    windowSampled++;

    if (typeof result === "string" && isHexString(result)) {
      enqueueLookup(result);
      return;
    }

    if (typeof result === "object" && result !== null) {
      samples.push(summarizeTx(result as RpcTransaction));
    }
  };

  const subscribeParams = withBody ? ["newPendingTransactions", true] : ["newPendingTransactions"];
  try {
    await client.subscribe(subscribeParams, onPendingResult);
  } catch (error) {
    if (withBody) {
      await client.subscribe(["newPendingTransactions"], onPendingResult);
    } else {
      throw error;
    }
  }

  while (true) {
    await sleep(intervalMs);
    const perSecond = windowPending / (intervalMs / 1000);
    const poolStats = pool.stats();
    const shouldContinue = emit({
      type: "pending_sample",
      ts: new Date().toISOString(),
      data: {
        intervalMs,
        pendingCount: windowPending,
        pendingPerSecond: perSecond,
        totalSeen,
        samples: samples.splice(0, samples.length),
        sampleNulls,
        sampleErrors,
        lookups: poolStats,
      },
    });
    windowPending = 0;
    windowSampled = 0;
    sampleNulls = 0;
    sampleErrors = 0;
    if (!shouldContinue) return;
  }
}

async function runCombo(
  client: JsonRpcWsClient,
  emit: (event: PreviewEvent) => boolean,
  { intervalMs, withBody }: { intervalMs: number; withBody: boolean },
): Promise<void> {
  let windowPending = 0;
  let totalSeen = 0;
  let lastHead: unknown = undefined;

  await client.subscribe(["newHeads"], (result) => {
    lastHead = result;
  });

  const onPending = (_result: unknown) => {
    windowPending++;
    totalSeen++;
  };

  const subscribeParams = withBody ? ["newPendingTransactions", true] : ["newPendingTransactions"];
  try {
    await client.subscribe(subscribeParams, onPending);
  } catch (error) {
    if (withBody) {
      await client.subscribe(["newPendingTransactions"], onPending);
    } else {
      throw error;
    }
  }

  while (true) {
    await sleep(intervalMs);
    const perSecond = windowPending / (intervalMs / 1000);
    const shouldContinue = emit({
      type: "combo",
      ts: new Date().toISOString(),
      data: { intervalMs, pendingCount: windowPending, pendingPerSecond: perSecond, totalSeen, head: lastHead },
    });
    windowPending = 0;
    if (!shouldContinue) return;
  }
}

function isFilterNotFoundError(error: unknown): boolean {
  return error instanceof Error && /filter not found|invalid filter id/i.test(error.message);
}

type ParsedJsonRpcError = { code: number; message: string };

function parseJsonRpcError(error: unknown): ParsedJsonRpcError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/^JSON-RPC error (-?\d+): (.*)$/);
  if (!match) return undefined;
  const code = Number(match[1]);
  if (!Number.isFinite(code)) return undefined;
  return { code, message: match[2] };
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isMethodUnavailableError(error: unknown): boolean {
  const parsed = parseJsonRpcError(error);
  if (parsed?.code === -32601) return true;
  if (parsed?.code === -32600 && /not allowed/i.test(parsed.message)) return true;
  const message = (parsed?.message ?? (error instanceof Error ? error.message : "")).toLowerCase();
  return message.includes("does not exist") || message.includes("not available") || message.includes("not allowed") ||
    message.includes("not supported");
}

async function createPendingTxFilter(client: JsonRpcCaller): Promise<string> {
  const filterId = await client.call("eth_newPendingTransactionFilter", []);
  if (!isHexString(filterId) || filterId === "0x") {
    throw new Error("eth_newPendingTransactionFilter returned an invalid filter id.");
  }
  return filterId;
}

async function getPendingFilterChanges(client: JsonRpcCaller, filterId: string): Promise<string[]> {
  const changes = await client.call("eth_getFilterChanges", [filterId]);
  if (!Array.isArray(changes)) return [];
  const hashes: string[] = [];
  for (const item of changes) {
    if (typeof item === "string" && isHexString(item)) hashes.push(item);
  }
  return hashes;
}

async function uninstallFilter(client: JsonRpcCaller, filterId: string): Promise<void> {
  try {
    await client.call("eth_uninstallFilter", [filterId], { timeoutMs: 2_000 });
  } catch {
    // ignore
  }
}

type PendingPollMode = "filter" | "pending-block";

type PendingBlockInfo = { number?: string; hashes: string[] };

function parsePendingBlock(value: unknown): PendingBlockInfo {
  if (!value || typeof value !== "object") return { hashes: [] };
  const block = value as any;
  const number = typeof block.number === "string" ? block.number : undefined;
  const txs: unknown = block.transactions;
  if (!Array.isArray(txs)) return { number, hashes: [] };
  const hashes: string[] = [];
  for (const item of txs) {
    if (typeof item === "string" && isHexString(item)) {
      hashes.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const hash = (item as any).hash;
      if (typeof hash === "string" && isHexString(hash)) hashes.push(hash);
    }
  }
  return { number, hashes };
}

async function getPendingBlockInfo(client: JsonRpcCaller): Promise<PendingBlockInfo> {
  const block = await client.call("eth_getBlockByNumber", ["pending", false]);
  return parsePendingBlock(block);
}

function summarizeBlockHeader(block: unknown): unknown {
  if (!block || typeof block !== "object") return block;
  const value = block as any;
  const transactionsCount = Array.isArray(value.transactions) ? value.transactions.length : undefined;
  const withdrawalsCount = Array.isArray(value.withdrawals) ? value.withdrawals.length : undefined;

  const header: Record<string, unknown> = {};
  const copy = (key: string) => {
    if (key in value) header[key] = value[key];
  };

  copy("number");
  copy("hash");
  copy("parentHash");
  copy("timestamp");
  copy("baseFeePerGas");
  copy("gasLimit");
  copy("gasUsed");
  copy("miner");
  if (transactionsCount !== undefined) header.transactionsCount = transactionsCount;
  if (withdrawalsCount !== undefined) header.withdrawalsCount = withdrawalsCount;
  return header;
}

class HttpPendingTxPoller {
  private mode: PendingPollMode = "filter";
  private filterId: string | undefined = undefined;
  private prevPendingHashes: Set<string> | undefined = undefined;
  private consecutiveFilterFailures = 0;
  private filterResets = 0;

  constructor(
    private readonly client: JsonRpcCaller,
    private readonly options: {
      quiet: boolean;
      setActiveFilterId: (filterId: string | undefined) => void;
    },
  ) {}

  getMode(): PendingPollMode {
    return this.mode;
  }

  async poll(): Promise<{ mode: PendingPollMode; hashes: string[] }> {
    if (this.mode === "pending-block") {
      return { mode: this.mode, hashes: await this.pollPendingBlock() };
    }

    const ready = await this.ensureFilter();
    if (!ready || this.mode !== "filter") {
      return { mode: this.mode, hashes: await this.pollPendingBlock() };
    }

    return { mode: this.mode, hashes: await this.pollFilter() };
  }

  private async ensureFilter(): Promise<boolean> {
    if (this.filterId) return true;

    const maxAttempts = 5;
    let lastError: unknown = undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const filterId = await createPendingTxFilter(this.client);
        this.filterId = filterId;
        this.options.setActiveFilterId(filterId);
        this.consecutiveFilterFailures = 0;
        return true;
      } catch (error) {
        lastError = error;
        if (isMethodUnavailableError(error)) {
          await this.switchToPendingBlock("filter methods unavailable", error);
          return false;
        }
        if (!this.options.quiet) {
          console.error(`Failed to create pending filter (attempt ${attempt}/${maxAttempts}): ${errorSummary(error)}`);
        }
        await sleep(Math.min(3_000, 200 * attempt * attempt));
      }
    }

    await this.switchToPendingBlock("failed to create pending filter", lastError);
    return false;
  }

  private async pollFilter(): Promise<string[]> {
    const filterId = this.filterId;
    if (!filterId) return [];

    try {
      const hashes = await getPendingFilterChanges(this.client, filterId);
      this.consecutiveFilterFailures = 0;
      return hashes;
    } catch (error) {
      if (isFilterNotFoundError(error)) {
        this.filterResets++;
        this.filterId = undefined;
        this.options.setActiveFilterId(undefined);
        if (!this.options.quiet) console.error("Pending filter not found; recreating...");
        if (this.filterResets >= 3) {
          await this.switchToPendingBlock("filter not sticky (frequent resets)", error);
          return [];
        }
        return [];
      }

      this.consecutiveFilterFailures++;
      const shouldFallback = isMethodUnavailableError(error) || this.consecutiveFilterFailures >= 3;
      if (!this.options.quiet) {
        console.error(
          `Filter polling error (${this.consecutiveFilterFailures}): ${errorSummary(error)}${
            shouldFallback ? " (falling back)" : ""
          }`,
        );
      }

      this.filterId = undefined;
      this.options.setActiveFilterId(undefined);

      if (shouldFallback) {
        await this.switchToPendingBlock("filter polling unreliable", error);
      }

      return [];
    }
  }

  private async pollPendingBlock(): Promise<string[]> {
    try {
      const info = await getPendingBlockInfo(this.client);
      const current = new Set(info.hashes);
      const newHashes = this.prevPendingHashes
        ? info.hashes.filter((hash) => !this.prevPendingHashes?.has(hash))
        : info.hashes;
      this.prevPendingHashes = current;
      return newHashes;
    } catch (error) {
      if (!this.options.quiet) console.error(`Pending-block polling error: ${errorSummary(error)}`);
      return [];
    }
  }

  private async switchToPendingBlock(reason: string, error?: unknown): Promise<void> {
    if (this.mode === "pending-block") return;

    if (!this.options.quiet) {
      const suffix = error ? `: ${errorSummary(error)}` : "";
      console.error(`Switching to pending-block polling (${reason}${suffix})`);
    }

    const existingFilter = this.filterId;
    this.filterId = undefined;
    this.options.setActiveFilterId(undefined);

    if (existingFilter) {
      await uninstallFilter(this.client, existingFilter);
    }

    this.mode = "pending-block";
    this.prevPendingHashes = undefined;
  }
}

async function runPendingCountsHttp(
  client: JsonRpcCaller,
  emit: (event: PreviewEvent) => boolean,
  {
    intervalMs,
    quiet,
    setActiveFilterId,
  }: { intervalMs: number; quiet: boolean; setActiveFilterId: (filterId: string | undefined) => void },
): Promise<void> {
  let totalSeen = 0;
  const poller = new HttpPendingTxPoller(client, { quiet, setActiveFilterId });

  while (true) {
    await sleep(intervalMs);
    const polled = await poller.poll();
    const windowCount = polled.hashes.length;
    totalSeen += windowCount;
    const perSecond = windowCount / (intervalMs / 1000);
    const shouldContinue = emit({
      type: "pending_counts",
      ts: new Date().toISOString(),
      data: { intervalMs, pendingCount: windowCount, pendingPerSecond: perSecond, totalSeen },
    });
    if (!shouldContinue) return;
  }
}

async function runPendingRawHttp(
  client: JsonRpcCaller,
  emit: (event: PreviewEvent) => boolean,
  {
    intervalMs,
    quiet,
    setActiveFilterId,
  }: { intervalMs: number; quiet: boolean; setActiveFilterId: (filterId: string | undefined) => void },
): Promise<void> {
  const poller = new HttpPendingTxPoller(client, { quiet, setActiveFilterId });

  while (true) {
    const polled = await poller.poll();
    for (const hash of polled.hashes) {
      const shouldContinue = emit({ type: "pending_raw", ts: new Date().toISOString(), data: { result: hash } });
      if (!shouldContinue) return;
    }
    await sleep(intervalMs);
  }
}

async function runPendingSampleHttp(
  client: JsonRpcCaller,
  emit: (event: PreviewEvent) => boolean,
  {
    intervalMs,
    sampleRate,
    maxSamplesPerInterval,
    maxInflight,
    quiet,
    setActiveFilterId,
  }: {
    intervalMs: number;
    sampleRate: number;
    maxSamplesPerInterval: number;
    maxInflight: number;
    quiet: boolean;
    setActiveFilterId: (filterId: string | undefined) => void;
  },
): Promise<void> {
  let totalSeen = 0;
  let sampleNulls = 0;
  let sampleErrors = 0;
  const samples: TxSummary[] = [];

  const pool = createAsyncPool(maxInflight);

  const enqueueLookup = (hash: string) => {
    pool.enqueue(async () => {
      try {
        const tx = await client.call("eth_getTransactionByHash", [hash]);
        if (tx && typeof tx === "object") {
          samples.push(summarizeTx(tx as RpcTransaction));
        } else {
          sampleNulls++;
        }
      } catch {
        sampleErrors++;
      }
    });
  };

  const poller = new HttpPendingTxPoller(client, { quiet, setActiveFilterId });

  while (true) {
    await sleep(intervalMs);
    const polled = await poller.poll();
    const hashes = polled.hashes;
    const windowPending = hashes.length;
    totalSeen += windowPending;

    let windowSampled = 0;
    for (const hash of hashes) {
      if (windowSampled >= maxSamplesPerInterval) break;
      if (Math.random() > sampleRate) continue;
      windowSampled++;
      enqueueLookup(hash);
    }

    const perSecond = windowPending / (intervalMs / 1000);
    const poolStats = pool.stats();
    const shouldContinue = emit({
      type: "pending_sample",
      ts: new Date().toISOString(),
      data: {
        intervalMs,
        pendingCount: windowPending,
        pendingPerSecond: perSecond,
        totalSeen,
        samples: samples.splice(0, samples.length),
        sampleNulls,
        sampleErrors,
        lookups: poolStats,
      },
    });
    sampleNulls = 0;
    sampleErrors = 0;
    if (!shouldContinue) return;
  }
}

async function runNewHeadsHttp(
  client: JsonRpcCaller,
  emit: (event: PreviewEvent) => boolean,
  { intervalMs }: { intervalMs: number },
): Promise<void> {
  let lastNumber: string | undefined = undefined;

  while (true) {
    let head: unknown;
    try {
      head = summarizeBlockHeader(await client.call("eth_getBlockByNumber", ["latest", false]));
    } catch (error) {
      head = { error: (error as Error).message };
    }

    const number = head && typeof head === "object" ? (head as any).number : undefined;
    if (typeof number === "string" && number === lastNumber) {
      await sleep(intervalMs);
      continue;
    }
    if (typeof number === "string") lastNumber = number;

    const shouldContinue = emit({ type: "new_heads", ts: new Date().toISOString(), data: head });
    if (!shouldContinue) return;
    await sleep(intervalMs);
  }
}

async function runComboHttp(
  client: JsonRpcCaller,
  emit: (event: PreviewEvent) => boolean,
  {
    intervalMs,
    quiet,
    setActiveFilterId,
  }: { intervalMs: number; quiet: boolean; setActiveFilterId: (filterId: string | undefined) => void },
): Promise<void> {
  let totalSeen = 0;
  let lastHead: unknown = undefined;
  let lastHeadNumber: string | undefined = undefined;

  const poller = new HttpPendingTxPoller(client, { quiet, setActiveFilterId });

  while (true) {
    await sleep(intervalMs);

    try {
      const head = summarizeBlockHeader(await client.call("eth_getBlockByNumber", ["latest", false]));
      const num = head && typeof head === "object" ? (head as any).number : undefined;
      if (typeof num === "string" && num !== lastHeadNumber) {
        lastHeadNumber = num;
        lastHead = head;
      }
    } catch {
      // ignore
    }

    const polled = await poller.poll();
    const windowPending = polled.hashes.length;
    totalSeen += windowPending;

    const perSecond = windowPending / (intervalMs / 1000);
    const shouldContinue = emit({
      type: "combo",
      ts: new Date().toISOString(),
      data: { intervalMs, pendingCount: windowPending, pendingPerSecond: perSecond, totalSeen, head: lastHead },
    });
    if (!shouldContinue) return;
  }
}

async function main(): Promise<void> {
  let cliArgs: CliArgs;
  try {
    cliArgs = parseCliArgs(Deno.args);
  } catch (error) {
    console.error((error as Error).message);
    console.error("");
    printHelp();
    Deno.exit(1);
  }

  if (cliArgs.help) {
    printHelp();
    return;
  }

  if (cliArgs.list) {
    listPresets();
    return;
  }

  if (cliArgs.describe) {
    describePreset(cliArgs.describe);
    return;
  }

  const defaultPort = Deno.env.get("PORT") ?? "8000";
  const defaultChainId = Deno.env.get("CHAIN_ID") ?? "1";
  const defaultWsUrl = `ws://127.0.0.1:${defaultPort}/${defaultChainId}`;
  const defaultRpcUrl = `http://127.0.0.1:${defaultPort}/${defaultChainId}`;

  if (cliArgs.wsUrl !== undefined && cliArgs.rpcUrl !== undefined) {
    console.error("Use only one of --ws or --rpc.");
    Deno.exit(1);
  }

  const useHttp = cliArgs.rpcUrl !== undefined;
  const resolvedWsUrl = cliArgs.wsUrl ?? defaultWsUrl;
  const resolvedRpcUrl = cliArgs.rpcUrl ?? defaultRpcUrl;

  if (useHttp) {
    if (!/^https?:\/\//.test(resolvedRpcUrl)) {
      console.error("Expected --rpc to start with http:// or https://");
      Deno.exit(1);
    }
  } else {
    if (!/^wss?:\/\//.test(resolvedWsUrl)) {
      console.error("Expected --ws to start with ws:// or wss://");
      Deno.exit(1);
    }
  }

  if (!Number.isInteger(cliArgs.intervalMs) || cliArgs.intervalMs <= 0) {
    console.error("--interval must be a positive integer (ms).");
    Deno.exit(1);
  }

  if (!Number.isFinite(cliArgs.sampleRate) || cliArgs.sampleRate < 0 || cliArgs.sampleRate > 1) {
    console.error("--sample-rate must be a number between 0 and 1.");
    Deno.exit(1);
  }

  if (!Number.isInteger(cliArgs.maxSamplesPerInterval) || cliArgs.maxSamplesPerInterval < 0) {
    console.error("--max-samples must be a non-negative integer.");
    Deno.exit(1);
  }

  if (!Number.isInteger(cliArgs.maxInflight) || cliArgs.maxInflight <= 0) {
    console.error("--max-inflight must be a positive integer.");
    Deno.exit(1);
  }

  if (!Number.isInteger(cliArgs.maxEvents) || cliArgs.maxEvents < 0) {
    console.error("--max-events must be a non-negative integer.");
    Deno.exit(1);
  }

  let wsClient: JsonRpcWsClient | undefined = undefined;
  const callClient: JsonRpcCaller = useHttp
    ? new JsonRpcHttpClient(resolvedRpcUrl)
    : (wsClient = await JsonRpcWsClient.connect(resolvedWsUrl));
  let activeFilterId: string | undefined = undefined;

  if (!cliArgs.quiet) {
    const redacted = redactUrl(useHttp ? resolvedRpcUrl : resolvedWsUrl);
    console.error(`Connecting to ${redacted} ...`);
    if (useHttp) {
      console.error(
        "Transport: HTTP polling (auto: eth_newPendingTransactionFilter + eth_getFilterChanges; fallback: eth_getBlockByNumber pending)",
      );
    }
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!cliArgs.quiet) console.error("Shutting down...");

    try {
      wsClient?.close();
    } catch {
      // ignore
    }

    try {
      (callClient as any).close?.();
    } catch {
      // ignore
    }

    if (useHttp && activeFilterId) {
      await uninstallFilter(callClient, activeFilterId);
      activeFilterId = undefined;
    }

    Deno.exit(0);
  };

  const emit = createEmitter({
    format: cliArgs.format,
    maxEvents: cliArgs.maxEvents,
    quiet: cliArgs.quiet,
    onStop: () => void shutdown(),
  });
  await emitMeta(callClient, emit);

  Deno.addSignalListener("SIGINT", () => void shutdown());
  Deno.addSignalListener("SIGTERM", () => void shutdown());

  const preset = cliArgs.preset;
  if (!presetNames().includes(preset)) {
    console.error(`Unknown preset: ${preset}`);
    console.error(`Known presets: ${presetNames().join(", ")}`);
    Deno.exit(1);
  }

  if (!cliArgs.quiet) {
    console.error(`Preset: ${preset}`);
  }

  const setActiveFilterId = (filterId: string | undefined) => {
    activeFilterId = filterId;
  };

  if (useHttp) {
    switch (preset) {
      case "pending-counts":
        await runPendingCountsHttp(callClient, emit, {
          intervalMs: cliArgs.intervalMs,
          quiet: cliArgs.quiet,
          setActiveFilterId,
        });
        break;
      case "pending-sample":
        await runPendingSampleHttp(callClient, emit, {
          intervalMs: cliArgs.intervalMs,
          sampleRate: cliArgs.sampleRate,
          maxSamplesPerInterval: cliArgs.maxSamplesPerInterval,
          maxInflight: cliArgs.maxInflight,
          quiet: cliArgs.quiet,
          setActiveFilterId,
        });
        break;
      case "pending-raw":
        await runPendingRawHttp(callClient, emit, {
          intervalMs: cliArgs.intervalMs,
          quiet: cliArgs.quiet,
          setActiveFilterId,
        });
        break;
      case "new-heads":
        await runNewHeadsHttp(callClient, emit, { intervalMs: cliArgs.intervalMs });
        break;
      case "combo":
        await runComboHttp(callClient, emit, {
          intervalMs: cliArgs.intervalMs,
          quiet: cliArgs.quiet,
          setActiveFilterId,
        });
        break;
      case "txpool-status":
        await runTxpoolStatus(callClient, emit, { intervalMs: cliArgs.intervalMs });
        break;
      default:
        throw new Error(`Unhandled preset: ${preset}`);
    }
    return;
  }

  const ws = wsClient;
  if (!ws) {
    console.error("WebSocket client not initialized.");
    Deno.exit(1);
  }

  switch (preset) {
    case "pending-counts":
      await runPendingCounts(ws, emit, { intervalMs: cliArgs.intervalMs, withBody: cliArgs.withBody });
      break;
    case "pending-sample":
      await runPendingSample(ws, emit, {
        intervalMs: cliArgs.intervalMs,
        sampleRate: cliArgs.sampleRate,
        maxSamplesPerInterval: cliArgs.maxSamplesPerInterval,
        maxInflight: cliArgs.maxInflight,
        withBody: cliArgs.withBody,
      });
      break;
    case "pending-raw":
      await runPendingRaw(ws, emit, { withBody: cliArgs.withBody });
      break;
    case "new-heads":
      await runNewHeads(ws, emit);
      break;
    case "combo":
      await runCombo(ws, emit, { intervalMs: cliArgs.intervalMs, withBody: cliArgs.withBody });
      break;
    case "txpool-status":
      await runTxpoolStatus(ws, emit, { intervalMs: cliArgs.intervalMs });
      break;
    default:
      throw new Error(`Unhandled preset: ${preset}`);
  }
}

if (import.meta.main) {
  await main();
}
