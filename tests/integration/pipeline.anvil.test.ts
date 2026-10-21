/**
 * End-to-end pipeline test against a REAL EVM node (anvil, Foundry).
 * Contracts are compiled with solc (tests/fixtures/compile.mjs) and deployed here.
 * Only the explorer HTTP is simulated. Skipped automatically if anvil is not installed.
 * Set ANVIL_BIN to the anvil binary path if it is not on PATH.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, getAddress, http, parseEther, type Address } from "viem";
import { foundry } from "viem/chains";
import { analyseContract, type PipelineDeps } from "@/lib/analysis/pipeline";
import { createChainReader } from "@/lib/networks/chain-reader";
import type { WorkerPost } from "@/lib/analysis/slither";
import { artifacts, fakeBlockscout, localNetwork } from "../helpers/fixtures";

const ANVIL = process.env.ANVIL_BIN ?? "anvil";
const hasAnvil = spawnSync(ANVIL, ["--version"]).status === 0;
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;

const direct: WorkerPost = async (url, body, headers, timeoutMs) => {
  const r = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(timeoutMs) });
  return { ok: r.ok, status: r.status, text: await r.text() };
};

describe.skipIf(!hasAnvil)("analysis pipeline on a live local chain", () => {
  let anvil: ChildProcess;
  const addr: Record<string, Address> = {};
  let deployer: Address;
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) });

  beforeAll(async () => {
    anvil = spawn(ANVIL, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const [first] = await createWalletClient({ chain: foundry, transport: http(RPC) }).getAddresses();
    deployer = getAddress(first!);
    const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: deployer });
    const deploy = async (name: string, args: unknown[] = []) => {
      const a = artifacts[name]!;
      const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
      const r = await pub.waitForTransactionReceipt({ hash });
      return getAddress(r.contractAddress!);
    };
    addr.risky = await deploy("RiskyToken", ["Risky Token", "RISK", parseEther("1000000")]);
    addr.renounced = await deploy("RiskyToken", ["Renounced", "RNC", parseEther("5")]);
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: addr.renounced, abi: artifacts.RiskyToken!.abi, functionName: "renounceOwnership" }) });
    addr.simple = await deploy("SimpleToken", [parseEther("21000000")]);
    addr.box = await deploy("Box");
    addr.proxy = await deploy("SimpleTransparentProxy", [addr.box]);
    addr.beacon = await deploy("Beacon", [addr.box]);
    addr.beaconProxy = await deploy("SimpleBeaconProxy", [addr.beacon]);
    addr.factory = await deploy("CloneFactory");
    const { result } = await pub.simulateContract({ address: addr.factory, abi: artifacts.CloneFactory!.abi, functionName: "clone", args: [addr.risky], account: deployer });
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: addr.factory, abi: artifacts.CloneFactory!.abi, functionName: "clone", args: [addr.risky] }) });
    addr.clone = getAddress(result as Address);
  }, 60_000);

  afterAll(() => anvil?.kill());

  let n = 0;
  const deps = (verified: Parameters<typeof fakeBlockscout>[0], network = localNetwork()): PipelineDeps => ({
    reader: createChainReader(network, [RPC]),
    fetchText: fakeBlockscout(verified),
    workerPost: direct,
    newId: () => `test-report-${String(++n).padStart(10, "0")}`,
  });
  const riskyVerified = () => ({ [addr.risky!]: { name: "RiskyToken", files: ["RiskyToken.sol", "Ownable.sol"], abi: artifacts.RiskyToken!.abi } });

  it("analyses a verified multi-file token from source", async () => {
    const r = await analyseContract(localNetwork(), addr.risky!, deps(riskyVerified()));
    expect(r.depth).toBe("source");
    expect(r.sources.map((s) => s.path).sort()).toEqual(["Ownable.sol", "RiskyToken.sol"]);
    expect(r.classification.label).toBe("ERC-20 token");
    expect(r.inheritance).toEqual(["RiskyToken", "Ownable"]);
    // Token metadata read from the chain
    expect(r.token).toMatchObject({ standard: "ERC-20", name: "Risky Token", symbol: "RISK", decimals: 18, totalSupply: parseEther("1000000").toString() });
    expect(r.token?.maxSupply).toBeUndefined(); // never inferred from totalSupply
    // Permissions with evidence
    const caps = r.permissions.map((p) => `${p.capability}:${p.authority}`);
    for (const c of ["mint:owner", "pause:owner", "blacklist:owner", "fee_change:owner", "limit_change:owner", "arbitrary_call:owner", "fee_change:anyone (no access check detected)"]) expect(caps).toContain(c);
    const mint = r.permissions.find((p) => p.capability === "mint")!;
    expect(mint.functions).toContain("mint(address,uint256)");
    expect(mint.evidence[0]!.location).toMatchObject({ file: "RiskyToken.sol" });
    // Security findings
    const rules = r.findings.map((f) => f.ruleId);
    for (const rule of ["reentrancy-state-after-call", "unchecked-low-level-call", "tx-origin-auth", "admin-controlled-transfer-conditions", "admin-fee-unbounded", "missing-access-control", "eoa-owner"]) expect(rules).toContain(rule);
    const reent = r.findings.find((f) => f.ruleId === "reentrancy-state-after-call")!;
    expect(reent.kind).toBe("potential_vulnerability");
    expect(reent.evidence[0]!.location?.line).toBe(87);
    // Ownership from chain
    expect(r.ownership?.owner).toBe(deployer);
    expect(r.ownership?.ownerIsContract).toBe(false);
    // Prompt-injection text in NatSpec is kept only as an attributed claim
    expect(r.findings.some((f) => /perfectly safe/i.test(f.explanation))).toBe(false);
    expect(r.onchain.note).toMatch(/not the value locked/);

    if (process.env.SLITHER_WORKER_URL) {
      expect(r.analysers.find((a) => a.name === "Slither")?.status).toBe("ran");
      expect(r.findings.some((f) => f.detector === "slither" && f.ruleId === "reentrancy-eth")).toBe(true);
    }
    if (process.env.UNWRAP_WRITE_SAMPLE === "1") {
      const sample = { ...r, id: "sample", sample: true };
      writeFileSync(path.join(__dirname, "..", "..", "src", "data", "sample-report.json"), JSON.stringify(sample, null, 1));
    }
  }, 120_000);

  it("falls back to bytecode-only analysis for unverified contracts", async () => {
    const r = await analyseContract(localNetwork(), addr.risky!, deps({}));
    expect(r.depth).toBe("bytecode");
    expect(r.sources).toEqual([]);
    expect(r.limitations[0]).toMatch(/not verified/);
    const names = r.functions.map((f) => f.name);
    for (const fn of ["mint", "pause", "transferOwnership", "setBlacklist", "balanceOf"]) expect(names).toContain(fn);
    expect(r.permissions.every((p) => p.confidence === "low")).toBe(true);
    expect(r.classification.standards.map((s) => s.name)).toContain("ERC-20");
    expect(r.token?.symbol).toBe("RISK");
  });

  it("treats owner()==0 cautiously and reports no other authorities", async () => {
    const r = await analyseContract(localNetwork(), addr.renounced!, deps({ [addr.renounced!]: { name: "RiskyToken", files: ["RiskyToken.sol", "Ownable.sol"], abi: artifacts.RiskyToken!.abi } }));
    expect(r.ownership?.ownerIsZero).toBe(true);
    expect(r.ownership?.assessment).toMatch(/consistent with ownership having been renounced/);
    expect(r.ownership?.assessment).toMatch(/would not be detected/);
    expect(r.findings.map((f) => f.ruleId)).not.toContain("eoa-owner");
  });

  it("finds no administrative permissions in a fixed-supply token", async () => {
    const r = await analyseContract(localNetwork(), addr.simple!, deps({ [addr.simple!]: { name: "SimpleToken", files: ["SimpleToken.sol"], abi: artifacts.SimpleToken!.abi } }));
    expect(r.permissions).toEqual([]);
    expect(r.ownership).toBeNull();
    expect(r.findings.filter((f) => f.severity !== "info" && f.detector !== "slither")).toEqual([]);
    expect(r.summary.join(" ")).toMatch(/No finding count means a contract is safe/);
  });

  it("detects an EIP-1967 transparent proxy and analyses the implementation", async () => {
    const r = await analyseContract(localNetwork(), addr.proxy!, deps({ [addr.box!]: { name: "Box", files: ["Proxies.sol"], abi: artifacts.Box!.abi } }));
    expect(r.proxy).toMatchObject({ isProxy: true, pattern: "eip1967-transparent", implementation: addr.box, admin: deployer, upgradeable: "yes", adminIsContract: false });
    expect(r.implementation).toMatchObject({ address: addr.box, verified: true });
    expect(r.sourceFromImplementation).toBe(true);
    expect(r.functions.map((f) => f.name)).toContain("setValue");
    const up = r.findings.find((f) => f.ruleId === "upgradeable-proxy")!;
    expect(up.title).toMatch(/single key/);
    expect(r.ownership?.otherAuthorities.join(" ")).toMatch(/proxy admin/);
  });

  it("detects a beacon proxy and resolves the implementation through the beacon", async () => {
    const r = await analyseContract(localNetwork(), addr.beaconProxy!, deps({}));
    expect(r.proxy).toMatchObject({ isProxy: true, pattern: "eip1967-beacon", beacon: addr.beacon, implementation: addr.box, upgradeable: "yes" });
  });

  it("detects an EIP-1167 minimal proxy as non-upgradeable", async () => {
    const r = await analyseContract(localNetwork(), addr.clone!, deps(riskyVerified()));
    expect(r.proxy).toMatchObject({ isProxy: true, pattern: "eip1167-minimal", implementation: addr.risky, upgradeable: "no" });
    expect(r.depth).toBe("source");
    expect(r.token?.name).toBeUndefined(); // clone storage is uninitialised: name is empty, not copied from the implementation
  });

  it("distinguishes an account with no code", async () => {
    await expect(analyseContract(localNetwork(), deployer, deps({}))).rejects.toMatchObject({ code: "NO_CONTRACT_CODE" });
  });

  it("refuses to analyse when the RPC serves a different chain", async () => {
    await expect(analyseContract(localNetwork(1), addr.risky!, deps({}, localNetwork(1)))).rejects.toMatchObject({ code: "CHAIN_ID_MISMATCH" });
  });

  it("reports an unavailable RPC clearly", async () => {
    const net = localNetwork();
    await expect(
      analyseContract(net, addr.risky!, { ...deps({}), reader: createChainReader({ ...net, id: "dead" }, ["http://127.0.0.1:1"]) }),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });
});
