import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { AppError } from "@/lib/errors";
import type { NetworkConfig } from "@/lib/networks/registry";
import { assertChainId, type ChainReader } from "@/lib/networks/chain-reader";
import { lookupVerifiedSource, type Fetcher, type SourceLookupResult } from "@/lib/explorer";
import { analyseBytecode, lookupSelector, type BytecodeFacts } from "./bytecode";
import { detectProxy } from "./proxy";
import { analyseSources, type SourceModel } from "./source-analyzer";
import { runEngine, type EngineOutput } from "./engine";
import { detectNftInterfaces, onchainFindings, readOwnership, readTokenInfo, sanitiseString } from "./onchain";
import { runSlither, type WorkerPost } from "./slither";
import { SEVERITY_ORDER, type AnalysisDepth, type Finding, type Report, type StepStatus, type TokenInfo, type VerifiedSource } from "./types";

export interface PipelineDeps {
  reader: ChainReader;
  fetchText: Fetcher;
  workerPost: WorkerPost;
  newId: () => string;
  now?: () => Date;
}

export function validateAddress(raw: string): Address {
  const s = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new AppError("INVALID_ADDRESS", "That is not a valid EVM address. Addresses are 0x followed by 40 hexadecimal characters.");
  }
  if (!isAddress(s)) {
    throw new AppError("INVALID_ADDRESS", "The address has mixed-case letters that fail its EIP-55 checksum. Check for a typo, or paste it in all lowercase.");
  }
  return getAddress(s);
}

function depthOf(source: VerifiedSource | null, model: SourceModel | null): AnalysisDepth {
  if (source && model && model.filesParsed > 0) return "source";
  if (source?.abi) return "abi";
  return "bytecode";
}

function sortFindings(f: Finding[]): Finding[] {
  return [...f].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/** Runs the full analysis. Throws AppError for input/network problems; never fabricates data. */
export async function analyseContract(network: NetworkConfig, rawAddress: string, deps: PipelineDeps): Promise<Report> {
  const steps: StepStatus[] = [];
  const limitations: string[] = [];
  const address = validateAddress(rawAddress);
  if (!network.enabled) throw new AppError("NETWORK_DISABLED", `${network.name} is disabled on this deployment.`);
  const { reader } = deps;

  // STEP 1 — connectivity, chain id, code presence.
  await assertChainId(reader, network);
  const [blockNumber, code] = await Promise.all([reader.getBlockNumber(), reader.getBytecode(address)]);
  if (!code || code === "0x") {
    const nonce = await reader.getTransactionCount(address).catch(() => undefined);
    throw new AppError(
      "NO_CONTRACT_CODE",
      nonce && nonce > 0
        ? `No contract code at this address on ${network.name}. It is a regular wallet (externally owned account) that has sent ${nonce} transaction(s).`
        : `No contract code at this address on ${network.name}. It may be a regular wallet, a contract on a different network, or a contract that has not been deployed yet.`,
      { network: network.id, address, nonce: nonce ?? null },
    );
  }
  steps.push({ step: "Validate input and network", status: "ok", detail: `Chain ID ${network.chainId} confirmed; block ${blockNumber}; ${(code.length - 2) / 2} bytes of code.` });

  // STEP 2 — on-chain account data.
  const [bal, nonce] = await Promise.allSettled([reader.getBalance(address), reader.getTransactionCount(address)]);
  const bytecode = analyseBytecode(code);
  steps.push({
    step: "Retrieve on-chain data",
    status: bal.status === "fulfilled" ? "ok" : "partial",
    detail: bal.status === "fulfilled" ? "Balance, nonce and bytecode retrieved." : "Bytecode retrieved; balance lookup failed.",
  });
  if (bytecode.eip7702Delegate) limitations.push(`This address is an EOA delegated to ${bytecode.eip7702Delegate} via EIP-7702. Its code is the delegate's code.`);

  // STEP 3 — verified source (contract itself).
  const own = await lookupVerifiedSource(network, address, deps.fetchText);
  const selectorTags = new Set(bytecode.selectors.flatMap((s) => lookupSelector(s).map((k) => k.tag)));

  // Proxy detection (needs storage reads).
  const proxy = await detectProxy(reader, address, bytecode, { explorerImplementation: own.source?.explorerImplementation, selectorTags });

  let logicSource: VerifiedSource | null = own.source;
  let logicBytecode: BytecodeFacts = bytecode;
  let implLookup: SourceLookupResult | null = null;
  let sourceFromImplementation = false;
  let implementationSummary: Report["implementation"];
  if (proxy.isProxy && proxy.implementation) {
    const implAddr = proxy.implementation as Address;
    const implCode = await reader.getBytecode(implAddr).catch(() => undefined);
    if (implCode && implCode !== "0x") logicBytecode = analyseBytecode(implCode);
    else limitations.push("The implementation address has no code, or its code could not be read.");
    implLookup = await lookupVerifiedSource(network, implAddr, deps.fetchText);
    if (implLookup.source) {
      logicSource = implLookup.source;
      sourceFromImplementation = true;
    } else {
      logicSource = null;
      limitations.push("The implementation contract's source is not verified, so its behaviour was analysed from bytecode only.");
    }
    implementationSummary = {
      address: implAddr,
      contractName: implLookup.source?.contractName ?? null,
      verified: Boolean(implLookup.source),
      depth: implLookup.source ? "source" : "bytecode",
    };
  }
  const attempts = [...own.attempts, ...(implLookup?.attempts.map((a) => ({ ...a, detail: `Implementation: ${a.detail}` })) ?? [])];
  steps.push({
    step: "Retrieve verified source",
    status: logicSource ? "ok" : attempts.some((a) => a.outcome === "unavailable") ? "failed" : "partial",
    detail: attempts.length ? attempts.map((a) => `${a.provider}: ${a.detail}`).join(" ") : `${network.name} has no source verification service configured.`,
  });
  if (attempts.some((a) => a.outcome === "unavailable")) {
    limitations.push("One or more verification services could not be reached. The contract may be verified on a service UNWRAP could not query.");
  }

  // STEP 4/5 — parse and analyse.
  let model: SourceModel | null = null;
  if (logicSource) {
    model = analyseSources(logicSource.files, logicSource.contractName);
    if (model.filesParsed === 0) model = null;
  }
  const depth = depthOf(logicSource, model);
  const engine: EngineOutput = runEngine({ abi: logicSource?.abi ?? null, model, bytecode, logicBytecode, compilerVersion: logicSource?.compilerVersion });
  steps.push({
    step: "Analyse functions and permissions",
    status: depth === "bytecode" ? "partial" : "ok",
    detail:
      depth === "source"
        ? `Parsed ${model!.filesParsed} source file(s); ${engine.functions.length} externally callable functions.`
        : depth === "abi"
          ? "ABI available but the source could not be parsed; function list from ABI only."
          : `Bytecode only: ${logicBytecode.selectors.length} function selectors found in the dispatcher.`,
  });

  // Proxy's own admin surface, when the proxy itself is verified.
  let proxyEngine: EngineOutput | null = null;
  if (proxy.isProxy && own.source && sourceFromImplementation) {
    const pm = analyseSources(own.source.files, own.source.contractName);
    proxyEngine = runEngine({ abi: own.source.abi, model: pm.filesParsed ? pm : null, bytecode, compilerVersion: own.source.compilerVersion });
  }

  // Slither (isolated worker).
  const slither = await runSlither(depth === "source" ? logicSource : null, deps.workerPost);

  // Token data (read at the proxy address: that is where state lives).
  let token: TokenInfo | null = null;
  const std = engine.classification.standards.map((s) => s.name);
  try {
    if (std.includes("ERC-20") || std.includes("ERC-20 (partial)")) token = await readTokenInfo(reader, address, "ERC-20", engine.functions);
    else if (std.includes("ERC-721")) token = await readTokenInfo(reader, address, "ERC-721", engine.functions);
    else if (std.includes("ERC-1155")) token = await readTokenInfo(reader, address, "ERC-1155", engine.functions);
    else if (depth === "bytecode") {
      const nft = await detectNftInterfaces(reader, address);
      if (nft.erc721) {
        engine.classification.standards.push({ name: "ERC-721", confidence: "high", evidence: "supportsInterface(0x80ac58cd) returned true on-chain." });
        engine.classification.label = "NFT collection (ERC-721)";
        token = await readTokenInfo(reader, address, "ERC-721", engine.functions);
      } else if (nft.erc1155) {
        engine.classification.standards.push({ name: "ERC-1155", confidence: "high", evidence: "supportsInterface(0xd9b67a26) returned true on-chain." });
        engine.classification.label = "Multi-token (ERC-1155)";
        token = await readTokenInfo(reader, address, "ERC-1155", engine.functions);
      }
    }
  } catch {
    limitations.push("Token metadata could not be read.");
  }

  const permissions = [...engine.permissions, ...(proxyEngine?.permissions.map((p) => ({ ...p, id: `PROXY-${p.id}`, title: `Proxy: ${p.title}` })) ?? [])];
  const ownership = await readOwnership(reader, address, engine.functions, permissions, proxy).catch(() => null);
  const findings = sortFindings([
    ...onchainFindings(proxy, ownership, permissions),
    ...engine.findings,
    ...(proxyEngine?.findings.filter((f) => f.severity !== "info").map((f) => ({ ...f, id: `PROXY-${f.id}`, title: `Proxy: ${f.title}` })) ?? []),
    ...slither.findings,
  ]);
  steps.push({
    step: "Security analysis",
    status: slither.status === "failed" ? "partial" : "ok",
    detail: `UNWRAP static rules: ${engine.findings.length} result(s). ${slither.detail}`,
  });

  // Limitations that always apply.
  if (depth === "bytecode") {
    limitations.unshift(
      "Source code is not verified. Function names were inferred by matching selectors against known signatures, and behaviour, access control and security findings could not be established at source level.",
    );
  }
  if (proxy.isProxy) limitations.push("This analysis describes the current implementation. If the proxy is upgraded, behaviour can change.");
  limitations.push(
    "No transaction simulation was run. UNWRAP does not test whether tokens can be bought or sold.",
    "Static analysis finds known patterns. It cannot prove a contract is safe, and the absence of findings is not evidence of safety.",
    "Source comments and NatSpec are written by the contract author and are shown as claims, not facts.",
  );

  const balanceWei = bal.status === "fulfilled" ? bal.value : undefined;
  const report: Report = {
    id: deps.newId(),
    schemaVersion: 1,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    network: { id: network.id, name: network.name, chainId: network.chainId, explorerUrl: network.explorer.url },
    address,
    contractName: sanitiseString(logicSource?.contractName ?? own.source?.contractName ?? null, 120) ?? null,
    depth,
    verification: {
      verified: Boolean(own.source || implLookup?.source),
      provider: logicSource?.provider ?? own.source?.provider ?? null,
      compilerVersion: logicSource?.compilerVersion,
      license: logicSource?.license,
      note: own.source
        ? `Verified on ${own.source.provider}.${sourceFromImplementation ? ` Implementation verified on ${implLookup!.source!.provider}.` : ""}`
        : sourceFromImplementation
          ? `The proxy itself is not verified; the implementation is verified on ${implLookup!.source!.provider}.`
          : "No verified source found on the services UNWRAP queried.",
    },
    onchain: {
      blockNumber: blockNumber.toString(),
      bytecodeSize: bytecode.size,
      bytecodeHash: bytecode.hash,
      balanceWei: balanceWei?.toString(),
      balanceFormatted: balanceWei !== undefined ? `${formatUnits(balanceWei, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}` : undefined,
      nonce: nonce.status === "fulfilled" ? nonce.value : undefined,
      note: "The balance is native currency held by this contract only. It is not the value locked in a protocol, and it does not include tokens.",
    },
    classification: engine.classification,
    summary: [],
    proxy,
    implementation: implementationSummary,
    token,
    ownership,
    functions: engine.functions,
    events: engine.events,
    modifiers: engine.modifiers,
    inheritance: engine.inheritance,
    permissions,
    findings,
    sources: logicSource?.files ?? [],
    sourceFromImplementation,
    limitations,
    steps,
    analysers: [
      { name: "UNWRAP AST rules", status: depth === "source" ? "ran" : "not_applicable", detail: depth === "source" ? "Solidity AST analysis via @solidity-parser/parser." : "Requires verified source." },
      { name: "UNWRAP bytecode rules", status: "ran", detail: "Selector extraction, opcode scan, proxy templates." },
      { name: "Slither", status: slither.status, detail: slither.detail },
    ],
  };
  report.summary = buildSummary(report);
  return report;
}

const CAP_WORDS: Record<string, string> = {
  mint: "minting",
  pause: "pausing",
  blacklist: "blocking addresses",
  upgrade: "upgrading code",
  fee_change: "changing fees",
  limit_change: "changing limits",
  arbitrary_call: "arbitrary calls",
  withdraw: "moving funds",
  transfer_restriction: "controlling trading",
  burn: "burning",
  whitelist: "exempting addresses",
  role_management: "managing roles",
};

export function buildSummary(r: Report): string[] {
  const s: string[] = [];
  const name = r.contractName ? `${r.contractName}: ` : "";
  s.push(
    `${name}${r.classification.label} on ${r.network.name}. ${
      r.depth === "source" ? `Analysed from verified source (${r.verification.provider}).` : r.depth === "abi" ? "Analysed from the verified ABI only." : "Source is not verified; analysis is limited to bytecode."
    }`,
  );
  if (r.proxy.isProxy) {
    s.push(
      r.proxy.upgradeable === "yes"
        ? `Upgradeable proxy (${r.proxy.pattern}). Its logic lives at ${r.proxy.implementation ?? "an unresolved address"} and can be replaced.`
        : r.proxy.upgradeable === "no"
          ? `Non-upgradeable proxy (${r.proxy.pattern}) delegating to ${r.proxy.implementation}.`
          : `Proxy (${r.proxy.pattern}); whether it can be upgraded was not determined.`,
    );
  }
  const caps = [...new Set(r.permissions.filter((p) => !p.authority.startsWith("anyone")).map((p) => CAP_WORDS[p.capability]).filter(Boolean))];
  if (caps.length) s.push(`Privileged accounts can perform: ${caps.slice(0, 6).join(", ")}.`);
  else if (r.depth === "source") s.push("No privileged administrative capabilities were detected in the source.");
  const open = r.permissions.filter((p) => p.authority.startsWith("anyone"));
  if (open.length) s.push(`${open.length} sensitive capability group(s) appear callable by anyone; see Permissions.`);
  if (r.ownership) s.push(r.ownership.assessment);
  const pv = r.findings.filter((f) => f.kind === "potential_vulnerability").length;
  const hw = r.findings.filter((f) => f.kind === "heuristic_warning").length;
  const cb = r.findings.filter((f) => f.kind === "confirmed_behaviour").length;
  s.push(
    `${pv} potential vulnerabilit${pv === 1 ? "y" : "ies"}, ${hw} heuristic warning(s) and ${cb} confirmed risky behaviour(s) detected. No finding count means a contract is safe.`,
  );
  return s;
}
