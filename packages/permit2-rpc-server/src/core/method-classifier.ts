const WRITE_METHODS = new Set<string>([
  "eth_sendrawtransaction",
  "eth_sendtransaction",
  "eth_signtransaction",
  "eth_sign",
  "eth_signtypeddata",
  "eth_signtypeddata_v4",
  "personal_sign",

  // Unsafe-to-hedge methods (side effects / session state)
  "eth_newfilter",
  "eth_newblockfilter",
  "eth_newpendingtransactionfilter",
  "eth_uninstallfilter",
  "eth_getfilterchanges",
  "eth_getfilterlogs",
]);

const SAFE_READ_METHODS = new Set<string>([
  "eth_blocknumber",
  "eth_call",
  "eth_chainid",
  "eth_estimategas",
  "eth_feehistory",
  "eth_gasprice",
  "eth_maxpriorityfeepergas",
  "eth_syncing",
  "net_version",
  "web3_clientversion",
]);

/**
 * Returns true if a method is considered a "write" (unsafe to hedge).
 *
 * Conservative by default: unknown methods return true (do not hedge).
 */
export function isWriteMethod(method: string): boolean {
  const normalized = method.trim().toLowerCase();
  if (normalized.length === 0) return true;

  if (WRITE_METHODS.has(normalized)) return true;
  if (SAFE_READ_METHODS.has(normalized)) return false;

  // Common read-only namespace patterns.
  if (normalized.startsWith("eth_get")) return false;

  return true;
}

/**
 * Safe-to-cache methods are intentionally conservative and should have short TTLs.
 */
export function isSafeToCache(method: string): boolean {
  const normalized = method.trim().toLowerCase();
  return normalized === "eth_chainid" || normalized === "net_version";
}
