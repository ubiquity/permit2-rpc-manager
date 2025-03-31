import fs from 'fs/promises'; // To read the whitelist
import path from 'path';
import puppeteer from 'puppeteer';

// --- Configuration ---
const PROXY_URL = "https://permit2-rpc-proxy-khcj5qav1k79.deno.dev"; // Your deployed proxy
const CHAIN_ID = 100; // Gnosis
const NUM_RUNS = 5; // Number of times to run each scenario for averaging
const RPC_METHOD = "eth_blockNumber";
const RPC_PARAMS = [];
const WHITELIST_PATH = path.resolve('./packages/permit2-rpc-server/rpc-whitelist.json'); // Path to whitelist
// --- End Configuration ---

// Helper to read whitelist
async function getWhitelistUrls(chainId) {
  try {
    const content = await fs.readFile(WHITELIST_PATH, 'utf-8');
    const data = JSON.parse(content);
    return data?.rpcs?.[String(chainId)] || [];
  } catch (error) {
    console.error(`Failed to read or parse whitelist at ${WHITELIST_PATH}:`, error);
    return [];
  }
}

// Test function for the NEW SDK/Proxy approach
async function testProxyPerformance(page, proxyUrl, chainId, method, params, numRuns) {
  console.log(`\nTesting ${numRuns} requests via Proxy: ${proxyUrl} (Chain ${chainId})`);

  const results = await page.evaluate(async (url, chain, m, p, count) => {
    const runTimings = [];
    let totalSuccessCount = 0;
    let firstRunError = null;

    for (let run = 0; run < count; run++) {
      const start = performance.now();
      try {
        const response = await fetch(`${url}/rpc/${chain}`, { // Use proxy format
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: m, params: p, id: `proxy-${run}` }),
        });
        const duration = performance.now() - start;

        if (!response.ok) {
          throw new Error(`HTTP error ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
          throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
        }
        runTimings.push(duration);
        totalSuccessCount++;
      } catch (error) {
        if (!firstRunError) firstRunError = error.message;
        runTimings.push(null); // Indicate failure for this run
      }
    }

    const successfulTimings = runTimings.filter(t => t !== null);
    const avgTiming = successfulTimings.length > 0
      ? successfulTimings.reduce((a, b) => a + b, 0) / successfulTimings.length
      : null;

    return {
      target: "Proxy",
      totalRuns: count,
      successfulRuns: totalSuccessCount,
      averageLatencyMs: avgTiming ? avgTiming.toFixed(2) : 'N/A',
      firstErrorMessage: firstRunError,
    };
  }, proxyUrl, chainId, method, params, numRuns);

  console.log(`- Successful: ${results.successfulRuns} / ${results.totalRuns}`);
  console.log(`- Average Latency: ${results.averageLatencyMs} ms`);
  if (results.firstErrorMessage) {
    console.log(`- First Error: ${results.firstErrorMessage}`);
  }
  return results;
}

// Test function simulating OLD client logic (direct calls, stop on first success)
async function testSimulatedOldLogic(page, rpcUrls, chainId, method, params, numRuns) {
  console.log(`\nTesting ${numRuns} runs using Simulated Old Logic (Chain ${chainId})`);
  console.log(`- Attempting direct calls to ${rpcUrls.length} whitelisted RPCs...`);

  const results = await page.evaluate(async (urls, chain, m, p, count) => {
    const runTimings = [];
    let totalSuccessCount = 0;
    let firstRunError = null;
    let totalAttempts = 0;

    for (let run = 0; run < count; run++) {
      const start = performance.now();
      let runSucceeded = false;
      let runError = null;
      let attemptsThisRun = 0;

      for (const rpcUrl of urls) {
        attemptsThisRun++;
        totalAttempts++;
        try {
          const response = await fetch(rpcUrl, { // Direct call
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: m, params: p, id: `direct-${run}-${attemptsThisRun}` }),
            // Add a short timeout signal? Maybe not needed if we stop on first success
          });

          if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
          }
          const data = await response.json();
          if (data.error) {
            throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
          }

          // SUCCESS! Stop trying other RPCs for this run
          const duration = performance.now() - start;
          runTimings.push(duration);
          totalSuccessCount++;
          runSucceeded = true;
          break; // Exit inner loop (RPC URL loop)

        } catch (error) {
          runError = error.message; // Store last error for this run
          // Continue to next RPC URL
        }
      } // End RPC URL loop

      if (!runSucceeded) {
        if (!firstRunError) firstRunError = runError; // Store first overall run error
        runTimings.push(null); // Indicate failure for this run
      }
    } // End run loop

    const successfulTimings = runTimings.filter(t => t !== null);
    const avgTiming = successfulTimings.length > 0
      ? successfulTimings.reduce((a, b) => a + b, 0) / successfulTimings.length
      : null;

    return {
      target: "Simulated Old Logic",
      totalRuns: count,
      successfulRuns: totalSuccessCount,
      averageLatencyMs: avgTiming ? avgTiming.toFixed(2) : 'N/A',
      firstErrorMessage: firstRunError,
      averageAttemptsPerRun: totalAttempts / count,
    };
  }, rpcUrls, chainId, method, params, numRuns);

  console.log(`- Successful: ${results.successfulRuns} / ${results.totalRuns}`);
  console.log(`- Average Latency (for successful runs): ${results.averageLatencyMs} ms`);
  console.log(`- Average RPC attempts per run: ${results.averageAttemptsPerRun.toFixed(2)}`);
  if (results.firstErrorMessage && results.successfulRuns < results.totalRuns) {
    console.log(`- First Error (on failed run): ${results.firstErrorMessage}`);
  }
  return results;
}


(async () => {
  const gnosisUrls = await getWhitelistUrls(CHAIN_ID);
  if (!gnosisUrls || gnosisUrls.length === 0) {
    console.error(`No RPC URLs found for chain ${CHAIN_ID} in whitelist. Aborting.`);
    process.exit(1);
  }

  console.log("Launching Puppeteer...");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Go to a blank page to have a context for fetch
  await page.goto('about:blank');

  console.log("Running performance comparison...");

  // Test Simulated Old Logic
  const oldLogicResults = await testSimulatedOldLogic(page, gnosisUrls, CHAIN_ID, RPC_METHOD, RPC_PARAMS, NUM_RUNS);

  // Test New Proxy Logic
  const proxyResults = await testProxyPerformance(page, PROXY_URL, CHAIN_ID, RPC_METHOD, RPC_PARAMS, NUM_RUNS);

  console.log("\n--- Comparison Summary ---");
  console.log(`Simulated Old Logic: ${oldLogicResults.successfulRuns}/${oldLogicResults.totalRuns} successful runs, Avg Latency: ${oldLogicResults.averageLatencyMs} ms, Avg Attempts: ${oldLogicResults.averageAttemptsPerRun.toFixed(2)}`);
  console.log(`New SDK/Proxy Logic: ${proxyResults.successfulRuns}/${proxyResults.totalRuns} successful runs, Avg Latency: ${proxyResults.averageLatencyMs} ms`);

  await browser.close();
  console.log("\nPerformance comparison finished.");
})();
