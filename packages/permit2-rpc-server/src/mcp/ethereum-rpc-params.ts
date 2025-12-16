export function buildRpcParams(method: string, args: any): unknown[] {
  switch (method) {
    case "eth_getBalance":
      return [args.address, args.blockNumber];
    case "eth_getCode":
      return [args.address, args.blockNumber];
    case "eth_getTransactionCount":
      return [args.address, args.blockNumber];
    case "eth_getStorageAt":
      return [args.address, args.position, args.blockNumber];
    case "eth_call":
      return [args.transaction, args.blockNumber];
    case "eth_estimateGas":
      return args.blockNumber ? [args.transaction, args.blockNumber] : [args.transaction];
    case "eth_sendRawTransaction":
      return [args.signedTransaction];
    case "eth_getTransactionByHash":
      return [args.hash];
    case "eth_getTransactionReceipt":
      return [args.hash];
    case "eth_getTransactionByBlockHashAndIndex":
      return [args.blockHash, args.index];
    case "eth_getTransactionByBlockNumberAndIndex":
      return [args.blockNumber, args.index];
    case "eth_getBlockTransactionCountByHash":
      return [args.blockHash];
    case "eth_getBlockByHash":
      return [args.blockHash, args.fullTransactions];
    case "eth_getBlockByNumber":
      return [args.blockNumber, args.fullTransactions];
    case "eth_getBlockTransactionCountByNumber":
      return [args.blockNumber];
    case "eth_getUncleCountByBlockHash":
      return [args.blockHash];
    case "eth_getUncleCountByBlockNumber":
      return [args.blockNumber];
    case "eth_getUncleByBlockHashAndIndex":
      return [args.blockHash, args.index];
    case "eth_getUncleByBlockNumberAndIndex":
      return [args.blockNumber, args.index];
    case "eth_blockNumber":
    case "eth_protocolVersion":
    case "eth_syncing":
    case "eth_coinbase":
    case "eth_chainId":
    case "eth_mining":
    case "eth_hashrate":
    case "eth_gasPrice":
    case "eth_accounts":
      return [];
    default:
      return [];
  }
}
