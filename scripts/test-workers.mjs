import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { encodeFunctionResult } from "viem";

const artifactRoot = resolve(".wrangler/test-artifacts");
await mkdir(artifactRoot, { recursive: true });
const artifact = await mkdtemp(join(artifactRoot, "run-"));
try {
  const bun = process.env.npm_execpath && /\/bun(?:\.exe)?$/.test(process.env.npm_execpath) ? process.env.npm_execpath : "bun";
  const bunVersion = spawnSync(bun, ["--version"], { encoding: "utf8" });
  assert.equal(bunVersion.status, 0);
  assert.equal(bunVersion.stdout.trim(), "1.4.0", "Use the repository-pinned Bun 1.4.0 for Worker bundling");
  const build = spawnSync(bun, ["build", "packages/permit2-rpc-server/src/worker.ts", "--target=browser", `--outfile=${artifact}/worker.mjs`], {
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const script = await readFile(`${artifact}/worker.mjs`, "utf8");
  const prefix = JSON.parse((await readFile("packages/permit2-rpc-server/src/fixtures/permit2-bytecode.ts", "utf8")).match(/export default (".*");/)[1]);
  const whitelist = JSON.parse(await readFile("packages/permit2-rpc-server/rpc-whitelist.json", "utf8"));
  const aggregateResult = encodeFunctionResult({
    abi: [
      {
        type: "function",
        name: "aggregate3",
        inputs: [],
        outputs: [
          {
            type: "tuple[]",
            components: [
              { name: "success", type: "bool" },
              { name: "returnData", type: "bytes" },
            ],
          },
        ],
      },
    ],
    functionName: "aggregate3",
    result: [
      [
        { success: true, returnData: "0x01" },
        { success: true, returnData: "0x02" },
      ],
    ],
  });
  let assertions = 0;
  const check = (actual, expected) => {
    assert.deepEqual(actual, expected);
    assertions++;
  };

  function upstreamScript(mode, chainId) {
    return `const prefix=${JSON.stringify(prefix)}; const mode=${JSON.stringify(mode)}; const chainId=${chainId};
const firstHttp=${JSON.stringify(new URL(whitelist.rpcs[String(chainId)][0]).href)};
const firstWs=${JSON.stringify(new URL(whitelist.wss[String(chainId)][0]).href)};
let calls=0;let upgrades=0;
const result=(call)=>({jsonrpc:'2.0',id:call.id,result:call.method==='eth_chainId'?'0x'+chainId.toString(16):call.method==='eth_syncing'?false:call.method==='eth_getCode'?prefix:call.method==='eth_getFilterChanges'?[]:call.method==='eth_call'?${JSON.stringify(aggregateResult)}:'0x1234'});
export default { async fetch(request,env,ctx) {
 if(new URL(request.url).pathname==='/__metrics')return Response.json({calls,upgrades});
 calls++;
 if(request.headers.get('upgrade')==='websocket') {
  upgrades++;
  if(mode==='ws-fallback' && request.url.replace(/^http/,'ws')===firstWs) return new Response('unavailable',{status:503});
  if(mode==='ws-handshake-timeout' && request.url.replace(/^http/,'ws')===firstWs) {
   await new Promise(resolve=>setTimeout(resolve,10000));
   return new Response('handshake stalled',{status:503});
  }
  const pair=new WebSocketPair(); pair[1].binaryType='arraybuffer'; pair[1].accept();
  pair[1].addEventListener('message',event=>{
   if(typeof event.data!=='string'){pair[1].send(event.data);return;}
   const call=JSON.parse(event.data);pair[1].send(JSON.stringify(call.method==='eth_subscribe'?{jsonrpc:'2.0',id:call.id,result:'fixture-subscription'}:result(call)));
   if(call.method==='eth_subscribe')ctx.waitUntil(new Promise(resolve=>setTimeout(()=>{try{pair[1].send(JSON.stringify({jsonrpc:'2.0',method:'eth_subscription',params:{subscription:'fixture-subscription',result:{number:'0x1234'}}}));}finally{resolve();}},mode==='ws-fallback'?6500:30)));
  });
  pair[1].addEventListener('close',()=>{try{pair[1].close();}catch{}});
  return new Response(null,{status:101,webSocket:pair[0]});
 }
 const body=await request.json();
 if(Array.isArray(body)&&mode==='batch-reject')return Response.json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Batch unsupported'}});
 if(!Array.isArray(body)&&body.method==='eth_getFilterChanges')await new Promise(resolve=>setTimeout(resolve,40));
 if(!Array.isArray(body)&&body.method==='eth_blockNumber'&&mode==='fallback'&&request.url===firstHttp)return Response.json({jsonrpc:'2.0',id:body.id,error:{code:-32000,message:'fixture provider unavailable'}},{status:503});
 return Response.json(Array.isArray(body)?body.map(result):result(body));
} };`;
  }

  async function withRuntime(mode, chainId, action) {
    const options = convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      workers: [
        {
          name: "rpc",
          modules: true,
          script,
          compatibilityDate: "2026-10-12",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public", "no_cots_on_external_fetch"],
          outboundService: "upstream",
          versionMetadata: "VERSION_METADATA",
          assets: {
            directory: resolve("packages/permit2-rpc-server/static"),
            binding: "ASSETS",
            run_worker_first: true,
            routerConfig: { has_user_worker: true },
          },
        },
        { name: "upstream", modules: true, script: upstreamScript(mode, chainId), compatibilityDate: "2026-10-12", compatibilityFlags: ["nodejs_compat"] },
      ],
    });
    const mf = new Miniflare(options);
    try {
      await mf.ready;
      await action(mf);
    } finally {
      await mf.dispose();
    }
  }

  async function rpc(mf, chainId, body, headers = {}) {
    const response = await mf.dispatchFetch(`https://rpc.test/${chainId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const used = Number(response.headers.get("x-uos-external-subrequests"));
    const cache = Number(response.headers.get("x-uos-cache-subrequests"));
    const total = Number(response.headers.get("x-uos-budget-subrequests"));
    check(total, used + cache);
    assert.ok(total <= 50, `Fetch and Cache API budget exceeded: ${total}`);
    assertions++;
    return { response, body: response.status === 204 ? undefined : await response.json(), used, cache, total };
  }
  async function metrics(mf) {
    return (await (await mf.getWorker("upstream")).fetch("https://metrics.test/__metrics")).json();
  }
  const call = (method = "eth_chainId", id = 1, params = []) => ({ jsonrpc: "2.0", method, id, params });
  const message = (socket, predicate = () => true, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.removeEventListener("message", listener);
        reject(new Error("WebSocket fixture deadline"));
      }, timeoutMs);
      const listener = (event) => {
        if (!predicate(event.data)) return;
        clearTimeout(timeout);
        socket.removeEventListener("message", listener);
        resolve(event.data);
      };
      socket.addEventListener("message", listener);
    });

  for (const chainId of [1, 56, 8453]) {
    await withRuntime("batch", chainId, async (mf) => {
      const first = await rpc(mf, chainId, call());
      check(first.body.result, `0x${chainId.toString(16)}`);
      check(first.used, whitelist.rpcs[String(chainId)].length + 1);
      check((await metrics(mf)).calls, first.used);
      const cached = await rpc(mf, chainId, call());
      check(cached.used, 1);
      check(first.cache, 2);
      check(cached.cache, 1);
      console.log(
        JSON.stringify({
          runtime: "workerd",
          scenario: "full-cold-and-cached",
          chainId,
          externalSubrequests: first.used,
          cacheSubrequests: first.cache,
          totalSubrequests: first.total,
          cachedSubrequests: cached.total,
        })
      );
    });
  }
  await withRuntime("batch-reject", 1, async (mf) => {
    const attempts = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await rpc(mf, 1, call());
      attempts.push(result.used);
      if (result.body.result === "0x1") break;
      assert.match(result.body.error.message, /diagnostics.*incomplete/);
      assertions++;
    }
    const cached = await rpc(mf, 1, call());
    check(cached.body.result, "0x1");
    check(cached.used, 1);
    console.log(JSON.stringify({ runtime: "workerd", scenario: "batch-rejection-resumes-complete-whitelist", attempts, cachedSubrequests: cached.used }));
  });
  await withRuntime("fallback", 1, async (mf) => {
    await rpc(mf, 1, call());
    const result = await rpc(mf, 1, call("eth_blockNumber"), { "x-ubq-rpc-candidates": whitelist.rpcs["1"].slice(0, 2).join(",") });
    check(result.body.result, "0x1234");
    check(result.used, 2);
    const health = await (await mf.dispatchFetch("https://rpc.test/health")).json();
    check(health.chains["1"].rpcs[0].consecutiveFailures, 1);
    const preflight = await mf.dispatchFetch("https://rpc.test/1", { method: "OPTIONS" });
    check(preflight.status, 204);
    check(preflight.headers.get("access-control-allow-origin"), "*");
    for (const path of ["/", "/app.css", "/app.js", "/logo.svg"]) {
      const response = await mf.dispatchFetch(`https://rpc.test${path}`);
      check(response.status, 200);
      assert.ok((await response.text()).length > 0);
      assertions++;
      const head = await mf.dispatchFetch(`https://rpc.test${path}`, { method: "HEAD" });
      check(head.status, 200);
      check(await head.text(), "");
    }
    for (const method of ["initialize", "tools/list"]) {
      const mcp = await rpc(mf, "", call(method));
      check(mcp.response.status, 200);
      assert.ok(mcp.body.result);
      assertions++;
    }
    const mcp = await rpc(mf, 1, { jsonrpc: "2.0", id: null, method: "tools/call", params: { name: "eth_chainId", arguments: {} } });
    check(JSON.parse(mcp.body.result.content[0].text), "0x1");
    const batch = await rpc(mf, 1, [call("eth_chainId", 0), { jsonrpc: "2.0", method: "eth_chainId" }, call("eth_chainId", null), 5]);
    check(
      batch.body.map((entry) => entry.id),
      [0, null, null]
    );
    check((await rpc(mf, 1, { jsonrpc: "2.0", method: "eth_chainId" })).response.status, 204);
    const multicall = await rpc(mf, 1, [
      call("eth_call", 4, [{ to: "0x0000000000000000000000000000000000000001", data: "0x01" }, "latest"]),
      call("eth_call", 4, [{ to: "0x0000000000000000000000000000000000000002", data: "0x02" }, "latest"]),
    ]);
    check(
      multicall.body.map((entry) => entry.result),
      ["0x01", "0x02"]
    );
    const delayed = await rpc(mf, 1, call("eth_getFilterChanges", 8, ["0x1"]));
    check(delayed.body.result, []);
    const [a, b] = await Promise.all([rpc(mf, 1, call("eth_chainId", 9)), rpc(mf, 1, call("eth_chainId", 10))]);
    check(a.body.result, "0x1");
    check(b.body.result, "0x1");
    const bounded = await rpc(
      mf,
      1,
      Array.from({ length: 100 }, (_, index) => call("eth_getBalance", index, [`0x${index.toString(16).padStart(40, "0")}`, "latest"]))
    );
    check(bounded.used, 49);
    check(bounded.cache, 1);
    check(bounded.total, 50);
    check(bounded.body.length, 100);
    check(bounded.body.filter((entry) => entry.error?.code === -32005).length, 51);
    console.log(JSON.stringify({ runtime: "workerd", scenario: "http-mcp-assets-cors-fallback-filter-and-concurrency", assertions }));
  });
  await withRuntime("ws-fallback", 1, async (mf) => {
    const response = await mf.dispatchFetch("https://rpc.test/1", { headers: { Upgrade: "websocket" } });
    check(response.status, 101);
    const socket = response.webSocket;
    assert.ok(socket);
    socket.accept();
    try {
      const chain = message(socket);
      socket.send(JSON.stringify(call()));
      check(JSON.parse(await chain).result, "0x1");
      console.log(JSON.stringify({ scenario: "websocket-chain-response" }));
      const subscribed = message(socket, (data) => typeof data === "string" && JSON.parse(data).id === 2);
      const event = message(socket, (data) => typeof data === "string" && JSON.parse(data).method === "eth_subscription", 10000);
      const subscriptionStarted = Date.now();
      socket.send(JSON.stringify(call("eth_subscribe", 2, ["newHeads"])));
      check(JSON.parse(await subscribed).result, "fixture-subscription");
      check(JSON.parse(await event).params.result.number, "0x1234");
      const eventDelayMs = Date.now() - subscriptionStarted;
      assert.ok(eventDelayMs >= 6000, `Expected a subscription event after the handshake timeout, received at ${eventDelayMs}ms`);
      assertions++;
      check(socket.readyState, 1);
      console.log(JSON.stringify({ scenario: "websocket-subscription-event-after-handshake-timeout", eventDelayMs }));
      const binary = message(socket, (data) => typeof data !== "string");
      socket.send(new Uint8Array([1, 2, 3]));
      const payload = await binary;
      const bytes =
        payload instanceof ArrayBuffer
          ? new Uint8Array(payload)
          : ArrayBuffer.isView(payload)
            ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
            : new Uint8Array(await payload.arrayBuffer());
      check([...bytes], [1, 2, 3]);
      const native = await metrics(mf);
      check(native.upgrades, 3);
      console.log(
        JSON.stringify({ runtime: "workerd", scenario: "websocket-ranked-fallback-queue-subscription-binary", externalUpgrades: native.upgrades, assertions })
      );
    } finally {
      const closed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket normal close deadline")), 2000);
        socket.addEventListener(
          "close",
          (event) => {
            clearTimeout(timer);
            resolve(event);
          },
          { once: true }
        );
      });
      socket.close(1000, "native test complete");
      check((await closed).code, 1000);
    }
  });
  await withRuntime("ws-handshake-timeout", 1, async (mf) => {
    const started = Date.now();
    const response = await mf.dispatchFetch("https://rpc.test/1", { headers: { Upgrade: "websocket" } });
    check(response.status, 101);
    const socket = response.webSocket;
    assert.ok(socket);
    socket.accept();
    try {
      const chain = message(socket, () => true, 12000);
      socket.send(JSON.stringify(call()));
      check(JSON.parse(await chain).result, "0x1");
      const elapsedMs = Date.now() - started;
      assert.ok(elapsedMs >= 4500 && elapsedMs < 9000, `Expected 5000ms handshake timeout and ranked fallback, completed at ${elapsedMs}ms`);
      assertions++;
      check((await metrics(mf)).upgrades, 3);
      console.log(
        JSON.stringify({ runtime: "workerd", scenario: "stalled-websocket-handshake-times-out-and-ranked-fallback-succeeds", elapsedMs, assertions })
      );
    } finally {
      socket.close(1000, "handshake control complete");
    }
  });
  console.log(JSON.stringify({ outcome: "passed", assertions, runtime: "actual workerd", cpuLimitEnforced: false }));
} finally {
  await rm(artifact, { recursive: true, force: true });
}
