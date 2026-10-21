import { toFunctionSelector, toEventSelector, type AbiFunction, type AbiEvent, type AbiParameter } from "viem";
import { lookupSelector, type BytecodeFacts } from "./bytecode";
import { accessControlOf, isInitializerGuarded, type FunctionModel, type SourceModel, type AccessInfo } from "./source-analyzer";
import type {
  Classification,
  Confidence,
  ContractEvent,
  ContractFunction,
  Evidence,
  Finding,
  Permission,
  PermissionCapability,
  SourceLocation,
} from "./types";

/**
 * Turns raw facts (ABI, AST model, bytecode) into the report's functions,
 * permissions and findings. Deterministic: same input, same output.
 */

export interface EngineInput {
  abi: unknown[] | null;
  model: SourceModel | null;
  bytecode: BytecodeFacts;
  /** Bytecode of the analysed logic (the implementation for proxies). */
  logicBytecode?: BytecodeFacts;
  /** If sources were attached to an implementation, file paths are relative to it. */
  sourceLabel?: string;
  /** Exact compiler version from the verifier (e.g. "0.8.28+commit…"), when known. */
  compilerVersion?: string;
}

export interface EngineOutput {
  functions: ContractFunction[];
  events: ContractEvent[];
  modifiers: string[];
  inheritance: string[];
  permissions: Permission[];
  findings: Finding[];
  classification: Classification;
  /** Names of state variables that admin functions can change and transfers depend on. */
  transferGates: string[];
}

// ---- ABI helpers -----------------------------------------------------------

function canonicalParam(p: AbiParameter): string {
  if (p.type.startsWith("tuple")) {
    const comps = ((p as { components?: AbiParameter[] }).components ?? []).map(canonicalParam).join(",");
    return `(${comps})${p.type.slice(5)}`;
  }
  return p.type;
}

function abiFunctions(abi: unknown[] | null): AbiFunction[] {
  return (abi ?? []).filter((x): x is AbiFunction => typeof x === "object" && x !== null && (x as { type?: string }).type === "function");
}

function abiEvents(abi: unknown[] | null): AbiEvent[] {
  return (abi ?? []).filter((x): x is AbiEvent => typeof x === "object" && x !== null && (x as { type?: string }).type === "event");
}

function safeSelector(f: AbiFunction): string | undefined {
  try {
    return toFunctionSelector(f);
  } catch {
    return undefined;
  }
}

// ---- Capability tagging ---------------------------------------------------

const RE = {
  pauseVar: /paused|^_?pause/i,
  blacklistVar: /black|blocked|isBot|bots|frozen|banned|denied|sniper|blocklist/i,
  whitelistVar: /whitelist|allowlist|isExcluded|excluded|exempt|isAllowed|allowedAddress/i,
  feeVar: /fee|tax/i,
  limitVar: /max(Tx|Transaction|Wallet|Hold|Buy|Sell|Amount)|limit|cooldown/i,
  tradingVar: /trading(Enabled|Open|Active|Allowed)?|tradeEnabled|launched|launchBlock|swapEnabled/i,
  ownerVar: /^_?owner$|^_?pendingOwner$/i,
  implVar: /implementation|^_?impl$|logic/i,
  supplyVar: /^_?totalSupply$/i,
};

export const CAPABILITY_TEXT: Record<PermissionCapability, { title: string; explain: string }> = {
  mint: {
    title: "Can create new tokens",
    explain:
      "An authorised account can increase the token supply. Unless a cap is enforced elsewhere, new supply can dilute existing holders.",
  },
  burn: {
    title: "Can destroy tokens",
    explain: "This function removes tokens from circulation. Check whose tokens can be burned: the caller's own, or other holders'.",
  },
  pause: { title: "Can pause the contract", explain: "An authorised account can switch the contract into a paused state that blocks some operations, such as transfers." },
  blacklist: {
    title: "Can block specific addresses",
    explain: "An authorised account can mark addresses so that they are treated differently, typically preventing them from transferring.",
  },
  whitelist: { title: "Can exempt specific addresses", explain: "An authorised account can mark addresses as exempt or allowed, giving them different rules from other users." },
  transfer_restriction: {
    title: "Can control when trading is allowed",
    explain: "An authorised account can turn trading or transfers on or off, or change launch-related restrictions.",
  },
  fee_change: { title: "Can change fees", explain: "An authorised account can change fee or tax parameters, or where fees are sent." },
  limit_change: { title: "Can change transaction or wallet limits", explain: "An authorised account can change limits such as maximum transaction size or wallet holdings." },
  upgrade: {
    title: "Can change the contract's code",
    explain: "An authorised account can point the contract at new logic. Future behaviour can therefore differ from the code analysed today.",
  },
  arbitrary_call: {
    title: "Can make arbitrary calls from the contract",
    explain: "An authorised account can make this contract call any address with any data, which can include moving assets the contract holds.",
  },
  withdraw: { title: "Can move funds out of the contract", explain: "This function sends native currency or tokens held by the contract to an address." },
  ownership_transfer: { title: "Can hand over control", explain: "The current controller can transfer administrative ownership to another address." },
  role_management: { title: "Can grant or revoke roles", explain: "An administrator can grant or remove roles, changing who holds privileged permissions." },
  renounce: {
    title: "Can give up ownership",
    explain: "The owner can renounce ownership. Whether this removes all control depends on any other roles and upgrade authorities.",
  },
  other_admin: { title: "Other administrative action", explain: "A restricted function that changes contract state in a way not covered by the other categories." },
};

function tagsFromName(name: string): PermissionCapability[] {
  const n = name.toLowerCase();
  const t: PermissionCapability[] = [];
  if (/^(mint|_mint|mintto|safemint|issue)/.test(n)) t.push("mint");
  if (/burn/.test(n)) t.push("burn");
  if (/^(pause|unpause|setpaused|togglepause)$/.test(n)) t.push("pause");
  if (/blacklist|blocklist|addbot|setbot|freeze|ban/.test(n)) t.push("blacklist");
  if (/whitelist|allowlist|exclude|exempt/.test(n)) t.push("whitelist");
  if (/enabletrading|opentrading|settradingenabled|starttrading|launch/.test(n)) t.push("transfer_restriction");
  if (/^set.*(fee|tax)|^update.*(fee|tax)/.test(n)) t.push("fee_change");
  if (/^set.*(max|limit)|removelimits/.test(n)) t.push("limit_change");
  if (/^upgradeto|^changeadmin|^setimplementation/.test(n)) t.push("upgrade");
  if (/withdraw|rescue|recover|sweep|skim|emergency/.test(n)) t.push("withdraw");
  if (/^(transferownership|acceptownership|setowner)$/.test(n)) t.push("ownership_transfer");
  if (/^(grantrole|revokerole)$/.test(n)) t.push("role_management");
  if (n === "renounceownership") t.push("renounce");
  return t;
}

function tagsFromEffects(f: FunctionModel): PermissionCapability[] {
  const e = f.effective;
  const writes = [...e.stateWrites.keys()];
  const t = new Set<PermissionCapability>();
  if (e.internalCalls.has("_mint") || e.internalCalls.has("_safeMint")) t.add("mint");
  if (e.internalCalls.has("_burn")) t.add("burn");
  if (e.internalCalls.has("_pause") || e.internalCalls.has("_unpause") || writes.some((w) => RE.pauseVar.test(w))) t.add("pause");
  if (writes.some((w) => RE.blacklistVar.test(w))) t.add("blacklist");
  if (writes.some((w) => RE.whitelistVar.test(w))) t.add("whitelist");
  if (writes.some((w) => RE.tradingVar.test(w))) t.add("transfer_restriction");
  if (writes.some((w) => RE.feeVar.test(w))) t.add("fee_change");
  if (writes.some((w) => RE.limitVar.test(w))) t.add("limit_change");
  if (writes.some((w) => RE.implVar.test(w)) || e.internalCalls.has("_upgradeTo") || e.internalCalls.has("_upgradeToAndCall") || e.internalCalls.has("_setImplementation"))
    t.add("upgrade");
  if (writes.some((w) => RE.ownerVar.test(w)) || e.internalCalls.has("_transferOwnership")) t.add(f.name === "renounceOwnership" ? "renounce" : "ownership_transfer");
  if (e.internalCalls.has("_grantRole") || e.internalCalls.has("_revokeRole")) t.add("role_management");
  const valueOut = e.externalCalls.some((c) => (c.sendsValue && c.kind !== "delegatecall") || c.tokenTransfer);
  if (valueOut && !e.externalCalls.every((c) => /msg\.sender/.test(c.text))) t.add("withdraw");
  if (e.externalCalls.some((c) => (c.kind === "call" || c.kind === "delegatecall") && c.targetIsParam && c.dataIsParam)) t.add("arbitrary_call");
  return [...t];
}

// ---- Explanations ---------------------------------------------------------

const STANDARD_EXPLANATIONS: Record<string, string> = {
  "name()": "Returns the token's display name.",
  "symbol()": "Returns the token's ticker symbol.",
  "decimals()": "Returns how many decimal places the token uses for display.",
  "totalSupply()": "Returns how many tokens currently exist.",
  "balanceOf(address)": "Returns how many tokens an address holds.",
  "allowance(address,address)": "Returns how many tokens a spender is still allowed to move on an owner's behalf.",
  "transfer(address,uint256)": "Sends tokens from the caller to another address.",
  "approve(address,uint256)": "Lets another address spend up to a set amount of the caller's tokens.",
  "transferFrom(address,address,uint256)": "Moves tokens on an owner's behalf, using an allowance they previously approved.",
  "owner()": "Returns the address currently recorded as the contract owner.",
  "transferOwnership(address)": "Hands ownership to a new address.",
  "renounceOwnership()": "Sets the owner to the zero address, giving up owner-only powers held through this mechanism.",
  "paused()": "Returns whether the contract is currently paused.",
  "ownerOf(uint256)": "Returns the owner of a specific NFT.",
  "tokenURI(uint256)": "Returns the metadata link for a specific NFT.",
  "supportsInterface(bytes4)": "Reports which standard interfaces the contract claims to implement (ERC-165).",
  "setApprovalForAll(address,bool)": "Lets an operator manage all of the caller's NFTs, or revokes that permission.",
  "hasRole(bytes32,address)": "Checks whether an address holds a given role.",
  "grantRole(bytes32,address)": "Gives a role to an address. Restricted to that role's admin.",
  "revokeRole(bytes32,address)": "Removes a role from an address. Restricted to that role's admin.",
  "upgradeTo(address)": "Points the proxy at new implementation code.",
  "upgradeToAndCall(address,bytes)": "Points the proxy at new implementation code and immediately calls it.",
  "proxiableUUID()": "Identifies this contract as a UUPS-upgradeable implementation (ERC-1822).",
  "implementation()": "Returns the address of the logic contract this proxy uses.",
};

function explainFunction(
  sig: string,
  mutability: string,
  tags: string[],
  access: AccessInfo | null,
  f: FunctionModel | null,
): string {
  const parts: string[] = [];
  const std = STANDARD_EXPLANATIONS[sig];
  if (std) parts.push(std);
  else if (mutability === "view" || mutability === "pure") parts.push("Read-only: returns information without changing anything on-chain.");
  else if (f?.kind === "receive") parts.push("Runs when the contract receives native currency with no data.");
  else if (f?.kind === "fallback") parts.push("Runs when a call does not match any other function.");
  else {
    for (const t of tags) if (t in CAPABILITY_TEXT) parts.push(`${CAPABILITY_TEXT[t as PermissionCapability].title}.`);
    if (f && parts.length === 0) {
      const writes = [...f.effective.stateWrites.keys()].slice(0, 4);
      if (writes.length) parts.push(`Changes stored values: ${writes.join(", ")}.`);
    }
    if (parts.length === 0) parts.push("Changes contract state.");
  }
  if (mutability === "payable") parts.push("Accepts native currency with the call.");
  if (f && mutability !== "view" && mutability !== "pure") {
    const ext = f.effective.externalCalls;
    if (ext.some((c) => c.sendsValue)) parts.push("Sends native currency.");
    if (ext.some((c) => c.kind === "delegatecall")) parts.push("Runs code from another contract in this contract's context (delegatecall).");
    else if (ext.some((c) => c.kind === "call" || c.kind === "external")) parts.push("Calls other contracts.");
  }
  if (access?.restricted) parts.push(`Restricted: ${access.authority ?? "privileged caller"} only (${access.mechanism}).`);
  else if (f && mutability !== "view" && mutability !== "pure" && !std) parts.push("No caller restriction was detected.");
  return parts.join(" ");
}

// ---- Main -----------------------------------------------------------------

function loc(f: FunctionModel): SourceLocation {
  return { file: f.file, line: f.line, endLine: f.endLine };
}

function matchModel(model: SourceModel | null, name: string, types: string[]): FunctionModel | null {
  if (!model) return null;
  const cands = model.callable.filter((f) => f.name === name && f.params.length === types.length);
  if (cands.length <= 1) return cands[0] ?? null;
  return cands.find((f) => f.params.every((p, i) => p.abiType === null || p.abiType === types[i])) ?? cands[0] ?? null;
}

const NON_REENTRANT_RE = /nonReentrant|noReentrancy|lock|mutex|reentrancyGuard/i;
const TRANSFER_PATH = new Set(["_transfer", "_update", "_beforeTokenTransfer", "_afterTokenTransfer", "transfer", "transferFrom", "_transferFrom", "_tokenTransfer"]);

export function runEngine(input: EngineInput): EngineOutput {
  const { abi, model, bytecode } = input;
  const logic = input.logicBytecode ?? bytecode;
  const functions: ContractFunction[] = [];
  const fnModels = new Map<string, FunctionModel>(); // signature -> model
  const accessBySig = new Map<string, AccessInfo>();

  // 1. Function inventory.
  const abiFns = abiFunctions(abi);
  if (abiFns.length) {
    for (const af of abiFns) {
      const types = af.inputs.map(canonicalParam);
      const sig = `${af.name}(${types.join(",")})`;
      const m = matchModel(model, af.name, types);
      const access = m && model ? accessControlOf(m, model) : null;
      const tags = new Set<string>([...tagsFromName(af.name), ...(m ? tagsFromEffects(m) : [])]);
      if (af.stateMutability === "view" || af.stateMutability === "pure") for (const t of [...tags]) if (t !== "upgrade") tags.delete(t);
      if (m) fnModels.set(sig, m);
      if (access) accessBySig.set(sig, access);
      functions.push({
        name: af.name,
        signature: sig,
        selector: safeSelector(af),
        mutability: af.stateMutability,
        visibility: m ? (m.visibility === "public" ? "public" : "external") : "unknown",
        inputs: af.inputs.map((p) => ({ name: p.name ?? "", type: canonicalParam(p) })),
        outputs: (af.outputs ?? []).map((p) => ({ name: p.name ?? "", type: canonicalParam(p) })),
        modifiers: m?.modifiers.map((x) => x.name) ?? [],
        accessControl: { restricted: Boolean(access?.restricted), mechanism: access?.mechanism ?? null },
        explanation: explainFunction(sig, af.stateMutability, [...tags], access, m),
        natspec: m?.natspec,
        location: m ? loc(m) : undefined,
        definedIn: m?.contract,
        tags: [...tags],
        basis: m ? "source" : "abi",
      });
    }
    if (model) {
      for (const f of model.callable.filter((x) => x.kind !== "function")) {
        const access = accessControlOf(f, model);
        functions.push({
          name: f.kind,
          signature: `${f.kind}()`,
          mutability: f.mutability,
          visibility: "external",
          inputs: [],
          outputs: [],
          modifiers: f.modifiers.map((x) => x.name),
          accessControl: { restricted: access.restricted, mechanism: access.mechanism },
          explanation: explainFunction(`${f.kind}()`, f.mutability, tagsFromEffects(f), access, f),
          location: loc(f),
          definedIn: f.contract,
          tags: tagsFromEffects(f),
          basis: "source",
        });
        fnModels.set(`${f.kind}()`, f);
      }
    }
  } else if (model) {
    for (const f of model.callable) {
      const known = f.params.every((p) => p.abiType !== null);
      const sig = f.kind === "function" ? `${f.name}(${f.params.map((p) => p.abiType ?? p.type).join(",")})` : `${f.kind}()`;
      const access = accessControlOf(f, model);
      const tags = f.mutability === "view" || f.mutability === "pure" ? [] : [...new Set([...tagsFromName(f.name), ...tagsFromEffects(f)])];
      fnModels.set(sig, f);
      accessBySig.set(sig, access);
      let selector: string | undefined;
      if (known && f.kind === "function") {
        try {
          selector = toFunctionSelector(`function ${sig}`);
        } catch {
          selector = undefined;
        }
      }
      functions.push({
        name: f.name,
        signature: sig,
        selector,
        mutability: f.mutability,
        visibility: f.visibility === "public" || f.visibility === "default" ? "public" : "external",
        inputs: f.params.map((p) => ({ name: p.name, type: p.abiType ?? p.type })),
        outputs: f.returns.map((p) => ({ name: p.name, type: p.abiType ?? p.type })),
        modifiers: f.modifiers.map((x) => x.name),
        accessControl: { restricted: access.restricted, mechanism: access.mechanism },
        explanation: explainFunction(sig, f.mutability, tags, access, f),
        natspec: f.natspec,
        location: loc(f),
        definedIn: f.contract,
        tags,
        basis: "source",
      });
    }
    // Public state variables generate getters.
    for (const v of model.stateVars.filter((x) => x.visibility === "public")) {
      if (functions.some((f) => f.name === v.name)) continue;
      functions.push({
        name: v.name,
        signature: `${v.name}(…)`,
        mutability: "view",
        visibility: "public",
        inputs: [],
        outputs: [{ name: "", type: v.type }],
        modifiers: [],
        accessControl: { restricted: false, mechanism: null },
        explanation: `Automatically generated getter for the public state variable ${v.name} (${v.type}).`,
        location: { file: v.file, line: v.line },
        definedIn: v.contract,
        tags: [],
        basis: "source",
      });
    }
  } else {
    for (const sel of logic.selectors) {
      const known = lookupSelector(sel);
      const k = known[0];
      const tags = k ? tagsFromName(k.name) : [];
      functions.push({
        name: k ? k.name : "unknown",
        signature: k ? (known.length > 1 ? known.map((x) => x.signature).join(" | ") : k.signature) : sel,
        selector: sel,
        mutability: "unknown",
        visibility: "unknown",
        inputs: [],
        outputs: [],
        modifiers: [],
        accessControl: { restricted: false, mechanism: null },
        explanation: k
          ? `Selector matches the well-known signature ${k.signature}. The actual implementation is unverified, so its behaviour and access rules are unknown.`
          : "Function selector found in the bytecode dispatcher. No known signature matches and the source is unverified.",
        tags,
        basis: "bytecode",
      });
    }
  }
  functions.sort((a, b) => Number(a.mutability === "view" || a.mutability === "pure") - Number(b.mutability === "view" || b.mutability === "pure") || a.name.localeCompare(b.name));

  // 2. Events.
  const events: ContractEvent[] = abiEvents(abi).map((ev) => {
    const sig = `${ev.name}(${ev.inputs.map(canonicalParam).join(",")})`;
    let selector = "";
    try {
      selector = toEventSelector(ev);
    } catch {
      /* ignore */
    }
    void selector;
    return { name: ev.name, signature: sig, inputs: ev.inputs.map((i) => ({ name: i.name ?? "", type: canonicalParam(i), indexed: Boolean(i.indexed) })) };
  });
  if (!events.length && model) {
    for (const c of model.linearized) for (const ev of c.events) if (!events.some((x) => x.name === ev.name)) events.push({ name: ev.name, signature: `${ev.name}(${ev.params.map((p) => p.type).join(",")})`, inputs: ev.params });
  }

  // 3. Permissions.
  const permissions = buildPermissions(functions, fnModels, accessBySig, model);

  // 4. Findings.
  const findings: Finding[] = [];
  const transferGates: string[] = [];
  if (model) findings.push(...sourceFindings(model, fnModels, accessBySig, functions, transferGates, input.compilerVersion));
  else findings.push(...bytecodeFindings(logic, functions, Boolean(abiFns.length)));

  // 5. Classification.
  const classification = classify(functions, model, logic);

  return {
    functions,
    events,
    modifiers: model ? [...new Set(model.linearized.flatMap((c) => c.modifiers.map((m) => m.name)))] : [],
    inheritance: model ? model.linearized.map((c) => c.name) : [],
    permissions,
    findings,
    classification,
    transferGates,
  };
}

function evidenceFor(f: ContractFunction, extra?: string): Evidence {
  return {
    basis: f.basis,
    function: f.signature,
    location: f.location,
    description: extra ?? (f.accessControl.mechanism ? `${f.signature} is guarded by ${f.accessControl.mechanism}.` : `${f.signature} exists.`),
  };
}

function buildPermissions(
  functions: ContractFunction[],
  models: Map<string, FunctionModel>,
  access: Map<string, AccessInfo>,
  model: SourceModel | null,
): Permission[] {
  type Group = { cap: PermissionCapability; authority: string; fns: ContractFunction[] };
  const groups = new Map<string, Group>();
  for (const f of functions) {
    if (f.mutability === "view" || f.mutability === "pure") continue;
    const caps = f.tags.filter((t): t is PermissionCapability => t in CAPABILITY_TEXT);
    const a = access.get(f.signature);
    let authority: string;
    if (f.basis === "bytecode") authority = "unknown (unverified code)";
    else if (a?.restricted) authority = a.authority ?? "privileged account";
    else if (models.get(f.signature) && isInitializerGuarded(models.get(f.signature)!)) authority = "one-time initializer";
    else authority = "anyone (no access check detected)";

    // Skip normal user actions: unrestricted burns of one's own tokens, withdrawals to msg.sender.
    const m = models.get(f.signature);
    const userOwned = (cap: PermissionCapability) =>
      !a?.restricted &&
      ((cap === "burn" && !f.inputs.some((i) => i.type === "address")) ||
        (cap === "withdraw" && m && m.effective.externalCalls.every((c) => /msg\.sender|_msgSender/.test(c.text) || !c.sendsValue)));

    const effectiveCaps = caps.filter((c) => !userOwned(c));
    if (!effectiveCaps.length && a?.restricted && model && !["owner"].includes(f.name)) {
      effectiveCaps.push("other_admin");
    }
    for (const cap of effectiveCaps) {
      const key = `${cap}|${authority}`;
      const g = groups.get(key) ?? { cap, authority, fns: [] };
      g.fns.push(f);
      groups.set(key, g);
    }
  }

  const out: Permission[] = [];
  let i = 1;
  for (const g of groups.values()) {
    const text = CAPABILITY_TEXT[g.cap];
    const isBytecode = g.fns.every((f) => f.basis === "bytecode");
    const unrestricted = g.authority.startsWith("anyone");
    let limitations: string;
    if (isBytecode) limitations = "Inferred only from a function selector matching a common signature. The code is unverified; the function might be restricted, disabled, or behave differently.";
    else if (unrestricted)
      limitations = "UNWRAP found no msg.sender check, role check or restricting modifier on this path. Restrictions implemented in unusual ways (for example in an external contract) would not be detected.";
    else if (g.authority === "one-time initializer")
      limitations = "Guarded by an initializer modifier, so it runs at most once per version, normally at deployment or upgrade. UNWRAP does not read whether that has already happened.";
    else if (g.authority.startsWith("decided by external contract"))
      limitations = "The caller is checked by another contract at call time. UNWRAP does not analyse that contract, so who is allowed, and any limits it applies, are not shown here.";
    else limitations = "Who holds this authority today is determined on-chain; see Ownership. Constraints elsewhere in the code (caps, timelocks) may limit how it can be used.";
    out.push({
      id: `PERM-${String(i++).padStart(2, "0")}`,
      capability: g.cap,
      title: unrestricted ? `${text.title} (anyone can call)` : text.title,
      explanation: text.explain,
      authority: g.authority,
      functions: g.fns.map((f) => f.signature),
      evidence: g.fns.map((f) => evidenceFor(f)),
      confidence: isBytecode ? "low" : g.fns.every((f) => f.basis === "source") ? "high" : "medium",
      limitations,
    });
  }
  const order: PermissionCapability[] = ["upgrade", "arbitrary_call", "mint", "withdraw", "blacklist", "pause", "transfer_restriction", "fee_change", "limit_change", "burn", "whitelist", "role_management", "ownership_transfer", "renounce", "other_admin"];
  out.sort((a, b) => Number(b.authority.startsWith("anyone")) - Number(a.authority.startsWith("anyone")) || order.indexOf(a.capability) - order.indexOf(b.capability));
  return out;
}

// ---- Source detectors -----------------------------------------------------

let counter = 0;
function fid(rule: string) {
  counter++;
  return `${rule}-${counter}`;
}

function sourceFindings(
  model: SourceModel,
  fnModels: Map<string, FunctionModel>,
  access: Map<string, AccessInfo>,
  functions: ContractFunction[],
  transferGates: string[],
  compilerVersion?: string,
): Finding[] {
  counter = 0;
  const out: Finding[] = [];
  const entries = [...fnModels.entries()];
  // Methods declared view/pure everywhere they appear in the verified source. Calls to them compile to
  // STATICCALL, which cannot modify state, so they cannot re-enter to change anything.
  const readOnly = new Map<string, boolean>();
  for (const c of model.contracts.values())
    for (const fn of c.functions) readOnly.set(fn.name, (readOnly.get(fn.name) ?? true) && (fn.mutability === "view" || fn.mutability === "pure"));
  const isStaticCall = (c: { kind: string; text: string }) => c.kind === "external" && readOnly.get(/^[^(]*\.(\w+)\s*\(/.exec(c.text)?.[1] ?? "") === true;

  for (const [sig, f] of entries) {
    const a = access.get(sig) ?? accessControlOf(f, model);
    const where: SourceLocation = { file: f.file, line: f.line, endLine: f.endLine };
    const guarded = f.modifiers.some((m) => NON_REENTRANT_RE.test(m.name));

    // Reentrancy: external interaction followed by a state write in the same function body.
    if (!guarded && f.mutability !== "view" && f.mutability !== "pure") {
      const calls = f.direct.externalCalls.filter((c) => (c.kind === "call" || c.kind === "external") && !isStaticCall(c));
      for (const c of calls) {
        const later = f.direct.writeEvents.filter((w) => w.pos > c.pos);
        if (later.length) {
          out.push({
            id: fid("SRC-REENTRANCY"),
            ruleId: "reentrancy-state-after-call",
            title: "State is updated after an external call",
            severity: c.sendsValue ? "high" : "medium",
            confidence: "medium",
            kind: "potential_vulnerability",
            category: "Reentrancy",
            explanation: `${sig} makes an external call (${c.text}) and only afterwards updates ${[...new Set(later.map((w) => w.name))].join(", ")}. If the callee re-enters the contract before that update, it may observe stale state. This is the classic reentrancy pattern.`,
            evidence: [
              { basis: "source", function: sig, location: { file: f.file, line: c.line }, description: `External call: ${c.text}` },
              ...later.slice(0, 2).map((w) => ({ basis: "source" as const, function: sig, location: { file: f.file, line: w.line }, description: `State write after the call: ${w.name}` })),
            ],
            recommendation: "Confirm whether re-entry is possible and harmful. The usual fix is checks-effects-interactions (update state before calling out) or a reentrancy guard.",
            limitations: "Detected syntactically within one function body. A guard implemented elsewhere, or a trusted callee, may make this unexploitable.",
            detector: "unwrap-static",
          });
          break;
        }
      }
    }

    // Unchecked low-level calls.
    for (const c of f.direct.externalCalls.filter((x) => (x.kind === "call" || x.kind === "send" || x.kind === "delegatecall") && !x.checked)) {
      out.push({
        id: fid("SRC-UNCHECKED-CALL"),
        ruleId: "unchecked-low-level-call",
        title: "Return value of a low-level call is ignored",
        severity: "medium",
        confidence: "high",
        kind: "potential_vulnerability",
        category: "Unchecked return value",
        explanation: `${sig} performs ${c.text} without checking whether it succeeded. Low-level calls do not revert on failure, so the function can continue as if the call worked.`,
        evidence: [{ basis: "source", function: sig, location: { file: f.file, line: c.line }, description: `Unchecked: ${c.text}` }],
        recommendation: "Check the boolean success value (require or explicit handling), or use a library such as OpenZeppelin Address.",
        limitations: "Silent failure may be intentional, for example best-effort notifications.",
        detector: "unwrap-static",
      });
    }

    // tx.origin used for authorisation.
    for (const line of f.direct.txOriginLines) {
      out.push({
        id: fid("SRC-TX-ORIGIN"),
        ruleId: "tx-origin-auth",
        title: "tx.origin used for authorisation",
        severity: "medium",
        confidence: "high",
        kind: "potential_vulnerability",
        category: "Access control",
        explanation: `${sig} compares tx.origin, the original transaction sender, rather than msg.sender. If the authorised account interacts with a malicious contract, that contract can call ${f.name} and pass this check.`,
        evidence: [{ basis: "source", function: sig, location: { file: f.file, line }, description: "tx.origin comparison" }],
        recommendation: "Use msg.sender for authorisation checks.",
        limitations: "Exploitation requires the authorised account to call an attacker-controlled contract.",
        detector: "unwrap-static",
      });
    }

    // delegatecall / arbitrary call with caller-controlled target.
    for (const c of f.direct.externalCalls.filter((x) => (x.kind === "delegatecall" || x.kind === "call") && x.targetIsParam)) {
      const isDelegate = c.kind === "delegatecall";
      if (!isDelegate && !c.dataIsParam) continue;
      out.push({
        id: fid(isDelegate ? "SRC-DELEGATECALL" : "SRC-ARBITRARY-CALL"),
        ruleId: isDelegate ? "controlled-delegatecall" : "arbitrary-external-call",
        title: isDelegate
          ? a.restricted
            ? "Privileged account can run arbitrary code in this contract's context"
            : "Anyone may be able to run arbitrary code in this contract's context"
          : a.restricted
            ? "Privileged account can make arbitrary calls from the contract"
            : "Arbitrary external call with caller-supplied target and data",
        severity: a.restricted ? (isDelegate ? "high" : "medium") : "high",
        confidence: a.restricted ? "high" : "medium",
        kind: a.restricted ? "confirmed_behaviour" : "potential_vulnerability",
        category: isDelegate ? "Unsafe delegatecall" : "Dangerous external call",
        explanation: isDelegate
          ? `${sig} delegatecalls an address supplied by the caller. Delegated code runs with this contract's storage and balance, so it can change any state or move any funds.`
          : `${sig} calls a caller-supplied address with caller-supplied data. This can be used to move tokens or native currency the contract holds, or to act with this contract's identity elsewhere.`,
        evidence: [{ basis: "source", function: sig, location: { file: f.file, line: c.line }, description: `${c.text}${a.restricted ? `, guarded by ${a.mechanism}` : ", no access check detected"}` }],
        recommendation: a.restricted
          ? "Treat the authority holding this function as having full control. Check whether it is a multisig or timelock."
          : "Verify whether this function is reachable by anyone. If it is, treat assets in this contract as at risk.",
        limitations: a.restricted ? "This is a centralisation risk, not an external vulnerability, as long as the authority is trustworthy." : "Access may be enforced in a way UNWRAP did not detect.",
        detector: "unwrap-static",
      });
    }

    // selfdestruct.
    if (f.effective.selfdestructLines.length) {
      out.push({
        id: fid("SRC-SELFDESTRUCT"),
        ruleId: "selfdestruct",
        title: a.restricted ? "Contract can self-destruct (privileged)" : "Self-destruct reachable without a detected access check",
        severity: a.restricted ? "medium" : "high",
        confidence: "high",
        kind: a.restricted ? "confirmed_behaviour" : "potential_vulnerability",
        category: "Self-destruct",
        explanation: `${sig} can reach selfdestruct. After the Cancun upgrade (EIP-6780), selfdestruct only deletes code when called in the creation transaction, but it still sends the contract's entire native balance to the target.`,
        evidence: [{ basis: "source", function: sig, location: where, description: `selfdestruct at line ${f.effective.selfdestructLines[0]}` }],
        recommendation: "Confirm who can trigger it and whether the network has adopted EIP-6780 semantics.",
        limitations: "Exact behaviour depends on the network's EVM version.",
        detector: "unwrap-static",
      });
    }

    // Unprotected sensitive state changes.
    const fn = functions.find((x) => x.signature === sig);
    const sensitive = (fn?.tags ?? []).filter((t) => ["mint", "pause", "blacklist", "fee_change", "limit_change", "upgrade", "transfer_restriction", "ownership_transfer", "whitelist"].includes(t));
    if (!a.restricted && sensitive.length && f.mutability !== "view" && f.kind === "function" && !/^(initialize|init)/i.test(f.name)) {
      out.push({
        id: fid("SRC-UNPROTECTED"),
        ruleId: "missing-access-control",
        title: `Sensitive function without a detected access check: ${f.name}`,
        severity: sensitive.includes("mint") || sensitive.includes("upgrade") || sensitive.includes("ownership_transfer") ? "high" : "medium",
        confidence: "medium",
        kind: "heuristic_warning",
        category: "Access control",
        explanation: `${sig} appears to grant these capabilities: ${sensitive.map((s) => CAPABILITY_TEXT[s as PermissionCapability].title.toLowerCase()).join("; ")}. Yet UNWRAP found no modifier, msg.sender check or role check restricting it. If that is accurate, any address can call it.`,
        evidence: [{ basis: "source", function: sig, location: where, description: `Writes: ${[...f.effective.stateWrites.keys()].join(", ") || "n/a"}; modifiers: ${f.modifiers.map((m) => m.name).join(", ") || "none"}` }],
        recommendation: "Read the function body to confirm. If it is genuinely open, the value it controls can be changed by anyone.",
        limitations: "Classification relies on names of the state variables written. A variable such as `feeRecipient` set by anyone may be intended, e.g. per-user settings.",
        detector: "unwrap-static",
      });
    }

    // Initializer without protection.
    if (/^initialize$/i.test(f.name) && !a.restricted && !isInitializerGuarded(f)) {
      out.push({
        id: fid("SRC-INIT"),
        ruleId: "unprotected-initializer",
        title: "initialize() has no detected initializer guard",
        severity: "medium",
        confidence: "low",
        kind: "heuristic_warning",
        category: "Upgradeability",
        explanation: `${sig} has no initializer modifier. If it can be called more than once, or on the implementation contract directly, an attacker could set privileged values.`,
        evidence: [{ basis: "source", function: sig, location: where, description: "No initializer/reinitializer modifier" }],
        recommendation: "Check for a manual `initialized` flag inside the function body.",
        limitations: "Manual guards (a boolean checked with require) are common and are not modelled by this rule.",
        detector: "unwrap-static",
      });
    }
  }

  // Transfer-path gates controlled by privileged functions.
  const transferFns = entries.filter(([, f]) => TRANSFER_PATH.has(f.name)).map(([, f]) => f);
  const internalTransfer = model.internal.filter((f) => TRANSFER_PATH.has(f.name));
  const pathFns = [...transferFns, ...internalTransfer];
  const condRefs = new Set(pathFns.flatMap((f) => [...f.effective.conditionRefs]));
  const pathReads = new Set(pathFns.flatMap((f) => [...f.effective.reads]));
  const adminWritten = new Map<string, string>();
  for (const [sig, f] of entries) {
    const a = access.get(sig) ?? accessControlOf(f, model);
    if (a.restricted) for (const v of f.effective.stateWrites.keys()) if (!adminWritten.has(v)) adminWritten.set(v, sig);
  }
  const gates = [...condRefs].filter((v) => adminWritten.has(v) && !RE.ownerVar.test(v));
  transferGates.push(...gates);
  if (gates.length && pathFns.length) {
    const p = pathFns[0]!;
    out.push({
      id: fid("SRC-TRANSFER-GATE"),
      ruleId: "admin-controlled-transfer-conditions",
      title: "Transfers depend on settings an administrator can change",
      severity: "medium",
      confidence: "high",
      kind: "confirmed_behaviour",
      category: "Transfer restrictions",
      explanation: `The transfer path checks ${gates.join(", ")}, and restricted functions can change ${gates.length > 1 ? "these values" : "this value"}. An administrator can therefore cause transfers by some or all holders to fail.`,
      evidence: [
        { basis: "source", function: p.name, location: { file: p.file, line: p.line, endLine: p.endLine }, description: `Transfer path conditions reference: ${gates.join(", ")}` },
        ...gates.slice(0, 4).map((g) => ({ basis: "source" as const, function: adminWritten.get(g), description: `${g} is written by ${adminWritten.get(g)}` })),
      ],
      recommendation: "Check the current values on-chain and who holds the administrative role before trading.",
      limitations: "This shows capability, not intent or current state. It does not by itself mean the token cannot be sold.",
      detector: "unwrap-static",
    });
  }

  // Fees taken in the transfer path, changeable without an upper bound.
  const feeVars = [...pathReads].filter((v) => RE.feeVar.test(v) && adminWritten.has(v) && !/recipient|wallet|receiver|address/i.test(v));
  for (const v of feeVars) {
    const setterSig = adminWritten.get(v)!;
    const setter = fnModels.get(setterSig);
    const bounded = setter ? setter.params.some((p) => setter.effective.conditionRefs.has(p.name)) : false;
    out.push({
      id: fid("SRC-FEE"),
      ruleId: bounded ? "admin-fee-bounded" : "admin-fee-unbounded",
      title: bounded ? `Transfer fee ${v} is adjustable within a checked range` : `Transfer fee ${v} can be changed with no detected upper limit`,
      severity: bounded ? "low" : "medium",
      confidence: "medium",
      kind: bounded ? "informational" : "heuristic_warning",
      category: "Fees",
      explanation: bounded
        ? `Transfers read ${v}, and ${setterSig} can change it. The setter validates its input, which suggests a maximum is enforced.`
        : `Transfers read ${v}, and ${setterSig} can change it without any detected validation of the new value. If the fee is applied as a percentage, a very high value could take most of each transfer.`,
      evidence: [
        { basis: "source", function: setterSig, location: setter ? { file: setter.file, line: setter.line } : undefined, description: `${setterSig} writes ${v}` },
        { basis: "source", description: `${v} is read in the transfer path` },
      ],
      recommendation: bounded ? "Read the setter to confirm the maximum." : "Check the current fee on-chain and whether the setter is behind a timelock or multisig.",
      limitations: "Bound detection only checks whether the parameter appears in a require/if inside the setter.",
      detector: "unwrap-static",
    });
  }

  // Pre-0.8 arithmetic.
  // The verifier's compiler version is authoritative; pragmas are a fallback (wide ranges in imports such as
  // hardhat/console.sol would otherwise trigger this on 0.8 code).
  const compiled = /^v?0\.(\d+)\./.exec(compilerVersion ?? "");
  const oldPragma = compiled
    ? Number(compiled[1]) < 8
    : model.pragmas.some((p) => /(\^|>=|=|~)?\s*0\.[4-7]\./.test(p) && !/>=\s*0\.8/.test(p));
  if (oldPragma) {
    const usesSafeMath = model.linearized.some((c) => c.usingFor.some((u) => /SafeMath/i.test(u)));
    out.push({
      id: fid("SRC-ARITH"),
      ruleId: "pre-08-arithmetic",
      title: usesSafeMath ? "Compiled with Solidity < 0.8 (uses SafeMath)" : "Compiled with Solidity < 0.8 without detected SafeMath",
      severity: usesSafeMath ? "info" : "medium",
      confidence: "low",
      kind: usesSafeMath ? "informational" : "heuristic_warning",
      category: "Arithmetic",
      explanation: "Solidity versions before 0.8 do not revert on integer overflow or underflow by default. Arithmetic must be protected manually or with a library such as SafeMath.",
      evidence: [{ basis: "source", description: `pragma solidity ${model.pragmas.join(", ")}` }],
      recommendation: "Review arithmetic on balances and supply for overflow protection.",
      limitations: "UNWRAP does not check individual arithmetic expressions.",
      detector: "unwrap-static",
    });
  }

  // Centralisation overview.
  const restrictedState = functions.filter((f) => f.accessControl.restricted && f.mutability !== "view" && f.mutability !== "pure");
  if (restrictedState.length >= 3) {
    out.push({
      id: fid("SRC-CENTRAL"),
      ruleId: "privileged-functions",
      title: `${restrictedState.length} functions are restricted to privileged accounts`,
      severity: "info",
      confidence: "high",
      kind: "informational",
      category: "Centralisation",
      explanation: "The contract has several functions only privileged accounts can call. Users depend on those accounts acting honestly and keeping their keys safe.",
      evidence: restrictedState.slice(0, 6).map((f) => evidenceFor(f)),
      recommendation: "Check who holds these permissions (Ownership section) and whether a multisig or timelock is in front of them.",
      limitations: "Count only. See Permissions for the impact of each.",
      detector: "unwrap-static",
    });
  }

  if (model.parseErrors.length) {
    out.push({
      id: fid("SRC-PARSE"),
      ruleId: "parse-incomplete",
      title: "Some source could not be fully parsed",
      severity: "info",
      confidence: "high",
      kind: "unknown",
      category: "Analysis coverage",
      explanation: "UNWRAP's parser reported errors in some files, so parts of the code may not have been analysed.",
      evidence: model.parseErrors.slice(0, 3).map((e) => ({ basis: "source" as const, description: `${e.file}: ${e.message}` })),
      recommendation: "Treat source-based findings as incomplete.",
      limitations: "Parser errors can come from newer Solidity syntax.",
      detector: "unwrap-static",
    });
  }
  return out;
}

function bytecodeFindings(bc: BytecodeFacts, functions: ContractFunction[], hasAbi: boolean): Finding[] {
  counter = 0;
  const out: Finding[] = [];
  const ev = (d: string): Evidence => ({ basis: "bytecode", description: d });
  if (bc.opcodes.selfdestruct) {
    out.push({
      id: fid("BC-SELFDESTRUCT"),
      ruleId: "bytecode-selfdestruct-opcode",
      title: "SELFDESTRUCT opcode present in the bytecode",
      severity: "info",
      confidence: "low",
      kind: "unknown",
      category: "Self-destruct",
      explanation: "The runtime bytecode contains the SELFDESTRUCT opcode. Without verified source, UNWRAP cannot tell whether it is reachable or who can trigger it.",
      evidence: [ev("Opcode 0xff found outside the metadata section")],
      recommendation: "Ask the deployer to verify the source, or review the bytecode with a decompiler.",
      limitations: "The byte 0xff can also appear inside data embedded in code, which can produce false positives.",
      detector: "unwrap-bytecode",
    });
  }
  if (bc.opcodes.delegatecall && !bc.minimalProxyTarget) {
    out.push({
      id: fid("BC-DELEGATECALL"),
      ruleId: "bytecode-delegatecall-opcode",
      title: "Contract uses DELEGATECALL",
      severity: "info",
      confidence: "medium",
      kind: "unknown",
      category: "Unsafe delegatecall",
      explanation: "The bytecode contains DELEGATECALL, which runs another contract's code with this contract's storage. This is normal for proxies and libraries; it is risky if the target can be chosen by an untrusted caller.",
      evidence: [ev("Opcode 0xf4 found")],
      recommendation: "Check the proxy section. If the contract is not a recognised proxy, determine what the delegatecall target is.",
      limitations: "Opcode presence says nothing about reachability or target control.",
      detector: "unwrap-bytecode",
    });
  }
  const adminLike = functions.filter((f) => f.tags.length);
  if (adminLike.length && !hasAbi) {
    out.push({
      id: fid("BC-ADMIN-SELECTORS"),
      ruleId: "bytecode-admin-selectors",
      title: "Bytecode contains selectors of common administrative functions",
      severity: "info",
      confidence: "low",
      kind: "heuristic_warning",
      category: "Centralisation",
      explanation: `The dispatcher contains selectors matching ${adminLike.map((f) => f.name).slice(0, 8).join(", ")}. These functions often carry administrative powers, but without source the actual behaviour and restrictions are unknown.`,
      evidence: adminLike.slice(0, 8).map((f) => ({ basis: "bytecode" as const, function: f.signature, description: `Selector ${f.selector}` })),
      recommendation: "Treat the contract as unverified. Prefer contracts with verified source for anything involving funds.",
      limitations: "Selector matching can collide, and unrecognised custom functions are listed as unknown.",
      detector: "unwrap-bytecode",
    });
  }
  return out;
}

// ---- Classification -------------------------------------------------------

function classify(functions: ContractFunction[], model: SourceModel | null, bc: BytecodeFacts): Classification {
  const names = new Set(functions.map((f) => f.name));
  const sigs = new Set(functions.flatMap((f) => f.signature.split(" | ")));
  const basis = functions[0]?.basis ?? "bytecode";
  const conf: Confidence = basis === "bytecode" ? "medium" : "high";
  const standards: Classification["standards"] = [];
  const patterns: Classification["patterns"] = [];

  const erc20 = ["totalSupply()", "balanceOf(address)", "transfer(address,uint256)", "transferFrom(address,address,uint256)", "approve(address,uint256)", "allowance(address,address)"];
  const erc20Hits = erc20.filter((s) => sigs.has(s)).length;
  if (erc20Hits === 6) standards.push({ name: "ERC-20", confidence: conf, evidence: "All six ERC-20 functions are present." });
  else if (erc20Hits >= 4) standards.push({ name: "ERC-20 (partial)", confidence: "low", evidence: `${erc20Hits} of 6 ERC-20 functions present.` });
  if (sigs.has("ownerOf(uint256)") && sigs.has("setApprovalForAll(address,bool)")) standards.push({ name: "ERC-721", confidence: conf, evidence: "ownerOf and setApprovalForAll are present." });
  if (sigs.has("balanceOfBatch(address[],uint256[])")) standards.push({ name: "ERC-1155", confidence: conf, evidence: "balanceOfBatch is present." });
  if (names.has("permit") && names.has("nonces")) standards.push({ name: "ERC-2612 permit", confidence: conf, evidence: "permit and nonces are present." });
  if (names.has("asset") && names.has("convertToShares")) standards.push({ name: "ERC-4626 vault", confidence: conf, evidence: "asset and convertToShares are present." });

  const inh = new Set(model?.linearized.map((c) => c.name) ?? []);
  const has = (...n: string[]) => n.some((x) => names.has(x) || inh.has(x));
  if (has("Ownable", "Ownable2Step", "OwnableUpgradeable") || (names.has("owner") && names.has("transferOwnership"))) patterns.push({ name: "Ownable", confidence: conf, evidence: "owner/transferOwnership present" });
  if (has("AccessControl", "AccessControlUpgradeable", "hasRole")) patterns.push({ name: "Role-based access control", confidence: conf, evidence: "hasRole / AccessControl present" });
  if (has("Pausable", "PausableUpgradeable", "paused")) patterns.push({ name: "Pausable", confidence: conf, evidence: "paused() present" });
  if (model?.linearized.some((c) => c.modifiers.some((m) => NON_REENTRANT_RE.test(m.name)))) patterns.push({ name: "Reentrancy guard", confidence: "high", evidence: "nonReentrant-style modifier defined" });
  if (names.has("proxiableUUID")) patterns.push({ name: "UUPS upgradeable implementation", confidence: conf, evidence: "proxiableUUID() present" });
  if (names.has("getReserves") && names.has("token0")) patterns.push({ name: "AMM liquidity pair", confidence: conf, evidence: "getReserves/token0/token1 present" });
  if (names.has("swapExactTokensForTokens")) patterns.push({ name: "DEX router", confidence: conf, evidence: "swapExactTokensForTokens present" });
  if (names.has("getOwners") && names.has("getThreshold")) patterns.push({ name: "Multisig wallet (Safe-style)", confidence: conf, evidence: "getOwners/getThreshold present" });
  if (names.has("getMinDelay")) patterns.push({ name: "Timelock", confidence: conf, evidence: "getMinDelay present" });
  if (names.has("deposit") && sigs.has("withdraw(uint256)") && erc20Hits === 6 && !names.has("mint")) patterns.push({ name: "Wrapped native token (WETH-style)", confidence: "medium", evidence: "deposit/withdraw with ERC-20" });
  if (bc.minimalProxyTarget) patterns.push({ name: "EIP-1167 minimal proxy", confidence: "high", evidence: "bytecode template match" });

  let label = "Smart contract";
  if (standards.some((s) => s.name === "ERC-20")) label = "ERC-20 token";
  else if (standards.some((s) => s.name === "ERC-721")) label = "NFT collection (ERC-721)";
  else if (standards.some((s) => s.name === "ERC-1155")) label = "Multi-token (ERC-1155)";
  else if (patterns.some((p) => p.name.startsWith("Multisig"))) label = "Multisig wallet";
  else if (patterns.some((p) => p.name === "AMM liquidity pair")) label = "AMM liquidity pair";
  else if (patterns.some((p) => p.name === "DEX router")) label = "DEX router";
  else if (patterns.some((p) => p.name === "Timelock")) label = "Timelock controller";
  else if (standards.some((s) => s.name === "ERC-4626 vault")) label = "Tokenised vault (ERC-4626)";
  return { label, standards, patterns };
}
