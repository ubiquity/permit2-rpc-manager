import { ChainlistDataSource } from "../data/chainlist-data-source.ts";
import type { Permit2RpcManagerOptions } from "../core/permit2-rpc-manager.ts";
import type { CacheData, CacheStore } from "./cache-manager.ts";
import type { DiagnosticIdentity, DiagnosticReceipt, HttpDiagnosticsObject } from "./worker-diagnostics-object.ts";
import { RpcBudgetExceeded, WorkerTransport } from "./worker-transport.ts";

const dataSource = new ChainlistDataSource();

export function diagnosticsObjectName(colo: string, chainId: number): string {
  return `http:${/^[A-Z]{3,4}$/.test(colo) ? colo : "local"}:${chainId}`;
}

export function createHttpDiagnostics(
  namespace: DurableObjectNamespace<HttpDiagnosticsObject>,
  version: string,
  colo: string,
  transport: WorkerTransport,
  validateChainId: boolean,
  disableCache: boolean,
): { resolver: NonNullable<Permit2RpcManagerOptions["diagnosticsResolver"]>; store: CacheStore } {
  const stub = (chainId: number) => namespace.getByName(diagnosticsObjectName(colo, chainId));
  const identity = (
    chainId: number,
    settings = { validateChainId, timeoutMs: 5000, disableCache },
  ): DiagnosticIdentity => ({
    requestId: crypto.randomUUID(),
    version,
    chainId,
    ...settings,
  });
  const verify = (reply: DiagnosticReceipt, query: DiagnosticIdentity, allowance: number) => {
    if (
      !reply || reply.requestId !== query.requestId || reply.version !== query.version ||
      reply.chainId !== query.chainId ||
      reply.maxExternalCalls !== allowance || !Number.isInteger(reply.externalCalls) || reply.externalCalls < 0 ||
      reply.externalCalls > allowance || !Number.isSafeInteger(reply.sqlRowsRead) || reply.sqlRowsRead < 0 ||
      !Number.isSafeInteger(reply.sqlRowsWritten) || reply.sqlRowsWritten < 0 ||
      !Number.isSafeInteger(reply.activeWallMs) || reply.activeWallMs < 0
    ) throw new RpcBudgetExceeded();
    transport.sqlRowsRead += reply.sqlRowsRead;
    transport.sqlRowsWritten += reply.sqlRowsWritten;
    transport.diagnosticsWallMs += reply.activeWallMs;
  };
  const read = async (chainId: number) => {
    const query = identity(chainId);
    transport.countBindingCall();
    transport.diagnosticRequestIds.push(query.requestId);
    const reply = await stub(chainId).readSnapshot(query);
    verify(reply, query, 0);
    return reply.snapshot;
  };
  return {
    resolver: async (chainId, eligibleUrls, settings) => {
      const urls = dataSource.getRpcUrls(chainId), eligible = new Set(eligibleUrls);
      if (eligibleUrls.some((url) => !urls.includes(url))) {
        throw new Error("Diagnostics must use the compiled whitelist.");
      }
      const query = identity(chainId, settings);
      const reservation = transport.reserveDiagnostics();
      transport.diagnosticRequestIds.push(query.requestId);
      let reply: DiagnosticReceipt;
      try {
        reply = await stub(chainId).getOrRefresh({
          ...query,
          eligibleIndices: urls.flatMap((url, index) => eligible.has(url) ? [index] : []),
          maxExternalCalls: reservation.maxExternalCalls,
        });
        verify(reply, query, reservation.maxExternalCalls);
        reservation.settle(reply.externalCalls);
      } catch {
        // Without a matching bounded receipt the entire pre-charged allowance remains spent.
        throw new RpcBudgetExceeded();
      }
      if (reply.error) {
        throw Object.assign(new Error(reply.error.message), { name: reply.error.name, code: reply.error.code });
      }
      if (!reply.snapshot) throw new Error("No RPC diagnostic snapshot available.");
      return reply.snapshot;
    },
    store: {
      loadChain: (_key, chainId) => read(chainId),
      async load() {
        const snapshots: CacheData = {};
        await Promise.all(
          dataSource.getAvailableChains().map(async (chainId) => {
            const snapshot = await read(chainId);
            if (snapshot) snapshots[chainId] = snapshot;
          }),
        );
        return snapshots;
      },
      save: () => Promise.resolve(), // Foreground health/scoring never writes the private diagnostic store.
    },
  };
}
