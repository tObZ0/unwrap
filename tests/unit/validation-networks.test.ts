import { afterEach, describe, expect, it } from "vitest";
import { validateAddress } from "@/lib/analysis/pipeline";
import { getNetwork, getNetworks, publicNetworks, rpcUrlsFor } from "@/lib/networks/registry";

describe("address validation", () => {
  it("accepts lowercase and correctly checksummed addresses and returns EIP-55 form", () => {
    expect(validateAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    expect(validateAddress("  0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 ")).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });
  it.each(["", "0x123", "d8da6bf26964af9d7eed9e03e53415d37aa96045", "0xZZda6bf26964af9d7eed9e03e53415d37aa96045", "0xd8da6bf26964af9d7eed9e03e53415d37aa960451", "vitalik.eth"])(
    "rejects malformed input %j",
    (a) => expect(() => validateAddress(a)).toThrow(expect.objectContaining({ code: "INVALID_ADDRESS" })),
  );
  it("rejects a mixed-case address with a bad checksum", () => {
    expect(() => validateAddress("0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toThrow(/checksum/);
  });
});

describe("network registry", () => {
  afterEach(() => {
    delete process.env.UNWRAP_DISABLED_NETWORKS;
    delete process.env.ROBINHOOD_RPC_URL;
  });
  it("lists Robinhood Chain first with the official chain IDs", () => {
    const nets = getNetworks();
    expect(nets[0]).toMatchObject({ id: "robinhood", chainId: 4663, primary: true });
    expect(nets[1]).toMatchObject({ id: "robinhood-testnet", chainId: 46630, testnet: true });
    expect(nets[0]!.explorer.api.kind).toBe("blockscout");
    expect(nets[0]!.publicRpcUrls).toEqual(["https://rpc.mainnet.chain.robinhood.com"]);
  });
  it("includes every required network with distinct chain ids", () => {
    const ids = getNetworks().map((n) => n.id);
    expect(ids).toEqual(["robinhood", "robinhood-testnet", "ethereum", "base", "arbitrum", "bsc", "optimism", "polygon", "avalanche"]);
    const chainIds = getNetworks().map((n) => n.chainId);
    expect(new Set(chainIds).size).toBe(chainIds.length);
    expect(chainIds).toEqual([4663, 46630, 1, 8453, 42161, 56, 10, 137, 43114]);
  });
  it("returns undefined for unknown networks and supports disabling by env", () => {
    expect(getNetwork("solana")).toBeUndefined();
    process.env.UNWRAP_DISABLED_NETWORKS = "bsc, polygon";
    expect(getNetwork("bsc")!.enabled).toBe(false);
    expect(publicNetworks().map((n) => n.id)).not.toContain("polygon");
  });
  it("puts configured RPCs first, ignores non-https, and never exposes them publicly", () => {
    process.env.ROBINHOOD_RPC_URL = "https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY, http://insecure.example";
    expect(rpcUrlsFor(getNetwork("robinhood")!)).toEqual(["https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY", "https://rpc.mainnet.chain.robinhood.com"]);
    const pub = JSON.stringify(publicNetworks());
    expect(pub).not.toContain("SECRETKEY");
    expect(pub).not.toContain("alchemy");
    expect(publicNetworks()[0]!.dedicatedRpcConfigured).toBe(true);
  });
});

describe("local devnet opt-in", () => {
  afterEach(() => {
    delete process.env.UNWRAP_LOCAL_DEVNET_RPC_URL;
    delete process.env.UNWRAP_ALLOW_LOCAL_DEVNET_IN_PRODUCTION;
  });
  it("is absent by default and only accepts localhost URLs", () => {
    expect(getNetwork("local-devnet")).toBeUndefined();
    process.env.UNWRAP_LOCAL_DEVNET_RPC_URL = "http://169.254.169.254:80";
    expect(getNetwork("local-devnet")).toBeUndefined();
    process.env.UNWRAP_LOCAL_DEVNET_RPC_URL = "http://127.0.0.1:8545";
    expect(rpcUrlsFor(getNetwork("local-devnet")!)).toEqual(["http://127.0.0.1:8545"]);
  });
  it("does not let other networks use http RPCs", () => {
    process.env.ROBINHOOD_RPC_URL = "http://127.0.0.1:8545";
    expect(rpcUrlsFor(getNetwork("robinhood")!)).toEqual(["https://rpc.mainnet.chain.robinhood.com"]);
  });
});
