import { parse } from "@solidity-parser/parser";
import type { SourceFile } from "./types";

/**
 * Source-level analysis built on the Solidity AST (@solidity-parser/parser).
 *
 * It does NOT compile code and never executes anything. It walks the syntax
 * tree to record, per function, what the code does (state writes, calls,
 * sender checks). Effects of internal functions and modifiers are propagated
 * into the public functions that use them so that detectors reason about
 * behaviour rather than names alone. It is a static approximation: no type
 * resolution, no data-flow across storage, and inheritance linearisation is
 * approximate. Results are labelled accordingly everywhere they are shown.
 */

// ---- Generic AST helpers --------------------------------------------------

type Node = { type: string; loc?: { start: { line: number }; end: { line: number } }; range?: [number, number]; [k: string]: unknown };

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

/** Depth-first walk that passes the parent chain. */
function walk(node: unknown, fn: (n: Node, parents: Node[]) => void | false, parents: Node[] = []): void {
  if (Array.isArray(node)) {
    for (const c of node) walk(c, fn, parents);
    return;
  }
  if (!isNode(node)) return;
  if (fn(node, parents) === false) return;
  const next = [...parents, node];
  for (const [k, v] of Object.entries(node)) {
    if (k === "loc" || k === "range") continue;
    if (typeof v === "object" && v !== null) walk(v, fn, next);
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Renders an expression back to compact Solidity-like text for evidence. */
export function exprText(n: unknown, depth = 0): string {
  if (!isNode(n) || depth > 12) return "…";
  switch (n.type) {
    case "Identifier":
      return str(n.name);
    case "MemberAccess":
      return `${exprText(n.expression, depth + 1)}.${str(n.memberName)}`;
    case "IndexAccess":
      return `${exprText(n.base, depth + 1)}[${exprText(n.index, depth + 1)}]`;
    case "FunctionCall": {
      const args = Array.isArray(n.arguments) ? (n.arguments as unknown[]).map((a) => exprText(a, depth + 1)).join(", ") : "";
      return `${exprText(n.expression, depth + 1)}(${args})`;
    }
    case "NameValueExpression":
      return `${exprText(n.expression, depth + 1)}{…}`;
    case "BinaryOperation":
      return `${exprText(n.left, depth + 1)} ${str(n.operator)} ${exprText(n.right, depth + 1)}`;
    case "UnaryOperation":
      return n.isPrefix ? `${str(n.operator)}${exprText(n.subExpression, depth + 1)}` : `${exprText(n.subExpression, depth + 1)}${str(n.operator)}`;
    case "NumberLiteral":
      return str(n.number);
    case "BooleanLiteral":
      return String(n.value);
    case "StringLiteral":
      return JSON.stringify(str(n.value).slice(0, 40));
    case "ElementaryTypeName":
      return str(n.name);
    case "TupleExpression":
      return `(${(n.components as unknown[]).map((c) => (c ? exprText(c, depth + 1) : "")).join(", ")})`;
    case "Conditional":
      return `${exprText(n.condition, depth + 1)} ? … : …`;
    default:
      return n.type;
  }
}

/** Base identifier of an lvalue: balances[a][b].x -> balances */
function baseIdentifier(n: unknown): string | null {
  let cur: unknown = n;
  for (let i = 0; i < 10 && isNode(cur); i++) {
    if (cur.type === "Identifier") return str(cur.name);
    if (cur.type === "IndexAccess") cur = cur.base;
    else if (cur.type === "MemberAccess") cur = cur.expression;
    else return null;
  }
  return null;
}

function identifiersIn(n: unknown): Set<string> {
  const out = new Set<string>();
  walk(n, (x) => {
    if (x.type === "Identifier") out.add(str(x.name));
    if (x.type === "MemberAccess") out.add(str(x.memberName));
  });
  return out;
}

// ---- Model ----------------------------------------------------------------

export type CallKind = "call" | "delegatecall" | "staticcall" | "transfer" | "send" | "external";

export interface ExternalCall {
  kind: CallKind;
  line: number;
  pos: number;
  text: string;
  /** Return value checked (require/if/assigned and later tested). Only meaningful for low-level calls. */
  checked: boolean;
  sendsValue: boolean;
  targetIsParam: boolean;
  dataIsParam: boolean;
  /** Looks like an ERC-20 transfer/transferFrom/approve on an external token. */
  tokenTransfer: boolean;
}

export interface Effects {
  stateWrites: Map<string, number>; // var -> line
  writeEvents: { name: string; pos: number; line: number }[];
  internalCalls: Set<string>;
  externalCalls: ExternalCall[];
  selfdestructLines: number[];
  txOriginLines: number[];
  /** Text of tx.origin comparisons, e.g. "tx.origin == owner()". */
  txOriginTexts: string[];
  senderChecks: { line: number; text: string }[];
  roleChecks: { line: number; role: string }[];
  conditionRefs: Set<string>;
  assemblySstore: boolean;
  assemblyDelegatecall: boolean;
  emits: Set<string>;
  /** State variables read anywhere in the code. */
  reads: Set<string>;
}

function emptyEffects(): Effects {
  return {
    stateWrites: new Map(),
    writeEvents: [],
    internalCalls: new Set(),
    externalCalls: [],
    selfdestructLines: [],
    txOriginLines: [],
    txOriginTexts: [],
    senderChecks: [],
    roleChecks: [],
    conditionRefs: new Set(),
    assemblySstore: false,
    assemblyDelegatecall: false,
    emits: new Set(),
    reads: new Set(),
  };
}

export interface ParamModel {
  name: string;
  type: string;
  /** Canonical ABI type, or null when it depends on a struct/unknown type. */
  abiType: string | null;
}

export interface FunctionModel {
  name: string;
  kind: "function" | "constructor" | "fallback" | "receive";
  contract: string;
  file: string;
  line: number;
  endLine: number;
  visibility: "external" | "public" | "internal" | "private" | "default";
  mutability: "pure" | "view" | "payable" | "nonpayable";
  modifiers: { name: string; args: string[] }[];
  params: ParamModel[];
  returns: ParamModel[];
  natspec?: string;
  virtual: boolean;
  /** Effects in the function body only. */
  direct: Effects;
  /** Effects including modifiers and (transitively) internal calls. */
  effective: Effects;
  /** Internal functions/modifiers whose effects were merged. */
  via: string[];
}

export interface ModifierModel {
  name: string;
  contract: string;
  file: string;
  line: number;
  effects: Effects;
}

export interface StateVarModel {
  name: string;
  type: string;
  visibility: string;
  constant: boolean;
  immutable: boolean;
  line: number;
  file: string;
  contract: string;
}

export interface ContractModel {
  name: string;
  kind: "contract" | "interface" | "library" | "abstract";
  file: string;
  line: number;
  bases: string[];
  functions: FunctionModel[];
  modifiers: ModifierModel[];
  events: { name: string; params: { name: string; type: string; indexed: boolean }[] }[];
  stateVars: StateVarModel[];
  usingFor: string[];
}

export interface AccessInfo {
  restricted: boolean;
  /** Human readable: "modifier onlyOwner", "require(msg.sender == admin)", "role MINTER_ROLE". */
  mechanism: string | null;
  /** Normalised authority label: "owner", "role: MINTER_ROLE", "admin", "specific address". */
  authority: string | null;
}

export interface SourceModel {
  contracts: Map<string, ContractModel>;
  main: ContractModel | null;
  /** Main contract first, then bases (approximate C3 order). */
  linearized: ContractModel[];
  /** Externally callable functions after override resolution. */
  callable: FunctionModel[];
  internal: FunctionModel[];
  stateVars: StateVarModel[];
  pragmas: string[];
  imports: string[];
  parseErrors: { file: string; message: string }[];
  filesParsed: number;
}

// ---- Type canonicalisation ------------------------------------------------

function typeText(t: unknown, depth = 0): string {
  if (!isNode(t) || depth > 8) return "unknown";
  switch (t.type) {
    case "ElementaryTypeName": {
      const name = str(t.name);
      return t.stateMutability === "payable" ? `${name} payable` : name;
    }
    case "UserDefinedTypeName":
      return str(t.namePath);
    case "ArrayTypeName": {
      const len = isNode(t.length) ? exprText(t.length) : "";
      return `${typeText(t.baseTypeName, depth + 1)}[${len}]`;
    }
    case "Mapping":
      return `mapping(${typeText(t.keyType, depth + 1)} => ${typeText(t.valueType, depth + 1)})`;
    case "FunctionTypeName":
      return "function";
    default:
      return "unknown";
  }
}

function canonicalAbiType(t: string, enums: Set<string>, contractsAndInterfaces: Set<string>): string | null {
  const arr = t.match(/^(.*?)((\[\d*\])+)$/);
  if (arr) {
    const base = canonicalAbiType(arr[1]!, enums, contractsAndInterfaces);
    return base ? base + arr[2] : null;
  }
  const s = t.replace(/ payable$/, "");
  if (s === "uint") return "uint256";
  if (s === "int") return "int256";
  if (s === "byte") return "bytes1";
  if (/^(address|bool|string|bytes\d*|u?int\d+)$/.test(s)) return s;
  const last = s.split(".").pop()!;
  if (contractsAndInterfaces.has(last)) return "address";
  if (enums.has(last)) return "uint8";
  return null; // struct or unresolved user-defined value type
}

// ---- NatSpec extraction -----------------------------------------------------

function natspecAbove(lines: string[], line: number): string | undefined {
  const out: string[] = [];
  let i = line - 2;
  let inBlock = false;
  for (; i >= 0 && out.length < 30; i--) {
    const l = lines[i]!.trim();
    if (inBlock) {
      out.unshift(l.replace(/^\/\*\*|\*\/$|^\*/g, "").trim());
      if (l.startsWith("/**")) inBlock = false;
      continue;
    }
    if (l.startsWith("///")) out.unshift(l.slice(3).trim());
    else if (l.endsWith("*/")) {
      inBlock = !l.startsWith("/**");
      out.unshift(l.replace(/^\/\*\*|\*\/$|^\*/g, "").trim());
    } else if (l === "" && out.length === 0) continue;
    else break;
  }
  const text = out.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 600) : undefined;
}

// ---- Effect extraction ----------------------------------------------------

const LOW_LEVEL = new Set(["call", "delegatecall", "staticcall"]);
const TOKEN_METHODS = new Set(["transfer", "transferFrom", "approve", "safeTransfer", "safeTransferFrom", "safeApprove", "forceApprove"]);

function collectEffects(body: unknown, stateVarNames: Set<string>, paramNames: Set<string>, localContractNames: Set<string>): Effects {
  const e = emptyEffects();
  if (!body) return e;

  const lowLevelResultVars = new Map<string, ExternalCall>();

  walk(body, (n, parents) => {
    const line = n.loc?.start.line ?? 0;
    const pos = n.range?.[0] ?? 0;
    const parent = parents[parents.length - 1];
    if (n.type === "Identifier" && stateVarNames.has(str(n.name))) e.reads.add(str(n.name));

    // Assignments / increments to state variables.
    if (n.type === "BinaryOperation" && /^(=|\+=|-=|\*=|\/=|%=|\|=|&=|\^=|<<=|>>=)$/.test(str(n.operator))) {
      const lhs = n.left;
      const targets = isNode(lhs) && lhs.type === "TupleExpression" ? (lhs.components as unknown[]) : [lhs];
      for (const t of targets) {
        const b = baseIdentifier(t);
        if (b && stateVarNames.has(b)) {
          if (!e.stateWrites.has(b)) e.stateWrites.set(b, line);
          e.writeEvents.push({ name: b, pos, line });
        }
      }
    }
    if (n.type === "UnaryOperation" && /^(\+\+|--|delete)$/.test(str(n.operator))) {
      const b = baseIdentifier(n.subExpression);
      if (b && stateVarNames.has(b)) {
        if (!e.stateWrites.has(b)) e.stateWrites.set(b, line);
        e.writeEvents.push({ name: b, pos, line });
      }
    }

    if (n.type === "EmitStatement" && isNode(n.eventCall)) {
      const callee = (n.eventCall as Node).expression;
      if (isNode(callee) && callee.type === "Identifier") e.emits.add(str(callee.name));
    }

    // tx.origin anywhere in a comparison.
    if (n.type === "MemberAccess" && str(n.memberName) === "origin" && isNode(n.expression) && str(n.expression.name) === "tx") {
      const cmp = [...parents].reverse().find((p) => p.type === "BinaryOperation" && /^(==|!=)$/.test(str(p.operator)));
      if (cmp) {
        e.txOriginLines.push(line);
        e.txOriginTexts.push(exprText(cmp));
      }
    }

    // msg.sender comparisons -> access checks.
    if (n.type === "BinaryOperation" && /^(==|!=)$/.test(str(n.operator))) {
      const l = exprText(n.left);
      const r = exprText(n.right);
      if (l === "msg.sender" || r === "msg.sender" || l === "_msgSender()" || r === "_msgSender()") {
        const insideCondition = parents.some(
          (p) =>
            (p.type === "FunctionCall" && isNode(p.expression) && /^(require|assert)$/.test(str(p.expression.name))) ||
            p.type === "IfStatement",
        );
        if (insideCondition) e.senderChecks.push({ line, text: `${l} ${str(n.operator)} ${r}` });
      }
    }

    // Conditions referencing identifiers (require/if) — used for transfer-restriction detection.
    if (n.type === "FunctionCall" && isNode(n.expression) && str(n.expression.name) === "require") {
      const first = (n.arguments as unknown[])[0];
      for (const id of identifiersIn(first)) e.conditionRefs.add(id);
    }
    if (n.type === "IfStatement") {
      for (const id of identifiersIn(n.condition)) e.conditionRefs.add(id);
    }

    if (n.type === "InlineAssemblyStatement") {
      walk(n.body, (a) => {
        if (a.type === "AssemblyCall") {
          const fn = str(a.functionName);
          if (fn === "sstore") e.assemblySstore = true;
          if (fn === "delegatecall") e.assemblyDelegatecall = true;
          if (fn === "selfdestruct") e.selfdestructLines.push(a.loc?.start.line ?? line);
        }
      });
      return false;
    }

    if (n.type !== "FunctionCall") return;
    let callee = n.expression;
    let sendsValue = false;
    if (isNode(callee) && callee.type === "NameValueExpression") {
      const nv = callee.arguments as Node | undefined;
      sendsValue = Array.isArray(nv?.names) && (nv!.names as string[]).includes("value");
      callee = callee.expression;
    }
    if (!isNode(callee)) return;

    if (callee.type === "Identifier") {
      const name = str(callee.name);
      if (name === "selfdestruct" || name === "suicide") e.selfdestructLines.push(line);
      else if (name === "_checkRole" || name === "hasRole") {
        const role = exprText((n.arguments as unknown[])[0]);
        e.roleChecks.push({ line, role });
        e.internalCalls.add(name);
      } else if (!["require", "assert", "revert", "keccak256", "abi", "type", "address", "payable", "sha256", "ecrecover"].includes(name)) {
        e.internalCalls.add(name);
      }
      return;
    }

    if (callee.type === "MemberAccess") {
      const member = str(callee.memberName);
      const targetText = exprText(callee.expression);
      const targetBase = baseIdentifier(callee.expression);
      const args = (n.arguments as unknown[]) ?? [];

      // super.foo() / this.foo() count as internal for effect propagation.
      if (targetText === "super") {
        e.internalCalls.add(`super.${member}`);
        return;
      }
      if (["abi", "msg", "block", "tx", "string", "bytes", "Math", "SafeMath", "Strings", "Address", "ECDSA", "SafeCast"].includes(targetText)) return;
      if (localContractNames.has(targetText) && !["transfer", "send", "call"].includes(member)) return; // library-ish call

      let kind: CallKind | null = null;
      if (LOW_LEVEL.has(member)) kind = member as CallKind;
      else if (member === "transfer" && args.length === 1) kind = "transfer";
      else if (member === "send" && args.length === 1) kind = "send";
      else if (member === "value" || member === "gas") return;
      else kind = "external";

      // Ignore pure-ish members on built-ins like address.balance or array.push
      if (kind === "external" && ["push", "pop", "length", "balance", "code", "codehash", "selector", "encode", "decode", "add", "sub", "mul", "div", "toString", "isContract", "concat", "remove", "contains", "at", "values", "set", "get", "tryGet"].includes(member)) return;
      if (kind === "external" && targetBase && stateVarNames.has(targetBase) && /^(add|remove|contains|set)$/.test(member)) return;

      const firstArgIds = identifiersIn(args[0]);
      const call: ExternalCall = {
        kind,
        line,
        pos,
        text: exprText(n).slice(0, 160),
        checked: true,
        sendsValue: sendsValue || kind === "transfer" || kind === "send",
        targetIsParam: targetBase !== null && paramNames.has(targetBase),
        dataIsParam: [...firstArgIds].some((id) => paramNames.has(id)),
        tokenTransfer: kind === "external" && TOKEN_METHODS.has(member),
      };

      if (kind === "call" || kind === "delegatecall" || kind === "staticcall" || kind === "send") {
        // Is the success value consumed?
        const stmt = [...parents].reverse().find((p) => /Statement$/.test(p.type));
        const directlyInCondition = parents.some(
          (p) => (p.type === "FunctionCall" && isNode(p.expression) && /^(require|assert)$/.test(str(p.expression.name))) || p.type === "IfStatement",
        );
        if (directlyInCondition) call.checked = true;
        else if (stmt?.type === "ExpressionStatement" && parent?.type !== "BinaryOperation") call.checked = false;
        else if (stmt?.type === "VariableDeclarationStatement") {
          const vars = (stmt.variables as (Node | null)[]) ?? [];
          const first = vars[0];
          if (!first) call.checked = false;
          else {
            call.checked = false; // provisionally; fixed up when the var is later tested
            lowLevelResultVars.set(str(first.name), call);
          }
        } else if (parent?.type === "BinaryOperation" && str(parent.operator) === "=" && isNode(parent.left)) {
          const lhs = parent.left;
          const firstTarget = lhs.type === "TupleExpression" ? (lhs.components as unknown[])[0] : lhs;
          const nm = baseIdentifier(firstTarget);
          if (nm) {
            call.checked = false;
            lowLevelResultVars.set(nm, call);
          } else call.checked = false;
        }
      }
      e.externalCalls.push(call);
    }
  });

  // Fix up result variables that are later tested in a condition.
  if (lowLevelResultVars.size) {
    for (const [name, call] of lowLevelResultVars) if (e.conditionRefs.has(name)) call.checked = true;
    // Also "return ok;" counts as propagating the result to the caller.
    walk(body, (n) => {
      if (n.type === "ReturnStatement") for (const id of identifiersIn(n.expression)) if (lowLevelResultVars.has(id)) lowLevelResultVars.get(id)!.checked = true;
    });
  }
  return e;
}

function mergeEffects(into: Effects, from: Effects): void {
  for (const [k, v] of from.stateWrites) if (!into.stateWrites.has(k)) into.stateWrites.set(k, v);
  into.writeEvents.push(...from.writeEvents);
  for (const c of from.internalCalls) into.internalCalls.add(c);
  into.externalCalls.push(...from.externalCalls);
  into.selfdestructLines.push(...from.selfdestructLines);
  into.txOriginLines.push(...from.txOriginLines);
  into.txOriginTexts.push(...from.txOriginTexts);
  into.senderChecks.push(...from.senderChecks);
  into.roleChecks.push(...from.roleChecks);
  for (const r of from.conditionRefs) into.conditionRefs.add(r);
  into.assemblySstore ||= from.assemblySstore;
  into.assemblyDelegatecall ||= from.assemblyDelegatecall;
  for (const x of from.emits) into.emits.add(x);
  for (const x of from.reads) into.reads.add(x);
}

function cloneEffects(e: Effects): Effects {
  const c = emptyEffects();
  mergeEffects(c, e);
  return c;
}

// ---- Parsing ----------------------------------------------------------------

interface RawFunction {
  node: Node;
  contract: string;
  file: string;
  lines: string[];
}

export function analyseSources(files: SourceFile[], mainContractName: string | null): SourceModel {
  const contracts = new Map<string, ContractModel>();
  const rawFns: RawFunction[] = [];
  const rawMods: { node: Node; contract: string; file: string }[] = [];
  const parseErrors: { file: string; message: string }[] = [];
  const pragmas = new Set<string>();
  const imports = new Set<string>();
  const enums = new Set<string>();
  let filesParsed = 0;

  const asts: { file: SourceFile; ast: Node }[] = [];
  for (const f of files) {
    if (!/\.sol$/i.test(f.path) && files.length > 1) continue;
    try {
      const ast = parse(f.content, { loc: true, range: true, tolerant: true }) as unknown as Node;
      const errs = (ast as { errors?: { message: string }[] }).errors;
      if (errs?.length) parseErrors.push({ file: f.path, message: errs[0]!.message.slice(0, 200) });
      asts.push({ file: f, ast });
      filesParsed++;
    } catch (e) {
      parseErrors.push({ file: f.path, message: ((e as Error).message ?? "parse error").slice(0, 200) });
    }
  }

  // Pass 1: names (contracts, enums) for type canonicalisation.
  const typeNames = new Set<string>();
  for (const { ast } of asts) {
    walk(ast, (n) => {
      if (n.type === "ContractDefinition") typeNames.add(str(n.name));
      if (n.type === "EnumDefinition") enums.add(str(n.name));
    });
  }

  // Pass 2: models.
  for (const { file, ast } of asts) {
    const lines = file.content.split("\n");
    for (const child of (ast.children as Node[]) ?? []) {
      if (child.type === "PragmaDirective" && str(child.name) === "solidity") pragmas.add(str(child.value));
      if (child.type === "ImportDirective") imports.add(str(child.path));
      if (child.type !== "ContractDefinition") continue;
      const kindRaw = str(child.kind);
      const isAbstract = Boolean(child.isAbstract) || kindRaw === "abstract";
      const cm: ContractModel = {
        name: str(child.name),
        kind: isAbstract ? "abstract" : (kindRaw as ContractModel["kind"]),
        file: file.path,
        line: child.loc?.start.line ?? 0,
        bases: ((child.baseContracts as Node[]) ?? []).map((b) => str((b.baseName as Node)?.namePath)),
        functions: [],
        modifiers: [],
        events: [],
        stateVars: [],
        usingFor: [],
      };
      for (const sub of (child.subNodes as Node[]) ?? []) {
        if (sub.type === "StateVariableDeclaration") {
          for (const v of (sub.variables as Node[]) ?? []) {
            cm.stateVars.push({
              name: str(v.name),
              type: typeText(v.typeName),
              visibility: str(v.visibility) || "internal",
              constant: Boolean(v.isDeclaredConst),
              immutable: Boolean(v.isImmutable),
              line: v.loc?.start.line ?? 0,
              file: file.path,
              contract: cm.name,
            });
          }
        } else if (sub.type === "EventDefinition") {
          cm.events.push({
            name: str(sub.name),
            params: ((sub.parameters as Node[]) ?? []).map((p) => ({ name: str(p.name), type: typeText(p.typeName), indexed: Boolean(p.isIndexed) })),
          });
        } else if (sub.type === "FunctionDefinition") {
          rawFns.push({ node: sub, contract: cm.name, file: file.path, lines });
        } else if (sub.type === "ModifierDefinition") {
          rawMods.push({ node: sub, contract: cm.name, file: file.path });
        } else if (sub.type === "UsingForDeclaration") {
          cm.usingFor.push(str(sub.libraryName));
        } else if (sub.type === "EnumDefinition") {
          enums.add(str(sub.name));
        }
      }
      // Duplicate names across files (e.g. two IERC20s): keep the first, they are usually identical.
      if (!contracts.has(cm.name)) contracts.set(cm.name, cm);
    }
  }

  // Linearisation (approximate C3): derived first, then bases right-to-left.
  const linearize = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const c = contracts.get(name);
    if (!c) return [name];
    const out = [name];
    for (const b of [...c.bases].reverse()) for (const x of linearize(b, seen)) if (!out.includes(x)) out.push(x);
    return out;
  };

  let main: ContractModel | null = null;
  if (mainContractName && contracts.has(mainContractName)) main = contracts.get(mainContractName)!;
  if (!main) {
    // Most-derived deployable contract: not used as a base by anything else.
    const usedAsBase = new Set([...contracts.values()].flatMap((c) => c.bases));
    const candidates = [...contracts.values()].filter((c) => c.kind === "contract" && !usedAsBase.has(c.name));
    main = candidates.sort((a, b) => linearize(b.name).length - linearize(a.name).length)[0] ?? null;
  }
  const linearNames = main ? linearize(main.name) : [];
  const linearized = linearNames.map((n) => contracts.get(n)).filter((c): c is ContractModel => Boolean(c));
  const inScope = new Set(linearized.map((c) => c.name));

  const stateVars = linearized.flatMap((c) => c.stateVars);
  const stateVarNames = new Set(stateVars.map((v) => v.name));
  const libraryNames = new Set([...contracts.values()].filter((c) => c.kind === "library").map((c) => c.name));

  // Modifiers.
  for (const m of rawMods) {
    if (!inScope.has(m.contract)) continue;
    const params = new Set(((m.node.parameters as Node[]) ?? []).map((p) => str(p.name)));
    const mm: ModifierModel = {
      name: str(m.node.name),
      contract: m.contract,
      file: m.file,
      line: m.node.loc?.start.line ?? 0,
      effects: collectEffects(m.node.body, stateVarNames, params, libraryNames),
    };
    contracts.get(m.contract)!.modifiers.push(mm);
  }

  // Functions.
  const allFns: FunctionModel[] = [];
  for (const r of rawFns) {
    const n = r.node;
    const kind: FunctionModel["kind"] = n.isConstructor ? "constructor" : n.isFallback ? "fallback" : n.isReceiveEther ? "receive" : "function";
    const toParam = (p: Node): ParamModel => {
      const t = typeText(p.typeName);
      return { name: str(p.name), type: t, abiType: canonicalAbiType(t, enums, typeNames) };
    };
    const params = ((n.parameters as Node[]) ?? []).map(toParam);
    const fm: FunctionModel = {
      name: kind === "function" ? str(n.name) : kind,
      kind,
      contract: r.contract,
      file: r.file,
      line: n.loc?.start.line ?? 0,
      endLine: n.loc?.end.line ?? 0,
      visibility: (str(n.visibility) || "default") as FunctionModel["visibility"],
      mutability: (str(n.stateMutability) || "nonpayable") as FunctionModel["mutability"],
      modifiers: ((n.modifiers as Node[]) ?? []).map((m) => ({ name: str(m.name), args: ((m.arguments as unknown[]) ?? []).map((a) => exprText(a)) })),
      params,
      returns: ((n.returnParameters as Node[]) ?? []).map(toParam),
      natspec: natspecAbove(r.lines, n.loc?.start.line ?? 0),
      virtual: Boolean(n.isVirtual),
      direct: collectEffects(n.body, stateVarNames, new Set(params.map((p) => p.name)), libraryNames),
      effective: emptyEffects(),
      via: [],
    };
    const c = contracts.get(r.contract);
    if (c) c.functions.push(fm);
    if (inScope.has(r.contract)) allFns.push(fm);
  }

  // Effect propagation through modifiers and internal calls (bounded depth).
  const byName = new Map<string, FunctionModel[]>();
  for (const name of linearNames) {
    for (const f of contracts.get(name)?.functions ?? []) {
      const list = byName.get(f.name) ?? [];
      list.push(f); // derived-first order
      byName.set(f.name, list);
    }
  }
  const modByName = new Map<string, ModifierModel>();
  for (const name of linearNames) for (const m of contracts.get(name)?.modifiers ?? []) if (!modByName.has(m.name)) modByName.set(m.name, m);

  for (const f of allFns) {
    const eff = cloneEffects(f.direct);
    const via: string[] = [];
    for (const m of f.modifiers) {
      const mm = modByName.get(m.name);
      if (mm) {
        mergeEffects(eff, mm.effects);
        via.push(`modifier ${m.name}`);
        if (m.name === "onlyRole" && m.args[0]) eff.roleChecks.push({ line: f.line, role: m.args[0] });
      }
    }
    const visited = new Set<string>([f.name]);
    let frontier = [...f.direct.internalCalls];
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
      const next: string[] = [];
      for (const call of frontier) {
        const isSuper = call.startsWith("super.");
        const name = isSuper ? call.slice(6) : call;
        if (visited.has(call)) continue;
        visited.add(call);
        const candidates = byName.get(name) ?? [];
        // For super calls skip the current contract's definition.
        const target = isSuper ? candidates.find((c) => c.contract !== f.contract) : candidates[0];
        if (!target || target === f) continue;
        mergeEffects(eff, target.direct);
        for (const m of target.modifiers) {
          const mm = modByName.get(m.name);
          if (mm) mergeEffects(eff, mm.effects);
        }
        via.push(`${target.contract}.${target.name}`);
        next.push(...target.direct.internalCalls);
      }
      frontier = next;
    }
    f.effective = eff;
    f.via = via;
  }

  // Override resolution: most-derived definition of each (name, param types) wins.
  const seen = new Set<string>();
  const callable: FunctionModel[] = [];
  const internal: FunctionModel[] = [];
  for (const name of linearNames) {
    for (const f of contracts.get(name)?.functions ?? []) {
      if (f.kind === "constructor") continue;
      const key = `${f.name}(${f.params.map((p) => p.type).join(",")})`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = contracts.get(name)!;
      const extVisible = f.visibility === "external" || f.visibility === "public" || (f.visibility === "default" && c.kind !== "interface");
      if (c.kind === "interface") continue;
      if (extVisible || f.kind === "fallback" || f.kind === "receive") callable.push(f);
      else internal.push(f);
    }
  }

  return {
    contracts,
    main,
    linearized,
    callable,
    internal,
    stateVars,
    pragmas: [...pragmas],
    imports: [...imports],
    parseErrors,
    filesParsed,
  };
}

// ---- Access control --------------------------------------------------------

const OWNER_RE = /owner/i;

function authorityFromSenderCheck(text: string): string {
  const other = text.replace(/msg\.sender|_msgSender\(\)/g, "").replace(/==|!=/g, "").trim();
  if (OWNER_RE.test(other)) return "owner";
  if (/admin/i.test(other)) return "admin";
  if (/gov/i.test(other)) return "governance";
  if (/minter/i.test(other)) return "minter";
  return `address in ${other.slice(0, 40) || "a check"}`;
}

/** Decides whether a function is restricted to privileged callers, and by what. */
export function accessControlOf(f: FunctionModel, model: SourceModel): AccessInfo {
  const modByName = new Map<string, ModifierModel>();
  for (const c of model.linearized) for (const m of c.modifiers) if (!modByName.has(m.name)) modByName.set(m.name, m);

  for (const m of f.modifiers) {
    const mm = modByName.get(m.name);
    const role = m.name === "onlyRole" ? m.args[0] : undefined;
    if (role) return { restricted: true, mechanism: `modifier onlyRole(${role})`, authority: `role: ${role}` };
    if (mm && (mm.effects.senderChecks.length || mm.effects.roleChecks.length || [...mm.effects.internalCalls].some((c) => /^_?(check|only|require)/i.test(c)))) {
      const sc = mm.effects.senderChecks[0];
      const rc = mm.effects.roleChecks[0];
      return {
        restricted: true,
        mechanism: `modifier ${m.name}`,
        authority: rc ? `role: ${rc.role}` : sc ? authorityFromSenderCheck(sc.text) : OWNER_RE.test(m.name) ? "owner" : m.name.replace(/^only/, "").toLowerCase() || "privileged account",
      };
    }
    // Unresolved modifier (source not available) named only*: likely restriction, lower confidence.
    if (!mm && /^only/i.test(m.name)) {
      return { restricted: true, mechanism: `modifier ${m.name} (definition not found)`, authority: OWNER_RE.test(m.name) ? "owner" : m.name.replace(/^only/, "") };
    }
  }
  const eff = f.effective;
  if (eff.roleChecks.length) return { restricted: true, mechanism: `role check ${eff.roleChecks[0]!.role}`, authority: `role: ${eff.roleChecks[0]!.role}` };
  if (eff.senderChecks.length) {
    const sc = eff.senderChecks[0]!;
    return { restricted: true, mechanism: `require(${sc.text})`, authority: authorityFromSenderCheck(sc.text) };
  }
  const helper = [...eff.internalCalls].find((c) => /^_?(checkOwner|onlyOwner|requireOwner|checkRole|authorizeUpgrade|onlyAdmin|_requireCallerIsOwner)$/i.test(c));
  if (helper) return { restricted: true, mechanism: `${helper}()`, authority: OWNER_RE.test(helper) ? "owner" : "privileged account" };
  if (eff.txOriginLines.length) {
    const text = eff.txOriginTexts[0] ?? "tx.origin";
    const who = OWNER_RE.test(text) ? "owner" : /admin/i.test(text) ? "admin" : "address checked via tx.origin";
    return { restricted: true, mechanism: `require(${text}) — tx.origin, unsafe`, authority: who };
  }
  return { restricted: false, mechanism: null, authority: null };
}
