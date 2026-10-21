import { readFileSync } from "node:fs";
import path from "node:path";
import type { Abi, Hex } from "viem";
import type { Fetcher } from "@/lib/explorer";
import type { NetworkConfig } from "@/lib/networks/registry";
import { getNetwork } from "@/lib/networks/registry";

const dir = path.join(__dirname, "..", "fixtures");
export const artifacts = JSON.parse(readFileSync(path.join(dir, "artifacts.json"), "utf8")).artifacts as Record<string, { file: string; abi: Abi; bytecode: Hex; deployedBytecode: Hex }>;
export const source = (f: string) => readFileSync(path.join(dir, "contracts", f), "utf8");

/** A network entry pointing at a local dev chain, derived from a real registry entry. */
export function localNetwork(chainId = 31337): NetworkConfig {
  const base = getNetwork("robinhood")!;
  return { ...base, id: "local-anvil", name: "Local development chain (anvil)", shortName: "Local", chainId, primary: false, testnet: true, explorer: { name: "Blockscout (simulated)", url: "", api: { kind: "blockscout", baseUrl: "https://explorer.invalid" } }, sourcify: false };
}

/** Blockscout-shaped responses: verified source for listed addresses, "not verified" otherwise. */
export function fakeBlockscout(verified: Record<string, { name: string; files: string[]; abi: Abi }>): Fetcher {
  return async (url) => {
    const addr = new URL(url).searchParams.get("address")!.toLowerCase();
    const v = Object.entries(verified).find(([a]) => a.toLowerCase() === addr)?.[1];
    if (!v) return { ok: true, status: 200, text: JSON.stringify({ message: "OK", status: "1", result: [{ SourceCode: "", ABI: "Contract source code not verified" }] }) };
    const [main, ...rest] = v.files;
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({
        message: "OK",
        status: "1",
        result: [{ SourceCode: source(main!), ABI: JSON.stringify(v.abi), ContractName: v.name, CompilerVersion: "v0.8.26+commit.8a97fa7a", OptimizationUsed: "1", Runs: "200", FileName: main, AdditionalSources: rest.map((f) => ({ Filename: f, SourceCode: source(f) })), LicenseType: "MIT" }],
      }),
    };
  };
}
