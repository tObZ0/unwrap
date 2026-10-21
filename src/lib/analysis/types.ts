/**
 * The UNWRAP report model. Everything shown in the UI and given to the AI
 * comes from this structure, and every claim carries its evidence and basis.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Confidence = "high" | "medium" | "low";

/**
 * How much weight a finding can bear:
 *  - confirmed_behaviour: the code demonstrably does this (source-level).
 *  - potential_vulnerability: a known-risky pattern that may be exploitable in context.
 *  - heuristic_warning: pattern match that commonly signals risk; needs review.
 *  - informational: neutral fact worth knowing.
 *  - unknown: we could not determine behaviour (e.g. bytecode only).
 */
export type FindingKind =
  | "confirmed_behaviour"
  | "potential_vulnerability"
  | "heuristic_warning"
  | "informational"
  | "unknown";

export type EvidenceBasis = "source" | "abi" | "bytecode" | "onchain" | "explorer" | "slither";

export interface SourceLocation {
  file: string;
  line: number;
  endLine?: number;
}

export interface Evidence {
  basis: EvidenceBasis;
  description: string;
  function?: string;
  location?: SourceLocation;
  snippet?: string;
}

export interface Finding {
  /** Stable per-report id, e.g. "SEC-REENTRANCY-1". */
  id: string;
  ruleId: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  kind: FindingKind;
  category: string;
  explanation: string;
  evidence: Evidence[];
  recommendation: string;
  limitations: string;
  detector: "unwrap-static" | "unwrap-bytecode" | "unwrap-onchain" | "slither";
}

export type PermissionCapability =
  | "mint"
  | "burn"
  | "pause"
  | "blacklist"
  | "whitelist"
  | "transfer_restriction"
  | "fee_change"
  | "limit_change"
  | "upgrade"
  | "arbitrary_call"
  | "withdraw"
  | "ownership_transfer"
  | "role_management"
  | "renounce"
  | "other_admin";

export interface Permission {
  id: string;
  capability: PermissionCapability;
  title: string;
  explanation: string;
  /** Who can call it, as far as we can tell ("owner", "role: MINTER_ROLE", "unknown"). */
  authority: string;
  functions: string[];
  evidence: Evidence[];
  confidence: Confidence;
  limitations: string;
}

export type Mutability = "pure" | "view" | "nonpayable" | "payable" | "unknown";

export interface ContractFunction {
  name: string;
  signature: string;
  selector?: string;
  mutability: Mutability;
  visibility: "external" | "public" | "unknown";
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  modifiers: string[];
  accessControl: { restricted: boolean; mechanism: string | null };
  explanation: string;
  /** Developer NatSpec text. Untrusted: shown as the author's claim. */
  natspec?: string;
  location?: SourceLocation;
  /** Contract in the inheritance chain that defines it. */
  definedIn?: string;
  tags: string[];
  basis: EvidenceBasis;
}

export interface ContractEvent {
  name: string;
  signature: string;
  inputs: { name: string; type: string; indexed: boolean }[];
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface VerifiedSource {
  provider: "etherscan-v2" | "blockscout" | "sourcify";
  contractName: string;
  compilerVersion?: string;
  optimization?: string;
  evmVersion?: string;
  license?: string;
  files: SourceFile[];
  abi: unknown[] | null;
  /** Implementation address as reported by the explorer, if any. */
  explorerImplementation?: string;
}

export interface ProxyInfo {
  isProxy: boolean;
  pattern:
    | "eip1967-transparent"
    | "eip1967-uups"
    | "eip1967"
    | "eip1967-beacon"
    | "eip1167-minimal"
    | "legacy-zeppelinos"
    | "explorer-reported"
    | "none";
  implementation?: string;
  admin?: string;
  beacon?: string;
  /** Whether the implementation can be changed (as far as determinable). */
  upgradeable: "yes" | "no" | "unknown";
  adminIsContract?: boolean;
  evidence: Evidence[];
  notes: string[];
}

export interface TokenInfo {
  standard: "ERC-20" | "ERC-721" | "ERC-1155";
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  totalSupplyFormatted?: string;
  /** Only set when a cap/maxSupply getter returned a value. */
  maxSupply?: string;
  maxSupplyFormatted?: string;
  maxSupplySource?: string;
  holdersNote: string;
}

export interface OwnershipInfo {
  owner?: string;
  ownerIsContract?: boolean;
  ownerIsZero?: boolean;
  /** Plain-language conclusion including caveats. */
  assessment: string;
  otherAuthorities: string[];
}

export interface Classification {
  label: string;
  standards: { name: string; confidence: Confidence; evidence: string }[];
  patterns: { name: string; confidence: Confidence; evidence: string }[];
}

export interface StepStatus {
  step: string;
  status: "ok" | "partial" | "skipped" | "failed";
  detail: string;
}

export type AnalysisDepth = "source" | "abi" | "bytecode";

export interface Report {
  id: string;
  schemaVersion: 1;
  createdAt: string;
  sample?: boolean;
  network: { id: string; name: string; chainId: number; explorerUrl: string };
  address: string;
  contractName: string | null;
  depth: AnalysisDepth;
  verification: {
    verified: boolean;
    provider: string | null;
    compilerVersion?: string;
    license?: string;
    note: string;
  };
  onchain: {
    blockNumber?: string;
    bytecodeSize: number;
    bytecodeHash?: string;
    balanceWei?: string;
    balanceFormatted?: string;
    nonce?: number;
    note: string;
  };
  classification: Classification;
  summary: string[];
  proxy: ProxyInfo;
  implementation?: { address: string; contractName: string | null; verified: boolean; depth: AnalysisDepth };
  token: TokenInfo | null;
  ownership: OwnershipInfo | null;
  functions: ContractFunction[];
  events: ContractEvent[];
  modifiers: string[];
  inheritance: string[];
  permissions: Permission[];
  findings: Finding[];
  sources: SourceFile[];
  sourceFromImplementation: boolean;
  limitations: string[];
  steps: StepStatus[];
  analysers: { name: string; status: "ran" | "not_configured" | "failed" | "not_applicable"; detail: string }[];
}

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
