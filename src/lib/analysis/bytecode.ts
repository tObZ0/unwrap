import { getAddress, keccak256, toFunctionSelector, type Hex } from "viem";

/**
 * Well-known function signatures. Selectors are derived with keccak at load
 * time, so there are no hand-typed selector constants to get wrong.
 * `tag` drives permission inference when only bytecode is available.
 */
const KNOWN_SIGNATURES: [string, string][] = [
  // ERC-20
  ["name()", "erc20"], ["symbol()", "erc20"], ["decimals()", "erc20"], ["totalSupply()", "erc20"],
  ["balanceOf(address)", "erc20"], ["transfer(address,uint256)", "erc20"], ["allowance(address,address)", "erc20"],
  ["approve(address,uint256)", "erc20"], ["transferFrom(address,address,uint256)", "erc20"],
  // ERC-721 / 1155 / 165
  ["ownerOf(uint256)", "erc721"], ["safeTransferFrom(address,address,uint256)", "erc721"], ["setApprovalForAll(address,bool)", "nft"],
  ["isApprovedForAll(address,address)", "nft"], ["getApproved(uint256)", "erc721"], ["tokenURI(uint256)", "erc721"],
  ["safeTransferFrom(address,address,uint256,uint256,bytes)", "erc1155"], ["balanceOfBatch(address[],uint256[])", "erc1155"],
  ["uri(uint256)", "erc1155"], ["supportsInterface(bytes4)", "erc165"],
  // Ownership / roles
  ["owner()", "ownable"], ["transferOwnership(address)", "ownership_transfer"], ["renounceOwnership()", "renounce"],
  ["acceptOwnership()", "ownership_transfer"], ["pendingOwner()", "ownable"], ["getOwner()", "ownable"],
  ["hasRole(bytes32,address)", "access_control"], ["grantRole(bytes32,address)", "role_management"],
  ["revokeRole(bytes32,address)", "role_management"], ["renounceRole(bytes32,address)", "role_management"],
  ["getRoleAdmin(bytes32)", "access_control"], ["DEFAULT_ADMIN_ROLE()", "access_control"],
  // Supply
  ["mint(address,uint256)", "mint"], ["mint(uint256)", "mint"], ["mintTo(address,uint256)", "mint"],
  ["burn(uint256)", "burn"], ["burn(address,uint256)", "burn"], ["burnFrom(address,uint256)", "burn"],
  ["cap()", "supply"], ["maxSupply()", "supply"],
  // Pause
  ["pause()", "pause"], ["unpause()", "pause"], ["paused()", "pausable"],
  // Lists
  ["blacklist(address)", "blacklist"], ["addToBlacklist(address)", "blacklist"], ["setBlacklist(address,bool)", "blacklist"],
  ["isBlacklisted(address)", "blacklist"], ["blacklist(address,bool)", "blacklist"], ["unBlacklist(address)", "blacklist"],
  ["freeze(address)", "blacklist"], ["addBlackList(address)", "blacklist"],
  ["setWhitelist(address,bool)", "whitelist"], ["addToWhitelist(address)", "whitelist"],
  // Fees and limits
  ["setFee(uint256)", "fee_change"], ["setFees(uint256,uint256)", "fee_change"], ["setTaxFee(uint256)", "fee_change"],
  ["setBuyFee(uint256)", "fee_change"], ["setSellFee(uint256)", "fee_change"],
  ["setMaxTxAmount(uint256)", "limit_change"], ["setMaxWalletSize(uint256)", "limit_change"],
  ["enableTrading()", "transfer_restriction"], ["setTradingEnabled(bool)", "transfer_restriction"],
  // Upgrades
  ["upgradeTo(address)", "upgrade"], ["upgradeToAndCall(address,bytes)", "upgrade"], ["proxiableUUID()", "uups"],
  ["implementation()", "proxy"], ["admin()", "proxy"], ["changeAdmin(address)", "upgrade"],
  // Funds
  ["withdraw()", "withdraw"], ["withdraw(uint256)", "withdraw"], ["rescueTokens(address,uint256)", "withdraw"],
  ["recoverERC20(address,uint256)", "withdraw"], ["emergencyWithdraw()", "withdraw"],
  // Protocol patterns
  ["getReserves()", "dex_pair"], ["token0()", "dex_pair"], ["token1()", "dex_pair"],
  ["swapExactTokensForTokens(uint256,uint256,address[],address,uint256)", "dex_router"], ["factory()", "dex"],
  ["getOwners()", "multisig"], ["getThreshold()", "multisig"], ["execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)", "multisig"],
  ["getMinDelay()", "timelock"], ["asset()", "erc4626"], ["convertToShares(uint256)", "erc4626"],
  ["nonces(address)", "permit"], ["permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", "permit"],
  // Misc
  ["multicall(bytes[])", "multicall"], ["execute(address,uint256,bytes)", "arbitrary_call"],
  ["deposit()", "weth"], ["withdraw(uint256)", "weth"],
];

export interface KnownSignature {
  signature: string;
  name: string;
  tag: string;
}

export const SELECTOR_TABLE: Map<string, KnownSignature[]> = (() => {
  const m = new Map<string, KnownSignature[]>();
  for (const [sig, tag] of KNOWN_SIGNATURES) {
    const sel = toFunctionSelector(`function ${sig}`);
    const list = m.get(sel) ?? [];
    if (!list.some((k) => k.signature === sig)) list.push({ signature: sig, name: sig.slice(0, sig.indexOf("(")), tag });
    m.set(sel, list);
  }
  return m;
})();

export function lookupSelector(selector: string): KnownSignature[] {
  return SELECTOR_TABLE.get(selector.toLowerCase()) ?? [];
}

export interface BytecodeFacts {
  size: number;
  hash: Hex;
  selectors: string[];
  opcodes: { delegatecall: boolean; selfdestruct: boolean; callcode: boolean; create: boolean; create2: boolean; call: boolean; sstore: boolean };
  minimalProxyTarget?: string;
  /** EIP-7702 delegation designator (EOA delegated to code). */
  eip7702Delegate?: string;
}

/**
 * Solidity appends CBOR metadata whose length is encoded in the final 2 bytes.
 * It is data, not code; stripping it avoids reading spurious opcodes.
 */
export function stripMetadata(code: Uint8Array): Uint8Array {
  if (code.length < 4) return code;
  const len = (code[code.length - 2]! << 8) | code[code.length - 1]!;
  if (len > 0 && len + 2 < code.length) {
    const start = code.length - 2 - len;
    // CBOR map header 0xa1..0xa5 is what solc emits.
    if (code[start]! >= 0xa1 && code[start]! <= 0xa5) return code.slice(0, start);
  }
  return code;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

const EIP1167_PREFIX = "363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

export function analyseBytecode(hex: Hex): BytecodeFacts {
  const lower = hex.toLowerCase();
  const raw = hexToBytes(lower);
  const facts: BytecodeFacts = {
    size: raw.length,
    hash: keccak256(hex),
    selectors: [],
    opcodes: { delegatecall: false, selfdestruct: false, callcode: false, create: false, create2: false, call: false, sstore: false },
  };

  const body = lower.slice(2);
  if (body.startsWith(EIP1167_PREFIX) && body.slice(EIP1167_PREFIX.length + 40).startsWith(EIP1167_SUFFIX)) {
    facts.minimalProxyTarget = getAddress(`0x${body.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40)}`);
  }
  if (body.startsWith("ef0100") && body.length === 46) {
    facts.eip7702Delegate = getAddress(`0x${body.slice(6)}`);
  }

  const code = stripMetadata(raw);
  const selectors = new Set<string>();
  for (let i = 0; i < code.length; i++) {
    const op = code[i]!;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      // Dispatcher pattern: PUSH4 <selector> followed shortly by EQ (0x14) or a JUMPI path.
      if (n === 4 && i + 5 < code.length) {
        const look = code.slice(i + 5, i + 9);
        if (look.includes(0x14)) {
          const sel = `0x${Array.from(code.slice(i + 1, i + 5), (b) => b.toString(16).padStart(2, "0")).join("")}`;
          if (sel !== "0xffffffff" && sel !== "0x00000000") selectors.add(sel);
        }
      }
      i += n;
      continue;
    }
    switch (op) {
      case 0xf4: facts.opcodes.delegatecall = true; break;
      case 0xff: facts.opcodes.selfdestruct = true; break;
      case 0xf2: facts.opcodes.callcode = true; break;
      case 0xf0: facts.opcodes.create = true; break;
      case 0xf5: facts.opcodes.create2 = true; break;
      case 0xf1: facts.opcodes.call = true; break;
      case 0x55: facts.opcodes.sstore = true; break;
    }
  }
  facts.selectors = [...selectors].sort();
  return facts;
}
