import { describe, expect, it } from "vitest";
import { toFunctionSelector, type Hex } from "viem";
import { analyseBytecode, lookupSelector, stripMetadata } from "@/lib/analysis/bytecode";
import { analyseSources, accessControlOf } from "@/lib/analysis/source-analyzer";
import { runEngine } from "@/lib/analysis/engine";
import { detectProxy, SLOTS } from "@/lib/analysis/proxy";
import type { ChainReader } from "@/lib/networks/chain-reader";
import { artifacts, source } from "../helpers/fixtures";

const risky = () => analyseSources([{ path: "RiskyToken.sol", content: source("RiskyToken.sol") }, { path: "Ownable.sol", content: source("Ownable.sol") }], "RiskyToken");

describe("bytecode analysis", () => {
  it("extracts dispatcher selectors from real compiled bytecode", () => {
    const facts = analyseBytecode(artifacts.RiskyToken!.deployedBytecode);
    expect(facts.selectors).toContain(toFunctionSelector("function mint(address,uint256)"));
    expect(facts.selectors).toContain(toFunctionSelector("function setBlacklist(address,bool)"));
    expect(facts.opcodes.call).toBe(true);
    expect(facts.minimalProxyTarget).toBeUndefined();
  });
  it("recognises the EIP-1167 template", () => {
    const code = `0x363d3d373d3d3d363d73${"ab".repeat(20)}5af43d82803e903d91602b57fd5bf3` as Hex;
    expect(analyseBytecode(code).minimalProxyTarget?.toLowerCase()).toBe(`0x${"ab".repeat(20)}`);
  });
  it("strips CBOR metadata so it is not scanned as code", () => {
    const meta = [0xa2, 0x64, 0xff, 0xff];
    const code = new Uint8Array([0x60, 0x00, ...meta, 0x00, meta.length]);
    expect(Array.from(stripMetadata(code))).toEqual([0x60, 0x00]);
  });
  it("maps selectors to known signatures", () => {
    expect(lookupSelector("0xa9059cbb")[0]?.signature).toBe("transfer(address,uint256)");
    expect(lookupSelector("0xdeadbeef")).toEqual([]);
  });
});

describe("Solidity source analysis", () => {
  it("resolves inheritance across files and identifies access control", () => {
    const m = risky();
    expect(m.linearized.map((c) => c.name)).toEqual(["RiskyToken", "Ownable"]);
    const fn = (n: string) => m.callable.find((f) => f.name === n)!;
    expect(accessControlOf(fn("mint"), m)).toMatchObject({ restricted: true, authority: "owner", mechanism: "modifier onlyOwner" });
    expect(accessControlOf(fn("setFeeRecipient"), m).restricted).toBe(false);
    expect(accessControlOf(fn("sweep"), m)).toMatchObject({ restricted: true, authority: "owner", mechanism: expect.stringContaining("tx.origin") });
    expect(fn("execute").effective.externalCalls[0]).toMatchObject({ kind: "call", checked: false, targetIsParam: true, dataIsParam: true });
    expect(fn("withdrawDeposit").effective.externalCalls[0]).toMatchObject({ kind: "call", checked: true, sendsValue: true });
  });

  it("keeps NatSpec as attributed text, including injection attempts", () => {
    const m = risky();
    expect(m.callable.find((f) => f.name === "mint")!.natspec).toBe("@notice Mints new tokens.");
  });

  it("recognises role-based access control", () => {
    const src = `pragma solidity ^0.8.20;
      abstract contract AccessControl { mapping(bytes32 => mapping(address => bool)) _roles;
        modifier onlyRole(bytes32 role) { _checkRole(role); _; }
        function _checkRole(bytes32 role) internal view { require(_roles[role][msg.sender]); }
        function hasRole(bytes32 r, address a) public view returns (bool) { return _roles[r][a]; } }
      contract T is AccessControl { bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE"); uint256 public totalSupply; mapping(address=>uint256) public balanceOf;
        function mint(address to, uint256 a) external onlyRole(MINTER_ROLE) { _mint(to, a); }
        function _mint(address to, uint256 a) internal { totalSupply += a; balanceOf[to] += a; } }`;
    const m = analyseSources([{ path: "T.sol", content: src }], "T");
    const out = runEngine({ abi: null, model: m, bytecode: analyseBytecode("0x00") });
    const mint = out.permissions.find((p) => p.capability === "mint")!;
    expect(mint.authority).toBe("role: MINTER_ROLE");
    expect(out.classification.patterns.map((p) => p.name)).toContain("Role-based access control");
  });

  it("flags unprotected sensitive functions, selfdestruct and delegatecall", () => {
    const src = `pragma solidity ^0.8.20; contract V { address public owner; uint256 public fee; mapping(address=>uint256) public balanceOf; uint256 public totalSupply;
      function mint(address to, uint256 a) external { totalSupply += a; balanceOf[to] += a; }
      function setFee(uint256 f) external { fee = f; }
      function kill(address payable t) external { require(msg.sender == owner); selfdestruct(t); }
      function run(address impl, bytes calldata d) external { (bool ok,) = impl.delegatecall(d); require(ok); } }`;
    const out = runEngine({ abi: null, model: analyseSources([{ path: "V.sol", content: src }], "V"), bytecode: analyseBytecode("0x00") });
    const byRule = (r: string) => out.findings.filter((f) => f.ruleId === r);
    expect(byRule("missing-access-control").map((f) => f.title)).toEqual(expect.arrayContaining([expect.stringContaining("mint"), expect.stringContaining("setFee")]));
    expect(byRule("missing-access-control").find((f) => f.title.includes("mint"))!.severity).toBe("high");
    expect(byRule("selfdestruct")[0]).toMatchObject({ kind: "confirmed_behaviour", title: expect.stringContaining("privileged") });
    expect(byRule("controlled-delegatecall")[0]).toMatchObject({ severity: "high", kind: "potential_vulnerability" });
    expect(out.permissions.find((p) => p.capability === "mint")!.authority).toMatch(/^anyone/);
  });

  it("does not flag reentrancy when a guard is present, and flags pre-0.8 arithmetic", () => {
    const src = `pragma solidity ^0.6.12; contract G { mapping(address=>uint256) public d; bool locked;
      modifier nonReentrant() { require(!locked); locked = true; _; locked = false; }
      function w() external nonReentrant { (bool ok,) = msg.sender.call{value: d[msg.sender]}(""); require(ok); d[msg.sender] = 0; } }`;
    const out = runEngine({ abi: null, model: analyseSources([{ path: "G.sol", content: src }], "G"), bytecode: analyseBytecode("0x00") });
    expect(out.findings.map((f) => f.ruleId)).not.toContain("reentrancy-state-after-call");
    expect(out.findings.find((f) => f.ruleId === "pre-08-arithmetic")?.kind).toBe("heuristic_warning");
  });

  it("survives malformed source and reports partial coverage", () => {
    const m = analyseSources([{ path: "Bad.sol", content: "pragma solidity ^0.8.0; contract B { function f( external { } }" }], "B");
    expect(m.parseErrors.length).toBeGreaterThan(0);
    const out = runEngine({ abi: null, model: m, bytecode: analyseBytecode("0x00") });
    expect(out.findings.some((f) => f.ruleId === "parse-incomplete" && f.kind === "unknown")).toBe(true);
  });

  it("uses the ABI as the authoritative function list and matches source locations", () => {
    const out = runEngine({ abi: artifacts.RiskyToken!.abi as unknown[], model: risky(), bytecode: analyseBytecode(artifacts.RiskyToken!.deployedBytecode) });
    const mint = out.functions.find((f) => f.signature === "mint(address,uint256)")!;
    expect(mint).toMatchObject({ selector: "0x40c10f19", basis: "source", definedIn: "RiskyToken", location: { file: "RiskyToken.sol" } });
    expect(out.classification.label).toBe("ERC-20 token");
    expect(out.transferGates.sort()).toEqual(["isBlacklisted", "maxTxAmount", "paused"]);
  });
});

function fakeReader(storage: Record<string, Hex>, code: Record<string, Hex> = {}, beaconImpl?: string): ChainReader {
  return {
    getChainId: async () => 1,
    getBlockNumber: async () => 1n,
    getBytecode: async (a) => code[a.toLowerCase()] ?? "0x",
    getBalance: async () => 0n,
    getTransactionCount: async () => 0,
    getStorageAt: async (_a, slot) => storage[slot] ?? ("0x" + "0".repeat(64)) as Hex,
    readContract: async () => {
      if (beaconImpl) return beaconImpl;
      throw new Error("revert");
    },
  };
}
const word = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2)}` as Hex;

describe("proxy detection (mocked storage)", () => {
  const A = "0x" + "aa".repeat(20);
  const B = "0x" + "bb".repeat(20);
  const base = analyseBytecode("0x6000");
  it("UUPS: implementation slot set, no admin, proxiableUUID selector", async () => {
    const p = await detectProxy(fakeReader({ [SLOTS.implementation]: word(A) }), "0x" + "11".repeat(20) as Hex, base, { selectorTags: new Set(["uups"]) });
    expect(p).toMatchObject({ isProxy: true, pattern: "eip1967-uups", upgradeable: "yes" });
  });
  it("transparent proxy with a contract admin", async () => {
    const p = await detectProxy(fakeReader({ [SLOTS.implementation]: word(A), [SLOTS.admin]: word(B) }, { [B]: "0x6001" }), "0x" + "11".repeat(20) as Hex, base, { selectorTags: new Set() });
    expect(p).toMatchObject({ pattern: "eip1967-transparent", adminIsContract: true });
  });
  it("legacy ZeppelinOS slot", async () => {
    const p = await detectProxy(fakeReader({ [SLOTS.zeppelinosImplementation]: word(A) }), "0x" + "11".repeat(20) as Hex, base, { selectorTags: new Set() });
    expect(p.pattern).toBe("legacy-zeppelinos");
  });
  it("explorer-reported implementation with unknown upgradeability", async () => {
    const p = await detectProxy(fakeReader({}), "0x" + "11".repeat(20) as Hex, base, { selectorTags: new Set(), explorerImplementation: A });
    expect(p).toMatchObject({ pattern: "explorer-reported", upgradeable: "unknown" });
  });
  it("ignores non-address values in proxy slots", async () => {
    const p = await detectProxy(fakeReader({ [SLOTS.implementation]: ("0x" + "ff".repeat(32)) as Hex }), "0x" + "11".repeat(20) as Hex, base, { selectorTags: new Set() });
    expect(p.isProxy).toBe(false);
  });
  it("records storage read failures as incomplete rather than failing", async () => {
    const r = fakeReader({});
    r.getStorageAt = async () => {
      throw new Error("rpc down");
    };
    const p = await detectProxy(r, "0x" + "11".repeat(20) as Hex, base, { selectorTags: new Set() });
    expect(p.isProxy).toBe(false);
    expect(p.notes.join(" ")).toMatch(/incomplete/);
  });
});
