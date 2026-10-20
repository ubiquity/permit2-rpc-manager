import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const artifactRoot = resolve(".wrangler/test-artifacts");
await mkdir(artifactRoot, { recursive: true });
const artifact = await mkdtemp(join(artifactRoot, "diagnostics-"));
let assertions = 0;
const check = (actual, expected) => {
  assert.deepEqual(actual, expected);
  assertions++;
};
try {
  const bun = process.env.npm_execpath && /\/bun(?:\.exe)?$/.test(process.env.npm_execpath) ? process.env.npm_execpath : "bun";
  check(spawnSync(bun, ["--version"], { encoding: "utf8" }).stdout.trim(), "1.4.0");
  const entry = `import app,{HttpDiagnosticsObject}from${JSON.stringify(resolve("packages/permit2-rpc-server/src/worker.ts"))};
export{HttpDiagnosticsObject};
export class UnknownReceiptObject extends HttpDiagnosticsObject {async getOrRefresh(){throw new Error('deterministic unknown child failure');}}
export class InvalidReceiptObject extends HttpDiagnosticsObject {async getOrRefresh(q){return{requestId:q.requestId,version:q.version,chainId:q.chainId,maxExternalCalls:q.maxExternalCalls,externalCalls:q.maxExternalCalls+1,sqlRowsRead:0,sqlRowsWritten:0,snapshot:null};}}
export default{async fetch(request,env,ctx){
 if(new URL(request.url).pathname==='/__fixture/diagnostics'){
  const{method,name,query}=await request.json();
  try{const stub=env.HTTP_DIAGNOSTICS.getByName(name);return Response.json(await(method==='read'?stub.readSnapshot(query):stub.getOrRefresh(query)));}
  catch(error){return Response.json({error:error.message},{status:400});}
 }
 return app.fetch(request,env,ctx);
}};`;
  await writeFile(`${artifact}/entry.ts`, entry);
  const build = spawnSync(bun, ["build", `${artifact}/entry.ts`, "--target=browser", "--external=cloudflare:workers", `--outfile=${artifact}/worker.mjs`], {
    stdio: "inherit",
  });
  check(build.status, 0);
  const script = await readFile(`${artifact}/worker.mjs`, "utf8");
  const whitelist = JSON.parse(await readFile("packages/permit2-rpc-server/rpc-whitelist.json", "utf8"));
  const prefix = JSON.parse((await readFile("packages/permit2-rpc-server/src/fixtures/permit2-bytecode.ts", "utf8")).match(/export default (".*");/)[1]);
  const chains = Object.fromEntries(Object.entries(whitelist.rpcs).flatMap(([chain, urls]) => urls.map((url) => [new URL(url).href, Number(chain)])));
  const upstream = (
    mode
  ) => `const chains=${JSON.stringify(chains)},prefix=${JSON.stringify(prefix)},mode=${JSON.stringify(mode)},first=${JSON.stringify(whitelist.rpcs["1"].slice(0, 3).map((url) => new URL(url).href))};let calls=0,active=0;const checks={},foreground=[],lifecycle=[];
export default{async fetch(request){
 if(new URL(request.url).pathname==='/__metrics')return Response.json({calls,checks,foreground,active,lifecycle});
 calls++;const url=new URL(request.url),redirected=url.searchParams.has('fixture_redirect');url.searchParams.delete('fixture_redirect');const key=url.href;
 if(mode==='redirect'&&!redirected){url.searchParams.set('fixture_redirect','1');return new Response(null,{status:307,headers:{location:url.href}});}
 const body=await request.json(),chain=chains[key]||1;
 const result=call=>({jsonrpc:'2.0',id:call.id,result:mode==='mixed'&&call.method==='eth_getCode'&&key===first[0]?'0x1234':mode==='mixed'&&call.method==='eth_syncing'&&key===first[1]?true:mode==='mixed'&&call.method==='eth_chainId'&&key===first[2]?'0x2':call.method==='eth_chainId'?'0x'+chain.toString(16):call.method==='eth_syncing'?false:call.method==='eth_getCode'?prefix:'0x1234'});
 if(Array.isArray(body)){
  await new Promise(resolve=>setTimeout(resolve,10));checks[key]=body.map(call=>call.method).sort();
  if(mode==='per-item-reject'||mode==='early-failure')return Response.json(body.map(call=>({jsonrpc:'2.0',id:call.id,error:{code:-32600,message:'batch unsupported'}})));
 }
 if(mode==='early-failure'&&!Array.isArray(body)){
  if(redirected)return Response.json(result(body));
  lifecycle.push({method:body.method,event:'start',at:Date.now()});
  if(body.method==='eth_getCode'){await new Promise(resolve=>setTimeout(resolve,50));lifecycle.push({method:body.method,event:'failed',at:Date.now()});return new Response('deterministic fast failure',{status:503});}
  active++;
  if(body.method==='eth_syncing')return new Response(new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(result(body))));controller.close();active--;lifecycle.push({method:body.method,event:'body-complete',at:Date.now()});},300);}}),{headers:{'content-type':'application/json'}});
  await new Promise(resolve=>setTimeout(resolve,300));active--;lifecycle.push({method:body.method,event:'headers-complete',at:Date.now()});
  url.searchParams.set('fixture_redirect','1');return new Response(null,{status:307,headers:{location:url.href}});
 }
 if(!Array.isArray(body)&&typeof body.id==='number')foreground.push({url:key,method:body.method});
 return Response.json(Array.isArray(body)?body.map(result):result(body));
}};`;

  async function runtime(mode, action, extraBindings = {}) {
    let version = randomUUID();
    const options = () =>
      convertV4MiniflareOptions({
        host: "127.0.0.1",
        port: 0,
        unsafeInspectDurableObjects: true,
        workers: [
          {
            name: "rpc",
            modules: true,
            script,
            compatibilityDate: "2026-10-12",
            compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
            outboundService: "upstream",
            bindings: { VERSION_METADATA: { id: version }, ...extraBindings },
            durableObjects: {
              HTTP_DIAGNOSTICS: {
                className: mode === "unknown" ? "UnknownReceiptObject" : mode === "invalid-receipt" ? "InvalidReceiptObject" : "HttpDiagnosticsObject",
                useSQLite: true,
              },
            },
          },
          { name: "upstream", modules: true, script: upstream(mode), compatibilityDate: "2026-10-12", compatibilityFlags: ["nodejs_compat"] },
        ],
      });
    const mf = new Miniflare(options());
    const metrics = async () => (await (await mf.getWorker("upstream")).fetch("https://upstream.test/__metrics")).json();
    const rpc = async (body = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) => {
      const before = (await metrics()).calls;
      const response = await mf.dispatchFetch("https://rpc.test/1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const read = (key) => Number(response.headers.get(`x-uos-${key}`));
      const result = {
        body: await response.json(),
        external: read("external-subrequests"),
        front: read("front-subrequests"),
        child: read("child-subrequests"),
        cache: read("cache-subrequests"),
        binding: read("binding-subrequests"),
        total: read("budget-subrequests"),
        unverified: read("unverified-children"),
        rowsRead: read("sql-rows-read"),
        rowsWritten: read("sql-rows-written"),
      };
      check(result.external, result.front + result.child);
      check(result.total, result.external + result.cache + result.binding);
      assert.ok(result.total <= 50);
      assertions++;
      const actual = (await metrics()).calls - before;
      if (result.unverified) {
        assert.ok(result.external >= actual);
        assertions++;
      } else check(result.external, actual);
      return result;
    };
    const inspect = async () => {
      const found = [];
      for (const id of await mf.listDurableObjectIds("HTTP_DIAGNOSTICS", "rpc")) {
        const storage = await mf.unsafeGetDurableObjectStorage("rpc", "HttpDiagnosticsObject", { id });
        const rows = await storage.exec("SELECT fingerprint,snapshot FROM diagnostics");
        if (rows.length) found.push({ id, storage, rows });
      }
      return found;
    };
    const direct = async (name, overrides = {}, method = "refresh") => {
      const query = {
        requestId: randomUUID(),
        version,
        chainId: 1,
        validateChainId: true,
        timeoutMs: 5000,
        disableCache: false,
        ...(method === "refresh" ? { maxExternalCalls: 48, eligibleIndices: whitelist.rpcs["1"].map((_url, index) => index) } : {}),
        ...overrides,
      };
      const response = await mf.dispatchFetch("https://rpc.test/__fixture/diagnostics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, query, method }),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      await mf.ready;
      await action({
        mf,
        rpc,
        metrics,
        inspect,
        direct,
        async nextVersion() {
          version = randomUUID();
          await mf.setOptions(options());
        },
        version: () => version,
      });
    } finally {
      await mf.dispose();
    }
  }

  await runtime("early-failure", async ({ direct, metrics }) => {
    const reply = await direct("settle-siblings", { eligibleIndices: [0], maxExternalCalls: 6 });
    check(reply.status, 200);
    const observed = await metrics();
    check(observed.lifecycle.filter(({ event }) => event === "start").length, 3);
    console.log(
      JSON.stringify({
        scenario: "failed-diagnostic-awaits-sibling-headers-and-bodies",
        receiptCalls: reply.body.externalCalls,
        actualCalls: observed.calls,
        activeAfterReply: observed.active,
        activeWallMs: reply.body.activeWallMs,
        lifecycle: observed.lifecycle,
      })
    );
    check(reply.body.externalCalls, observed.calls);
    check(observed.calls, 5);
    check(observed.active, 0);
    assert.ok(reply.body.activeWallMs >= 250, "Receipt returned before the delayed sibling diagnostics settled");
    assertions++;
  });

  await runtime("batch", async ({ mf, rpc, metrics, inspect, nextVersion }) => {
    const before = (await metrics()).calls;
    const emptyHealth = await mf.dispatchFetch("https://rpc.test/health");
    check(emptyHealth.status, 200);
    check((await metrics()).calls, before);
    check(Number(emptyHealth.headers.get("x-uos-binding-subrequests")), Object.keys(whitelist.rpcs).length);
    check(Number(emptyHealth.headers.get("x-uos-sql-rows-written")), 0);
    const cold = await rpc();
    check(cold.body.result, "0x1");
    check(cold.front, 1);
    check(cold.child, whitelist.rpcs["1"].length);
    check(cold.cache, 0);
    check(cold.binding, 1);
    check(cold.total, whitelist.rpcs["1"].length + 2);
    const native = await metrics();
    for (const url of whitelist.rpcs["1"]) check(native.checks[new URL(url).href], ["eth_chainId", "eth_getCode", "eth_syncing"]);
    const warm = await rpc();
    check(warm.body.result, "0x1");
    check(warm.child, 0);
    check(warm.total, 2);
    check(warm.rowsWritten, 0);
    let stored = await inspect();
    check(stored.length, 1);
    check(stored[0].rows.length, 1);
    check(Object.keys(JSON.parse(stored[0].rows[0].snapshot).latencyMap).length, whitelist.rpcs["1"].length);
    await mf.unsafeEvictDurableObject("rpc", "HttpDiagnosticsObject", { id: stored[0].id });
    check((await rpc()).child, 0);
    stored = await inspect();
    await stored[0].storage.exec("UPDATE diagnostics SET snapshot=json_set(snapshot,'$.lastTested',?)", Date.now() - 4 * 60 * 60 * 1000 - 1000);
    check((await rpc()).child, whitelist.rpcs["1"].length);
    const idsBefore = await mf.listDurableObjectIds("HTTP_DIAGNOSTICS", "rpc");
    for (let index = 0; index < 4; index++) {
      await nextVersion();
      check((await rpc()).child, whitelist.rpcs["1"].length);
      for (const entry of await inspect()) {
        assert.ok(entry.rows.length <= 2);
        assertions++;
      }
    }
    check((await mf.listDurableObjectIds("HTTP_DIAGNOSTICS", "rpc")).sort(), idsBefore.sort());
    const callsBeforeHealth = (await metrics()).calls;
    const health = await mf.dispatchFetch("https://rpc.test/health");
    check(health.status, 200);
    check((await metrics()).calls, callsBeforeHealth);
    check(Number(health.headers.get("x-uos-sql-rows-written")), 0);
    console.log(
      JSON.stringify({
        scenario: "sqlite-cold-warm-expiry-restart-version-bound-and-read-only-health",
        cold,
        warm,
        rowsPerObjectBound: 2,
        objectNamesVersionIndependent: true,
      })
    );
  });

  await runtime("batch", async ({ direct }) => {
    const count = whitelist.rpcs["1"].length,
      indices = Array.from({ length: count }, (_v, i) => i);
    const deferred = await direct("all-health-deferred", { eligibleIndices: [] });
    check(deferred.status, 200);
    check(deferred.body.externalCalls, 0);
    check(deferred.body.sqlRowsWritten, 0);
    check(deferred.body.snapshot.latencyMap, {});
    check(deferred.body.snapshot.diagnosticsComplete, false);
    const partial = await direct("partial", { maxExternalCalls: 6 });
    check(partial.status, 200);
    check(partial.body.externalCalls, 6);
    check(partial.body.error.code, -32005);
    const attempts = [partial.body.externalCalls];
    let complete = partial.body.snapshot.diagnosticsComplete;
    for (let index = 0; index < 8 && !complete; index++) {
      const result = await direct("partial", { maxExternalCalls: 6 });
      check(result.status, 200);
      assert.ok(result.body.externalCalls <= 6);
      assertions++;
      attempts.push(result.body.externalCalls);
      complete = result.body.snapshot.diagnosticsComplete;
    }
    check(complete, true);
    check((await direct("partial")).body.externalCalls, 0);
    const halves = [indices.slice(0, count / 2), indices.slice(count / 2)];
    const simultaneous = await Promise.all(halves.map((eligibleIndices) => direct("concurrent", { eligibleIndices })));
    check(
      simultaneous.map((entry) => entry.status),
      [200, 200]
    );
    const merged = await direct("concurrent");
    check(merged.body.externalCalls, 0);
    check(Object.keys(merged.body.snapshot.latencyMap).length, count);
    for (const invalid of [
      { eligibleIndices: [count] },
      { eligibleIndices: [0, 0] },
      { maxExternalCalls: 49 },
      { url: "https://arbitrary.invalid" },
      { headers: { authorization: "not-permitted" } },
      { body: { method: "eth_sendRawTransaction" } },
    ])
      check((await direct("invalid", invalid)).status, 400);
    const cacheOff1 = await direct("cache-off", { disableCache: true }),
      cacheOff2 = await direct("cache-off", { disableCache: true });
    check(cacheOff1.body.externalCalls, count);
    check(cacheOff2.body.externalCalls, count);
    check(cacheOff2.body.sqlRowsWritten, 0);
    check((await direct("cache-off", {}, "read")).body.snapshot, null);
    console.log(
      JSON.stringify({
        scenario: "full-progress-concurrent-merge-compiled-only-api-and-cache-disable",
        attempts,
        mergedEntries: Object.keys(merged.body.snapshot.latencyMap).length,
      })
    );
  });

  await runtime("mixed", async ({ rpc, inspect, metrics }) => {
    const response = await rpc();
    check(response.body.result, "0x1");
    const snapshot = JSON.parse((await inspect())[0].rows[0].snapshot);
    const urls = whitelist.rpcs["1"];
    check(snapshot.latencyMap[urls[0]].status, "wrong_bytecode");
    check(snapshot.latencyMap[urls[1]].status, "syncing");
    check(snapshot.latencyMap[urls[2]].status, "wrong_chain_id");
    assert.ok(!urls.slice(0, 3).includes(snapshot.fastestRpc));
    assertions++;
    assert.ok(
      !(await metrics()).foreground.some(({ url }) =>
        urls
          .slice(0, 3)
          .map((value) => new URL(value).href)
          .includes(url)
      )
    );
    assertions++;
    console.log(
      JSON.stringify({ scenario: "native-status-priority-and-foreground-frontier", statuses: urls.slice(0, 3).map((url) => snapshot.latencyMap[url].status) })
    );
  });

  await runtime(
    "mixed",
    async ({ rpc, inspect, metrics }) => {
      const response = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
      check(response.body.result, "0x1234");
      const snapshot = JSON.parse((await inspect())[0].rows[0].snapshot);
      const urls = whitelist.rpcs["1"];
      check(snapshot.latencyMap[urls[0]].status, "wrong_bytecode");
      check(snapshot.latencyMap[urls[1]].status, "syncing");
      check(snapshot.latencyMap[urls[2]].status, "ok");
      const native = await metrics();
      for (const url of urls) check(native.checks[new URL(url).href], ["eth_getCode", "eth_syncing"]);
    },
    { RPC_VALIDATE_CHAIN_ID: "n" }
  );

  for (const mode of ["per-item-reject", "redirect"])
    await runtime(mode, async ({ rpc }) => {
      const attempts = [];
      let complete = false;
      for (let index = 0; index < 8; index++) {
        const result = await rpc();
        attempts.push(result);
        check(result.cache, 0);
        check(result.binding, 1);
        if (result.body.result === "0x1") {
          complete = true;
          break;
        }
        check(result.body.error.code, -32005);
      }
      check(complete, true);
      const warm = await rpc();
      check(warm.child, 0);
      check(warm.total, mode === "redirect" ? 3 : 2);
      console.log(JSON.stringify({ scenario: `${mode}-progress-and-shared50`, attempts }));
    });

  for (const mode of ["unknown", "invalid-receipt"])
    await runtime(mode, async ({ rpc, metrics }) => {
      const result = await rpc();
      check(result.body.error.code, -32005);
      check(result.child, 48);
      check(result.binding, 1);
      check(result.total, 49);
      check(result.unverified, 1);
      check((await metrics()).calls, 0);
      console.log(JSON.stringify({ scenario: `${mode}-retains-full-reservation`, result, actualChildOutbound: 0 }));
    });
  console.log(JSON.stringify({ outcome: "passed", assertions, runtime: "actual workerd with SQLite Durable Objects", cpuLimitEnforced: false }));
} finally {
  await rm(artifact, { recursive: true, force: true });
}
