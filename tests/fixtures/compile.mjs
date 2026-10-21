// Compiles the fixture contracts with a native solc binary and writes artifacts.json.
// Usage: SOLC=/path/to/solc node tests/fixtures/compile.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = path.join(import.meta.dirname, "contracts");
const sources = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".sol")).map((f) => [f, { content: readFileSync(path.join(dir, f), "utf8") }]));
const input = { language: "Solidity", sources, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } };
const out = JSON.parse(execFileSync(process.env.SOLC ?? "solc", ["--standard-json", "--allow-paths", dir], { input: JSON.stringify(input), cwd: dir, maxBuffer: 64 << 20 }).toString());
const errors = (out.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) { console.error(errors.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const artifacts = {};
for (const [file, contracts] of Object.entries(out.contracts)) for (const [name, c] of Object.entries(contracts)) artifacts[name] = { file, abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}` };
writeFileSync(path.join(import.meta.dirname, "artifacts.json"), JSON.stringify({ compiler: "0.8.26", artifacts }, null, 1));
console.log("compiled:", Object.keys(artifacts).join(", "));
