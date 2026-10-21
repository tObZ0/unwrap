/**
 * Live Robinhood Chain checks against real public infrastructure.
 * Run: UNWRAP_LIVE_TESTS=1 npm run test:live
 * Needs outbound access to the Robinhood RPCs and Blockscout explorers.
 *
 * Contract addresses come from their issuers' documentation (not invented):
 *  - Testnet WETH: https://docs.robinhood.com/chain/contracts
 *  - Mainnet USDG: https://docs.paxos.com/guides/stablecoin/usdg/mainnet
 */
import { describe, expect, it } from "vitest";
import { getNetwork } from "@/lib/networks/registry";
import { assertChainId, createChainReader } from "@/lib/networks/chain-reader";
import { analyseContract } from "@/lib/analysis/pipeline";
import { fetchText, postJson } from "@/lib/server/services";
import { newReportId } from "@/lib/server/http";

const TESTNET_WETH = "0x7943e237c7F95DA44E0301572D358911207852Fa";
const MAINNET_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

describe("Robinhood Chain (live)", () => {
  const deps = (id: string) => ({ reader: createChainReader(getNetwork(id)!), fetchText, workerPost: postJson, newId: newReportId });

  it("mainnet RPC serves chain ID 4663", async () => {
    const n = getNetwork("robinhood")!;
    await assertChainId(createChainReader(n), n);
  });

  it("testnet RPC serves chain ID 46630", async () => {
    const n = getNetwork("robinhood-testnet")!;
    await assertChainId(createChainReader(n), n);
  });

  it("analyses testnet WETH end to end", async () => {
    const r = await analyseContract(getNetwork("robinhood-testnet")!, TESTNET_WETH, deps("robinhood-testnet"));
    expect(r.onchain.bytecodeSize).toBeGreaterThan(0);
    expect(r.classification.standards.map((s) => s.name)).toContain("ERC-20");
    expect(r.token?.symbol).toBeTruthy();
    console.log(JSON.stringify({ depth: r.depth, steps: r.steps, proxy: r.proxy.pattern, token: r.token }, null, 1));
  }, 120_000);

  it("analyses mainnet USDG (expected: upgradeable proxy with verified source)", async () => {
    const r = await analyseContract(getNetwork("robinhood")!, MAINNET_USDG, deps("robinhood"));
    expect(r.onchain.bytecodeSize).toBeGreaterThan(0);
    console.log(JSON.stringify({ name: r.contractName, depth: r.depth, proxy: r.proxy, token: r.token, perms: r.permissions.map((p) => p.title), steps: r.steps }, null, 1));
  }, 120_000);

  it("reports no contract code for an address without code", async () => {
    await expect(analyseContract(getNetwork("robinhood")!, "0x000000000000000000000000000000000000dEaD", deps("robinhood"))).rejects.toMatchObject({ code: "NO_CONTRACT_CODE" });
  }, 60_000);
});
