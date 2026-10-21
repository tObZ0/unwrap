import {
  createPublicClient,
  fallback,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { AppError } from "@/lib/errors";
import { rpcUrlsFor, type NetworkConfig } from "./registry";

/** Read-only chain access. Implemented by viem in production, mocked in tests. */
export interface ChainReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBytecode(address: Address): Promise<Hex | undefined>;
  getBalance(address: Address): Promise<bigint>;
  getTransactionCount(address: Address): Promise<number>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | undefined>;
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

const clients = new Map<string, PublicClient>();

function clientFor(n: NetworkConfig, overrideUrls?: string[]): PublicClient {
  const urls = overrideUrls ?? rpcUrlsFor(n);
  const key = `${n.id}|${urls.join(",")}`;
  const cached = clients.get(key);
  if (cached) return cached;
  if (urls.length === 0) throw new AppError("NETWORK_UNAVAILABLE", `No RPC endpoint is configured for ${n.name}.`);
  const transports = urls.map((u) => http(u, { timeout: 12_000, retryCount: 1, retryDelay: 300 }));
  const client = createPublicClient({
    chain: n.viemChain,
    transport: transports.length === 1 ? transports[0]! : fallback(transports, { rank: false }),
    batch: { multicall: false },
  }) as PublicClient;
  clients.set(key, client);
  return client;
}

function wrap<T>(n: NetworkConfig, what: string, p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    if (e instanceof AppError) throw e;
    const msg = (e as Error)?.message ?? "";
    // Contract reverts are a normal outcome for optional getters; surface them distinctly.
    if (/revert|execution reverted|returned no data|ContractFunctionZeroData/i.test(msg) || (e as Error)?.name?.includes("ContractFunction")) {
      throw new ContractCallFailed(what);
    }
    throw new AppError("NETWORK_UNAVAILABLE", `${n.name} RPC did not respond to ${what}. The provider may be down or rate-limiting.`);
  });
}

export class ContractCallFailed extends Error {
  constructor(fn: string) {
    super(`call reverted: ${fn}`);
    this.name = "ContractCallFailed";
  }
}

/**
 * `overrideUrls` exists for tests against a local node (http://127.0.0.1).
 * Production code never passes it: RPC URLs come only from the registry/env.
 */
export function createChainReader(n: NetworkConfig, overrideUrls?: string[]): ChainReader {
  const c = clientFor(n, overrideUrls);
  return {
    getChainId: () => wrap(n, "eth_chainId", c.getChainId()),
    getBlockNumber: () => wrap(n, "eth_blockNumber", c.getBlockNumber()),
    getBytecode: (address) => wrap(n, "eth_getCode", c.getCode({ address })),
    getBalance: (address) => wrap(n, "eth_getBalance", c.getBalance({ address })),
    getTransactionCount: (address) => wrap(n, "eth_getTransactionCount", c.getTransactionCount({ address })),
    getStorageAt: (address, slot) => wrap(n, "eth_getStorageAt", c.getStorageAt({ address, slot })),
    readContract: (args) =>
      wrap(
        n,
        `eth_call ${args.functionName}`,
        c.readContract({ ...args, args: args.args as unknown[] | undefined } as Parameters<PublicClient["readContract"]>[0]),
      ),
  };
}

/** Verifies the endpoint is actually serving the configured chain. */
export async function assertChainId(reader: ChainReader, n: NetworkConfig): Promise<void> {
  const id = await reader.getChainId();
  if (id !== n.chainId) {
    throw new AppError(
      "CHAIN_ID_MISMATCH",
      `The RPC endpoint for ${n.name} reported chain ID ${id}, expected ${n.chainId}. Analysis stopped to avoid reading the wrong chain.`,
    );
  }
}
