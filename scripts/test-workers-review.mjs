import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = resolve(".wrangler/test-artifacts");
await mkdir(root, { recursive: true });
const artifact = await mkdtemp(join(root, "review-"));
const failures = [];
let assertions = 0;
const check = (actual, expected) => {
  assert.deepEqual(actual, expected);
  assertions++;
};
try {
  const bun = process.env.npm_execpath && /\/bun(?:\.exe)?$/.test(process.env.npm_execpath) ? process.env.npm_execpath : "bun";
  check(spawnSync(bun, ["--version"], { encoding: "utf8" }).stdout.trim(), "1.4.0");
  const build = spawnSync(bun, ["build", "packages/permit2-rpc-server/src/worker.ts", "--target=browser", `--outfile=${artifact}/worker.mjs`], {
    stdio: "inherit",
  });
  check(build.status, 0);
  const script = await readFile(`${artifact}/worker.mjs`, "utf8");
  const whitelist = JSON.parse(await readFile("packages/permit2-rpc-server/rpc-whitelist.json", "utf8"));
  const prefix = JSON.parse((await readFile("packages/permit2-rpc-server/src/fixtures/permit2-bytecode.ts", "utf8")).match(/export default (".*");/)[1]);
  const chainsByUrl = Object.fromEntries(Object.entries(whitelist.rpcs).flatMap(([chain, urls]) => urls.map((url) => [new URL(url).href, Number(chain)])));
  const upstream = (
    mode
  ) => `const mode=${JSON.stringify(mode)};const chains=${JSON.stringify(chainsByUrl)};const prefix=${JSON.stringify(prefix)};const first=${JSON.stringify(new URL(whitelist.rpcs["1"][0]).href)};
export default {async fetch(request){
 const body=await request.json();const chain=chains[request.url]||1;
 const result=call=>({jsonrpc:'2.0',id:call.id,result:call.method==='eth_chainId'?'0x'+chain.toString(16):call.method==='eth_getCode'?prefix:call.method==='eth_syncing'?false:'0x1234'});
 if(Array.isArray(body)){
  await new Promise(resolve=>setTimeout(resolve,15));
  if(mode==='per-item-reject')return Response.json(body.map(call=>({jsonrpc:'2.0',id:call.id,error:{code:-32600,message:'Batch unsupported'}})));
  return Response.json(body.map(result));
 }
 if(body.method==='eth_blockNumber'&&request.url===first)return Response.json({jsonrpc:'2.0',id:body.id,error:{code:-32000,message:'Fixture provider failure'}},{status:503});
 return Response.json(result(body));
}};`;
  async function withRuntime(mode, bindings, action) {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
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
            bindings,
          },
          { name: "upstream", modules: true, script: upstream(mode), compatibilityDate: "2026-10-12", compatibilityFlags: ["nodejs_compat"] },
        ],
      })
    );
    try {
      await mf.ready;
      await action(mf);
    } finally {
      await mf.dispose();
    }
  }
  const call = (method = "eth_chainId", id = 1, params = []) => ({ jsonrpc: "2.0", method, id, params });
  async function rpc(mf, chain, body, headers = {}) {
    const response = await mf.dispatchFetch(`https://rpc.test/${chain}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const result = {
      body: await response.json(),
      external: Number(response.headers.get("x-uos-external-subrequests")),
      cache: Number(response.headers.get("x-uos-cache-subrequests") ?? "0"),
      total: Number(response.headers.get("x-uos-budget-subrequests") ?? response.headers.get("x-uos-external-subrequests")),
    };
    check(result.external + result.cache, result.total);
    assert.ok(result.total <= 50);
    assertions++;
    return result;
  }
  async function scenario(name, action) {
    try {
      await action();
      console.log(JSON.stringify({ scenario: name, outcome: "passed" }));
    } catch (error) {
      failures.push({ scenario: name, message: error.message });
      console.error(JSON.stringify(failures.at(-1)));
    }
  }

  await scenario("concurrent-chain-cache-retention", () =>
    withRuntime("batch", {}, async (mf) => {
      const cold = await Promise.all([rpc(mf, 1, call()), rpc(mf, 56, call())]);
      check(
        cold.map((result) => result.body.result),
        ["0x1", "0x38"]
      );
      check(
        cold.map((result) => result.cache),
        [2, 2]
      );
      check(
        cold.map((result) => result.total),
        [35, 34]
      );
      const warm = await Promise.all([rpc(mf, 1, call()), rpc(mf, 56, call())]);
      check(
        warm.map((result) => result.external),
        [1, 1]
      );
      check(
        warm.map((result) => result.cache),
        [1, 1]
      );
      const health = await mf.dispatchFetch("https://rpc.test/health");
      check(Number(health.headers.get("x-uos-cache-subrequests")), Object.keys(whitelist.rpcs).length);
      check(Number(health.headers.get("x-uos-budget-subrequests")), Object.keys(whitelist.rpcs).length);
      const report = await health.json();
      assert.ok(report.chains["1"].lastTested && report.chains["56"].lastTested);
      assertions++;
      console.log(JSON.stringify({ scenario: "concurrent-chain-cache-io", cold, warm }));
    })
  );
  await scenario("per-item-batch-rejection-resumes-singles", () =>
    withRuntime("per-item-reject", {}, async (mf) => {
      const attempts = [];
      let completed = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const response = await rpc(mf, 1, call());
        attempts.push(response);
        check(response.cache, 2);
        assert.ok(response.total <= 50);
        assertions++;
        if (response.body.result === "0x1") {
          completed = true;
          break;
        }
        check(response.body.error.code, -32005);
        assert.match(response.body.error.message, /diagnostics.*incomplete/);
        assertions++;
      }
      check(completed, true);
      check((await rpc(mf, 1, call())).external, 1);
      console.log(JSON.stringify({ scenario: "per-item-rejection-io", attempts }));
    })
  );
  for (const policy of ["sequential", "hedge", "consensus"]) {
    const bindings =
      policy === "hedge"
        ? { RPC_HEDGE_ENABLED: "true", RPC_HEDGE_DELAY_MS: "0" }
        : policy === "consensus"
          ? { RPC_CONSENSUS_ENABLED: "true", RPC_CONSENSUS_METHODS: "eth_getBalance,eth_chainId" }
          : {};
    await scenario(`${policy}-budget-error-identity`, () =>
      withRuntime("batch", bindings, async (mf) => {
        check((await rpc(mf, 1, call())).body.result, "0x1");
        const fallback = await rpc(mf, 1, call("eth_blockNumber"), { "x-ubq-rpc-candidates": whitelist.rpcs["1"].slice(0, 2).join(",") });
        check(fallback.body.result, "0x1234");
        const beforeHealth = await (await mf.dispatchFetch("https://rpc.test/health")).json();
        const failuresBefore = beforeHealth.chains["1"].rpcs.reduce((sum, endpoint) => sum + (endpoint.consecutiveFailures ?? 0), 0);
        const response = await rpc(
          mf,
          1,
          Array.from({ length: 100 }, (_, id) => call("eth_getBalance", id, [`0x${id.toString(16).padStart(40, "0")}`, "latest"]))
        );
        assert.ok(response.total <= 50);
        assertions++;
        const errors = response.body.filter((entry) => entry.error);
        check(response.cache, 1);
        check(response.total, 50);
        assert.ok(errors.length > 0);
        assertions++;
        check([...new Set(errors.map((entry) => entry.error.code))], [-32005]);
        assert.ok(errors.every((entry) => /budget.*exhausted/.test(entry.error.message)));
        assertions++;
        const afterHealth = await (await mf.dispatchFetch("https://rpc.test/health")).json();
        const failuresAfter = afterHealth.chains["1"].rpcs.reduce((sum, endpoint) => sum + (endpoint.consecutiveFailures ?? 0), 0);
        assert.ok(failuresAfter <= failuresBefore, "Resource exhaustion must not penalize provider health");
        assertions++;
        console.log(
          JSON.stringify({
            scenario: `${policy}-budget-io`,
            external: response.external,
            cache: response.cache,
            total: response.total,
            resourceErrors: errors.length,
          })
        );
      })
    );
  }
  console.log(JSON.stringify({ outcome: failures.length ? "failed" : "passed", assertions, failures, runtime: "actual workerd", cpuLimitEnforced: false }));
  if (failures.length) process.exitCode = 1;
} finally {
  await rm(artifact, { recursive: true, force: true });
}
