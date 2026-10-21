import { afterEach, describe, expect, it } from "vitest";
import { lookupVerifiedSource, parseExplorerSourceCode, type Fetcher } from "@/lib/explorer";
import { getNetwork } from "@/lib/networks/registry";

const ADDR = "0x1111111111111111111111111111111111111111";
const ok = (body: unknown) => ({ ok: true, status: 200, text: JSON.stringify(body) });

describe("explorer source parsing", () => {
  it("handles single-file source", () => {
    expect(parseExplorerSourceCode("contract A {}", "A")).toEqual([{ path: "A.sol", content: "contract A {}" }]);
  });
  it("handles Etherscan double-brace standard JSON (multi-file)", () => {
    const sj = { language: "Solidity", sources: { "src/A.sol": { content: "import './B.sol'; contract A {}" }, "src/B.sol": { content: "contract B {}" } } };
    const files = parseExplorerSourceCode(`{${JSON.stringify(sj)}}`, "A");
    expect(files.map((f) => f.path)).toEqual(["src/A.sol", "src/B.sol"]);
  });
  it("handles the legacy multi-file map", () => {
    const files = parseExplorerSourceCode(JSON.stringify({ "A.sol": { content: "a" }, "B.sol": { content: "b" } }), "A");
    expect(files).toHaveLength(2);
  });
});

describe("verified source lookup", () => {
  afterEach(() => delete process.env.ETHERSCAN_API_KEY);

  it("Robinhood: uses Blockscout, merges AdditionalSources, then stops", async () => {
    const calls: string[] = [];
    const f: Fetcher = async (url) => {
      calls.push(url);
      return ok({ status: "1", message: "OK", result: [{ SourceCode: "contract T {}", ABI: "[]", ContractName: "T", CompilerVersion: "v0.8.26", FileName: "T.sol", AdditionalSources: [{ Filename: "lib/L.sol", SourceCode: "library L {}" }] }] });
    };
    const r = await lookupVerifiedSource(getNetwork("robinhood")!, ADDR, f);
    expect(calls[0]).toBe(`https://robinhoodchain.blockscout.com/api?module=contract&action=getsourcecode&address=${ADDR}`);
    expect(calls).toHaveLength(1);
    expect(r.source?.files.map((x) => x.path)).toEqual(["T.sol", "lib/L.sol"]);
    expect(r.source?.provider).toBe("blockscout");
  });

  it("falls back to Sourcify when the explorer API fails", async () => {
    const f: Fetcher = async (url) => {
      if (url.includes("blockscout")) return { ok: false, status: 503, text: "down" };
      return ok({ match: "exact_match", abi: [], sources: { "X.sol": { content: "contract X {}" } }, compilation: { name: "X", compilerVersion: "0.8.20" } });
    };
    const r = await lookupVerifiedSource(getNetwork("robinhood")!, ADDR, f);
    expect(r.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual(["blockscout:unavailable", "sourcify:verified"]);
    expect(r.source?.contractName).toBe("X");
  });

  it("skips Etherscan without a key and records why", async () => {
    const f: Fetcher = async () => ({ ok: false, status: 404, text: "" });
    const r = await lookupVerifiedSource(getNetwork("base")!, ADDR, f);
    expect(r.source).toBeNull();
    expect(r.attempts).toEqual([
      expect.objectContaining({ provider: "etherscan-v2", outcome: "not_configured" }),
      expect.objectContaining({ provider: "sourcify", outcome: "not_verified" }),
    ]);
  });

  it("uses the Etherscan V2 chainid parameter and reports API errors", async () => {
    process.env.ETHERSCAN_API_KEY = "k";
    const urls: string[] = [];
    const f: Fetcher = async (url) => {
      urls.push(url);
      if (url.includes("etherscan")) return ok({ status: "0", message: "NOTOK", result: "Free API access is not supported for this chain" });
      return { ok: false, status: 404, text: "" };
    };
    const r = await lookupVerifiedSource(getNetwork("base")!, ADDR, f);
    expect(urls[0]).toContain("chainid=8453");
    expect(r.attempts[0]).toMatchObject({ outcome: "unavailable", detail: expect.stringContaining("Free API access") });
  });

  it("treats non-JSON and thrown fetches as unavailable without throwing", async () => {
    const f: Fetcher = async (url) => {
      if (url.includes("blockscout")) return { ok: true, status: 200, text: "<html>" };
      throw new Error("ECONNRESET");
    };
    const r = await lookupVerifiedSource(getNetwork("robinhood")!, ADDR, f);
    expect(r.source).toBeNull();
    expect(r.attempts.map((a) => a.outcome)).toEqual(["unavailable", "unavailable"]);
  });

  it("reports unverified contracts", async () => {
    const f: Fetcher = async (url) => (url.includes("/api?module=contract") ? ok({ status: "1", result: [{ SourceCode: "", ABI: "Contract source code not verified" }] }) : { ok: false, status: 404, text: "" });
    const r = await lookupVerifiedSource(getNetwork("robinhood-testnet")!, ADDR, f);
    expect(r.source).toBeNull();
    expect(r.attempts[0]!.outcome).toBe("not_verified");
  });
});
