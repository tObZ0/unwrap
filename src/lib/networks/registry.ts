/**
 * UNWRAP network registry.
 *
 * Every supported network is declared here. To add a new EVM network, add one
 * entry to BASE_NETWORKS (see README "Adding a network"). Nothing else in the
 * application hard-codes chain data.
 *
 * Sources for the values below:
 *  - Robinhood Chain / Testnet: https://docs.robinhood.com/chain/connecting
 *    (chain IDs 4663 / 46630, official public RPCs, Blockscout explorers),
 *    cross-checked against viem's `robinhood` / `robinhoodTestnet` chain defs.
 *  - Other chains: chain IDs and default public RPCs from viem's maintained
 *    chain definitions; explorer API = Etherscan API V2 (chainid parameter).
 */
import { defineChain } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  mainnet,
  optimism,
  polygon,
  robinhood,
  robinhoodTestnet,
  type Chain,
} from "viem/chains";

export type ExplorerApiKind = "etherscan-v2" | "blockscout" | "none";

export interface NetworkConfig {
  /** Stable URL-safe identifier used in the API and report URLs. */
  id: string;
  name: string;
  shortName: string;
  chainId: number;
  testnet: boolean;
  /** The project's primary ecosystem (shown first, highlighted). */
  primary: boolean;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Env var holding dedicated (usually keyed) RPC URL(s), comma-separated. Tried first. */
  rpcEnvVar: string;
  /** Public, rate-limited RPC endpoints used as fallbacks. */
  publicRpcUrls: string[];
  explorer: {
    name: string;
    url: string;
    api: { kind: ExplorerApiKind; baseUrl?: string; apiKeyEnvVar?: string };
  };
  /** Whether to try Sourcify (chain-agnostic verification repository). */
  sourcify: boolean;
  /** Disable via env `UNWRAP_DISABLED_NETWORKS=id1,id2`. */
  enabled: boolean;
  viemChain: Chain;
  notes?: string;
  /** Only the opt-in local devnet: permits an http://localhost RPC. */
  localDevnet?: boolean;
}

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

function etherscanNetwork(
  id: string,
  shortName: string,
  chain: Chain,
  rpcEnvVar: string,
  explorerName: string,
): Omit<NetworkConfig, "enabled"> {
  return {
    id,
    name: chain.name,
    shortName,
    chainId: chain.id,
    testnet: Boolean(chain.testnet),
    primary: false,
    nativeCurrency: chain.nativeCurrency,
    rpcEnvVar,
    publicRpcUrls: [...chain.rpcUrls.default.http],
    explorer: {
      name: explorerName,
      url: chain.blockExplorers!.default.url,
      api: { kind: "etherscan-v2", baseUrl: ETHERSCAN_V2, apiKeyEnvVar: "ETHERSCAN_API_KEY" },
    },
    sourcify: true,
    viemChain: chain,
  };
}

const BASE_NETWORKS: Omit<NetworkConfig, "enabled">[] = [
  {
    id: "robinhood",
    name: "Robinhood Chain",
    shortName: "Robinhood",
    chainId: robinhood.id, // 4663
    testnet: false,
    primary: true,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcEnvVar: "ROBINHOOD_RPC_URL",
    publicRpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    explorer: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
      api: { kind: "blockscout", baseUrl: "https://robinhoodchain.blockscout.com" },
    },
    sourcify: true,
    viemChain: robinhood,
    notes:
      "Arbitrum Orbit L2. The official public RPC is rate-limited; Robinhood recommends a provider such as Alchemy for production.",
  },
  {
    id: "robinhood-testnet",
    name: "Robinhood Chain Testnet",
    shortName: "Robinhood Testnet",
    chainId: robinhoodTestnet.id, // 46630
    testnet: true,
    primary: true,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcEnvVar: "ROBINHOOD_TESTNET_RPC_URL",
    publicRpcUrls: ["https://rpc.testnet.chain.robinhood.com"],
    explorer: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
      api: { kind: "blockscout", baseUrl: "https://explorer.testnet.chain.robinhood.com" },
    },
    sourcify: true,
    viemChain: robinhoodTestnet,
  },
  etherscanNetwork("ethereum", "Ethereum", mainnet, "ETHEREUM_RPC_URL", "Etherscan"),
  etherscanNetwork("base", "Base", base, "BASE_RPC_URL", "Basescan"),
  etherscanNetwork("arbitrum", "Arbitrum", arbitrum, "ARBITRUM_RPC_URL", "Arbiscan"),
  etherscanNetwork("bsc", "BNB Chain", bsc, "BNB_RPC_URL", "BscScan"),
  etherscanNetwork("optimism", "Optimism", optimism, "OPTIMISM_RPC_URL", "Optimism Etherscan"),
  etherscanNetwork("polygon", "Polygon", polygon, "POLYGON_RPC_URL", "Polygonscan"),
  etherscanNetwork("avalanche", "Avalanche", avalanche, "AVALANCHE_RPC_URL", "Snowtrace"),
];

function disabledIds(): Set<string> {
  return new Set(
    (process.env.UNWRAP_DISABLED_NETWORKS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const LOCAL_RPC_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/?$/;

/**
 * Optional local development chain (anvil/hardhat) for testing your own contracts.
 * Enabled only when UNWRAP_LOCAL_DEVNET_RPC_URL is a localhost URL, and never in
 * production unless UNWRAP_ALLOW_LOCAL_DEVNET_IN_PRODUCTION=1.
 */
function localDevnet(): Omit<NetworkConfig, "enabled"> | null {
  const url = process.env.UNWRAP_LOCAL_DEVNET_RPC_URL;
  if (!url || !LOCAL_RPC_RE.test(url)) return null;
  if (process.env.NODE_ENV === "production" && process.env.UNWRAP_ALLOW_LOCAL_DEVNET_IN_PRODUCTION !== "1") return null;
  const chainId = Number(process.env.UNWRAP_LOCAL_DEVNET_CHAIN_ID ?? 31337);
  const chain = defineChain({ id: chainId, name: "Local devnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  return {
    id: "local-devnet",
    name: "Local devnet",
    shortName: "Local",
    chainId,
    testnet: true,
    primary: false,
    nativeCurrency: chain.nativeCurrency,
    rpcEnvVar: "UNWRAP_LOCAL_DEVNET_RPC_URL",
    publicRpcUrls: [],
    explorer: { name: "None", url: "", api: { kind: "none" } },
    sourcify: false,
    viemChain: chain,
    localDevnet: true,
    notes: "Developer-only network. No explorer, so analysis is bytecode-level.",
  };
}

export function getNetworks(): NetworkConfig[] {
  const disabled = disabledIds();
  const local = localDevnet();
  return [...BASE_NETWORKS, ...(local ? [local] : [])].map((n) => ({ ...n, enabled: !disabled.has(n.id) }));
}

export function getNetwork(id: string): NetworkConfig | undefined {
  return getNetworks().find((n) => n.id === id);
}

export function getNetworkByChainId(chainId: number): NetworkConfig | undefined {
  return getNetworks().find((n) => n.chainId === chainId);
}

/** RPC URLs in priority order: operator-configured first, then public. Only https is accepted. */
export function rpcUrlsFor(n: NetworkConfig): string[] {
  const configured = (process.env[n.rpcEnvVar] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("https://") || (n.localDevnet === true && LOCAL_RPC_RE.test(s)));
  return [...new Set([...configured, ...n.publicRpcUrls])];
}

/** Shape safe to send to browsers — never includes keys or private RPC URLs. */
export interface PublicNetwork {
  id: string;
  name: string;
  shortName: string;
  chainId: number;
  testnet: boolean;
  primary: boolean;
  nativeSymbol: string;
  explorerName: string;
  explorerUrl: string;
  sourceVerification: string[];
  dedicatedRpcConfigured: boolean;
}

export function toPublicNetwork(n: NetworkConfig): PublicNetwork {
  const sources: string[] = [];
  if (n.explorer.api.kind === "blockscout") sources.push("Blockscout");
  if (n.explorer.api.kind === "etherscan-v2") {
    sources.push(process.env.ETHERSCAN_API_KEY ? "Etherscan V2" : "Etherscan V2 (needs key)");
  }
  if (n.sourcify) sources.push("Sourcify");
  if (!sources.length) sources.push("None (bytecode only)");
  return {
    id: n.id,
    name: n.name,
    shortName: n.shortName,
    chainId: n.chainId,
    testnet: n.testnet,
    primary: n.primary,
    nativeSymbol: n.nativeCurrency.symbol,
    explorerName: n.explorer.name,
    explorerUrl: n.explorer.url,
    sourceVerification: sources,
    dedicatedRpcConfigured: Boolean(process.env[n.rpcEnvVar]),
  };
}

export function publicNetworks(): PublicNetwork[] {
  return getNetworks()
    .filter((n) => n.enabled)
    .map(toPublicNetwork);
}

export function explorerAddressUrl(explorerUrl: string, address: string): string {
  return `${explorerUrl.replace(/\/$/, "")}/address/${address}`;
}
