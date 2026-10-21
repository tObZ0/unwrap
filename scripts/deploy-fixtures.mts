// Deploys UNWRAP test fixtures to a local dev chain (anvil). Usage: RPC=http://127.0.0.1:8545 npx tsx scripts/deploy-fixtures.mts
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { foundry } from "viem/chains";
import { readFileSync } from "node:fs";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const a = JSON.parse(readFileSync(new URL("../tests/fixtures/artifacts.json", import.meta.url),"utf8")).artifacts;
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const [acct] = await createWalletClient({ chain: foundry, transport: http(RPC) }).getAddresses();
const w = createWalletClient({ chain: foundry, transport: http(RPC), account: acct! });
const dep = async (n: string, args: unknown[] = []) => (await pub.waitForTransactionReceipt({ hash: await w.deployContract({ abi: a[n].abi, bytecode: a[n].bytecode, args }) })).contractAddress;
const risky = await dep("RiskyToken", ["Risky Token", "RISK", parseEther("1000000")]);
const box = await dep("Box"); const proxy = await dep("SimpleTransparentProxy", [box]);
console.log(JSON.stringify({ risky, proxy, eoa: acct }));
