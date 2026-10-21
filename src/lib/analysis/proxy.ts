import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import type { ChainReader } from "@/lib/networks/chain-reader";
import type { BytecodeFacts } from "./bytecode";
import type { Evidence, ProxyInfo } from "./types";

/** bytes32(uint256(keccak256(label)) - 1), per EIP-1967. */
function eip1967Slot(label: string): Hex {
  const v = BigInt(keccak256(toHex(label))) - 1n;
  return toHex(v, { size: 32 });
}

export const SLOTS = {
  implementation: eip1967Slot("eip1967.proxy.implementation"),
  admin: eip1967Slot("eip1967.proxy.admin"),
  beacon: eip1967Slot("eip1967.proxy.beacon"),
  /** OpenZeppelin legacy (pre-1967) unstructured storage slot. */
  zeppelinosImplementation: keccak256(toHex("org.zeppelinos.proxy.implementation")),
} as const;

function slotToAddress(v: Hex | undefined): Address | undefined {
  if (!v || v === "0x") return undefined;
  const n = BigInt(v);
  if (n === 0n) return undefined;
  if (n >> 160n !== 0n) return undefined; // not an address-shaped value
  return getAddress(toHex(n, { size: 20 }));
}

const BEACON_ABI = [{ type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

async function hasCode(reader: ChainReader, a: Address): Promise<boolean | undefined> {
  try {
    const code = await reader.getBytecode(a);
    return Boolean(code && code !== "0x");
  } catch {
    return undefined;
  }
}

export async function detectProxy(
  reader: ChainReader,
  address: Address,
  bytecode: BytecodeFacts,
  opts: { explorerImplementation?: string; selectorTags: Set<string> },
): Promise<ProxyInfo> {
  const evidence: Evidence[] = [];
  const notes: string[] = [];

  if (bytecode.minimalProxyTarget) {
    evidence.push({ basis: "bytecode", description: `Runtime bytecode matches the EIP-1167 minimal proxy template delegating to ${bytecode.minimalProxyTarget}.` });
    return {
      isProxy: true,
      pattern: "eip1167-minimal",
      implementation: bytecode.minimalProxyTarget,
      upgradeable: "no",
      evidence,
      notes: ["EIP-1167 clones hard-code their target in bytecode; the implementation address cannot be changed. The implementation's own logic may still have privileged functions."],
    };
  }

  const read = async (slot: Hex) => {
    try {
      return slotToAddress(await reader.getStorageAt(address, slot));
    } catch {
      notes.push("A storage-slot read failed; proxy detection may be incomplete.");
      return undefined;
    }
  };
  const [impl, admin, beacon, legacy] = await Promise.all([
    read(SLOTS.implementation),
    read(SLOTS.admin),
    read(SLOTS.beacon),
    read(SLOTS.zeppelinosImplementation),
  ]);

  if (beacon) {
    evidence.push({ basis: "onchain", description: `EIP-1967 beacon slot holds ${beacon}.` });
    let implementation: Address | undefined;
    try {
      implementation = getAddress((await reader.readContract({ address: beacon, abi: BEACON_ABI, functionName: "implementation" })) as string);
      evidence.push({ basis: "onchain", description: `Beacon.implementation() returned ${implementation}.` });
    } catch {
      notes.push("The beacon did not answer implementation(); the current implementation could not be resolved.");
    }
    return {
      isProxy: true,
      pattern: "eip1967-beacon",
      beacon,
      implementation,
      upgradeable: "yes",
      evidence,
      notes: [...notes, "Beacon proxies follow whatever implementation the beacon points to. Whoever controls the beacon can change this contract's logic."],
    };
  }

  if (impl) {
    evidence.push({ basis: "onchain", description: `EIP-1967 implementation slot holds ${impl}.` });
    let pattern: ProxyInfo["pattern"] = "eip1967";
    let adminIsContract: boolean | undefined;
    if (admin) {
      pattern = "eip1967-transparent";
      evidence.push({ basis: "onchain", description: `EIP-1967 admin slot holds ${admin}.` });
      adminIsContract = await hasCode(reader, admin);
      if (adminIsContract === true) notes.push("The proxy admin is a contract (commonly a ProxyAdmin, multisig or timelock). Its own owner ultimately controls upgrades.");
      if (adminIsContract === false) notes.push("The proxy admin is an externally owned account: a single key can upgrade the implementation.");
    } else if (opts.selectorTags.has("uups")) {
      pattern = "eip1967-uups";
    }
    return {
      isProxy: true,
      pattern,
      implementation: impl,
      admin,
      upgradeable: "yes",
      adminIsContract,
      evidence,
      notes: [
        ...notes,
        pattern === "eip1967-uups"
          ? "UUPS proxies keep upgrade logic in the implementation; upgrade authority is whatever the implementation's upgrade function allows."
          : "The implementation address is stored in a writable slot and can be replaced by the upgrade authority.",
      ],
    };
  }

  if (legacy) {
    evidence.push({ basis: "onchain", description: `Legacy ZeppelinOS implementation slot holds ${legacy}.` });
    return { isProxy: true, pattern: "legacy-zeppelinos", implementation: legacy, upgradeable: "yes", evidence, notes };
  }

  if (opts.explorerImplementation) {
    evidence.push({ basis: "explorer", description: `The block explorer reports an implementation at ${opts.explorerImplementation}.` });
    return {
      isProxy: true,
      pattern: "explorer-reported",
      implementation: getAddress(opts.explorerImplementation),
      upgradeable: "unknown",
      evidence,
      notes: [
        ...notes,
        "No standard proxy storage slot was set; the proxy relationship comes from the explorer and its upgrade mechanism was not identified.",
      ],
    };
  }

  if (bytecode.opcodes.delegatecall && bytecode.size < 2000) {
    notes.push("Small contract containing DELEGATECALL with no recognised proxy slot. It may be a custom proxy that UNWRAP does not recognise.");
  }
  return { isProxy: false, pattern: "none", upgradeable: bytecode.opcodes.delegatecall ? "unknown" : "no", evidence, notes };
}
