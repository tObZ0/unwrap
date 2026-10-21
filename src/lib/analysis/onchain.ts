import { formatUnits, getAddress, type Abi, type Address } from "viem";
import type { ChainReader } from "@/lib/networks/chain-reader";
import type { ContractFunction, Evidence, Finding, OwnershipInfo, Permission, ProxyInfo, TokenInfo } from "./types";

const ERC20_READ: Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "supportsInterface", stateMutability: "view", inputs: [{ type: "bytes4" }], outputs: [{ type: "bool" }] },
];

/** Removes control characters and bounds length. Token strings are attacker-controlled. */
export function sanitiseString(v: unknown, max = 80): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return s ? s.slice(0, max) : undefined;
}

async function tryRead<T>(reader: ChainReader, address: Address, functionName: string, args?: unknown[]): Promise<T | undefined> {
  try {
    return (await reader.readContract({ address, abi: ERC20_READ, functionName, args })) as T;
  } catch {
    return undefined;
  }
}

export async function detectNftInterfaces(reader: ChainReader, address: Address): Promise<{ erc721: boolean; erc1155: boolean }> {
  const [a, b] = await Promise.all([
    tryRead<boolean>(reader, address, "supportsInterface", ["0x80ac58cd"]),
    tryRead<boolean>(reader, address, "supportsInterface", ["0xd9b67a26"]),
  ]);
  return { erc721: a === true, erc1155: b === true };
}

export async function readTokenInfo(
  reader: ChainReader,
  address: Address,
  standard: TokenInfo["standard"],
  functions: ContractFunction[],
): Promise<TokenInfo> {
  const names = new Set(functions.map((f) => f.name));
  const [name, symbol, decimalsRaw, supply] = await Promise.all([
    tryRead<string>(reader, address, "name"),
    tryRead<string>(reader, address, "symbol"),
    standard === "ERC-20" ? tryRead<number>(reader, address, "decimals") : Promise.resolve(undefined),
    tryRead<bigint>(reader, address, "totalSupply"),
  ]);
  const decimals = typeof decimalsRaw === "number" && decimalsRaw <= 77 ? decimalsRaw : undefined;
  const info: TokenInfo = {
    standard,
    name: sanitiseString(name),
    symbol: sanitiseString(symbol, 24),
    decimals,
    holdersNote:
      "Holder counts and distribution need an indexing service. UNWRAP does not show holder data rather than estimate it.",
  };
  if (typeof supply === "bigint") {
    info.totalSupply = supply.toString();
    if (decimals !== undefined) info.totalSupplyFormatted = formatUnits(supply, decimals);
  }
  // Max supply only from an explicit getter; never inferred from totalSupply.
  for (const getter of ["cap", "maxSupply"] as const) {
    if (!names.has(getter)) continue;
    const v = await tryRead<bigint>(reader, address, getter);
    if (typeof v === "bigint") {
      info.maxSupply = v.toString();
      if (decimals !== undefined) info.maxSupplyFormatted = formatUnits(v, decimals);
      info.maxSupplySource = `${getter}() returned this value. Whether it is enforced on every mint path is shown in the Permissions and Security tabs.`;
      break;
    }
  }
  return info;
}

async function isContract(reader: ChainReader, a: Address): Promise<boolean | undefined> {
  try {
    const c = await reader.getBytecode(a);
    return Boolean(c && c !== "0x");
  } catch {
    return undefined;
  }
}

/**
 * Reads owner() / getOwner() if present and writes an assessment that accounts
 * for other authorities. A zero owner is NOT treated as proof of renouncement.
 */
export async function readOwnership(
  reader: ChainReader,
  address: Address,
  functions: ContractFunction[],
  permissions: Permission[],
  proxy: ProxyInfo,
): Promise<OwnershipInfo | null> {
  const names = new Set(functions.map((f) => f.name));
  const getter = names.has("owner") ? "owner" : names.has("getOwner") ? "getOwner" : null;
  const otherAuthorities = [
    ...new Set(
      permissions
        .map((p) => p.authority)
        .filter((a) => a !== "owner" && !a.startsWith("anyone") && !a.startsWith("unknown")),
    ),
  ];
  if (proxy.isProxy && proxy.upgradeable === "yes") {
    otherAuthorities.push(proxy.admin ? `proxy admin ${proxy.admin}` : proxy.beacon ? `beacon ${proxy.beacon}` : "upgrade authority (see Proxy)");
  }
  if (!getter && !otherAuthorities.length) return null;

  let owner: string | undefined;
  if (getter) {
    const raw = await tryRead<string>(reader, address, getter);
    if (typeof raw === "string") owner = getAddress(raw);
  }
  const ownerIsZero = owner ? /^0x0{40}$/i.test(owner) : undefined;
  const ownerIsContract = owner && !ownerIsZero ? await isContract(reader, owner as Address) : undefined;
  const ownerPerms = permissions.filter((p) => p.authority === "owner").length;

  let assessment: string;
  if (!getter) assessment = "No owner() getter. Administrative authority (if any) is held through the mechanisms listed below.";
  else if (owner === undefined) assessment = `${getter}() exists but the call failed, so the current owner is unknown.`;
  else if (ownerIsZero) {
    assessment = `${getter}() returns the zero address, consistent with ownership having been renounced through this mechanism. Owner-only functions guarded by this owner can no longer be called.`;
    if (otherAuthorities.length) assessment += ` However, other authorities exist (${otherAuthorities.join("; ")}), so administrative control has NOT been fully removed.`;
    else assessment += " UNWRAP found no other administrative authority, but authorities implemented in non-standard ways or in external contracts would not be detected.";
  } else if (ownerIsContract) {
    assessment = `The owner is a contract (${owner}), commonly a multisig, timelock or governance contract. The owner's own rules determine how ${ownerPerms || "the"} owner-restricted functions can be used. Inspect that contract separately.`;
  } else if (ownerIsContract === false) {
    assessment = `The owner (${owner}) is an externally owned account: a single private key controls ${ownerPerms ? `${ownerPerms} owner-restricted permission group(s)` : "owner-restricted functions"}.`;
  } else {
    assessment = `The owner is ${owner}. Whether it is a contract could not be determined.`;
  }
  return { owner, ownerIsZero, ownerIsContract, assessment, otherAuthorities };
}

/** Findings that only on-chain state can establish. */
export function onchainFindings(proxy: ProxyInfo, ownership: OwnershipInfo | null, permissions: Permission[]): Finding[] {
  const out: Finding[] = [];
  let i = 0;
  const id = (r: string) => `${r}-${++i}`;
  if (proxy.isProxy && proxy.upgradeable === "yes") {
    const ev: Evidence[] = proxy.evidence;
    out.push({
      id: id("CHAIN-UPGRADEABLE"),
      ruleId: "upgradeable-proxy",
      title: proxy.adminIsContract === false ? "Upgradeable, and a single key controls upgrades" : "Contract logic can be upgraded",
      severity: proxy.adminIsContract === false ? "medium" : "low",
      confidence: "high",
      kind: "confirmed_behaviour",
      category: "Upgradeability",
      explanation:
        "This is a proxy whose implementation can be replaced. Today's analysis describes the current implementation only; an upgrade can change any behaviour, including balances logic and permissions." +
        (proxy.adminIsContract === false ? " The upgrade authority is an externally owned account." : ""),
      evidence: ev,
      recommendation: "Identify who controls upgrades and whether a timelock gives users time to react.",
      limitations: proxy.pattern === "eip1967-uups" ? "For UUPS proxies, upgrade authority is defined by the implementation's _authorizeUpgrade logic." : "Proxy admin control may itself be governed by another contract.",
      detector: "unwrap-onchain",
    });
  }
  if (ownership?.owner && ownership.ownerIsContract === false && !ownership.ownerIsZero && permissions.some((p) => p.authority === "owner" && p.capability !== "renounce" && p.capability !== "ownership_transfer")) {
    out.push({
      id: id("CHAIN-EOA-OWNER"),
      ruleId: "eoa-owner",
      title: "Owner powers are held by a single externally owned account",
      severity: "low",
      confidence: "high",
      kind: "confirmed_behaviour",
      category: "Centralisation",
      explanation: `The owner ${ownership.owner} has no contract code, so one private key can use every owner-only permission. If that key is lost or compromised, so are those powers.`,
      evidence: [{ basis: "onchain", description: `owner() = ${ownership.owner}; eth_getCode returned empty` }],
      recommendation: "Prefer contracts whose admin is a multisig or timelock.",
      limitations: "An account can delegate code under EIP-7702; this check only reflects the current state.",
      detector: "unwrap-onchain",
    });
  }
  return out;
}
