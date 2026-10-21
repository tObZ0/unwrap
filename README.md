# UNWRAP

**Every contract has a story. Unwrap it.**

UNWRAP explains EVM smart contracts in plain English. Paste an address, choose the network, and get a
report on what the contract does, who controls it, which risky patterns it contains, and what the
analysis cannot establish. Follow-up questions are answered by an AI model that must cite the report's
evidence. Robinhood Chain is the primary network; eight other EVM networks are supported through configuration.

> UNWRAP is informational. It is not a security audit, it cannot prove a contract is safe, and the
> UNWRAP codebase itself has not been externally audited.

## Contents
- [What a report contains](#what-a-report-contains)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Database](#database)
- [AI provider](#ai-provider)
- [Networks](#networks) · [Adding a network](#adding-a-network)
- [Static analysis (Slither worker)](#static-analysis-slither-worker)
- [Testing](#testing)
- [Deploying to Vercel](#deploying-to-vercel)
- [Feature status](#feature-status)
- [Limitations and before-launch work](#limitations-and-before-launch-work)

## What a report contains
- **Overview**: classification (ERC-20/721/1155, Ownable, AccessControl, proxy, multisig…), verification,
  on-chain facts (block, native balance, bytecode), token data, proxy relationship, who is in control.
- **Functions**: every callable function with selector, mutability, access rule, source location and a
  plain-English explanation. Searchable and filterable.
- **Permissions**: mint, burn, pause, blacklist, fee/limit changes, upgrades, arbitrary calls, fund
  withdrawal, ownership/role management, each with the authority that holds it and evidence.
- **Security**: findings with severity, confidence and a *kind*: confirmed behaviour, potential
  vulnerability, heuristic warning, informational, or unknown. Each has evidence, a next step and limitations.
  There is deliberately **no aggregate risk score**.
- **Source code**: verified files with highlighting; evidence links jump to the exact line.
- **Ask AI**: contract-scoped questions with cited evidence.

## Architecture
```
Browser ── Next.js App Router (React 19, Tailwind 4)
             │
             ├─ /api/analyze ─► pipeline.ts
             │                   ├─ chain-reader.ts (viem, RPC fallback, chain-ID check)
             │                   ├─ explorer/ (Blockscout | Etherscan V2 | Sourcify) via safe-fetch
             │                   ├─ bytecode.ts (selectors, opcodes, EIP-1167)
             │                   ├─ proxy.ts (EIP-1967 slots, beacon, legacy)
             │                   ├─ source-analyzer.ts (Solidity AST, effect propagation)
             │                   ├─ engine.ts (functions, permissions, findings, classification)
             │                   ├─ onchain.ts (token, ownership, on-chain findings)
             │                   └─ slither.ts ──HTTP──► worker/ (isolated Slither service)
             ├─ /api/ask ─────► ai/context.ts → ai/provider.ts → ai/ask.ts (schema + citation validation)
             ├─ /api/reports  ─► server/store.ts (PostgreSQL | in-memory dev store)
             ├─ /api/networks, /api/health
```
Data retrieval, analysis, AI and presentation are separate modules. All server HTTP goes through
`safe-fetch.ts`, which only reaches hosts derived from server configuration (SSRF protection), disables
redirects, enforces timeouts and response-size limits. Users can never supply RPC or explorer URLs.

**Stack**: Next.js 16, React 19, TypeScript (strict, `noUncheckedIndexedAccess`), Tailwind CSS 4, Radix UI
primitives, Lucide icons, viem, @solidity-parser/parser, Zod, pg, Vitest. Slither 0.11.6 in a Python worker.

## Quick start
Requires Node.js ≥ 20.9.
```bash
npm install
cp .env.example .env.local      # optional: everything works with no variables
npm run dev                     # http://localhost:3000
```
With no configuration UNWRAP uses public RPCs, Blockscout and Sourcify, keeps reports in memory, and
shows that AI is not configured.

| Command | Purpose |
|---|---|
| `npm run dev` | development server |
| `npm run build` / `npm start` | production build / server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | unit + integration tests (integration tests skip if anvil / DB are absent) |
| `npm run test:live` | live checks against Robinhood Chain (needs internet) |
| `npm run db:migrate` | apply SQL migrations to `DATABASE_URL` |
| `npm run check` | typecheck, lint, test and build |

### Try it locally against your own contracts
```bash
anvil &                                                     # Foundry
RPC=http://127.0.0.1:8545 npx tsx scripts/deploy-fixtures.mts   # deploys the test fixtures
UNWRAP_LOCAL_DEVNET_RPC_URL=http://127.0.0.1:8545 npm run dev   # adds a "Local devnet" network
```

## Configuration
All variables are documented in [`.env.example`](.env.example). None are mandatory. Recommended for production:

| Variable | Why | Where to get it |
|---|---|---|
| `DATABASE_URL` | persistent reports, shared rate limits | Neon, Supabase, any PostgreSQL ≥ 13 |
| `ROBINHOOD_RPC_URL` (+ other `*_RPC_URL`) | public RPCs are rate-limited | Alchemy (recommended by Robinhood), QuickNode, Chainstack… |
| `ETHERSCAN_API_KEY` | verified source on Ethereum, Base, Arbitrum, BNB, Optimism, Polygon, Avalanche | etherscan.io/apis (free tier does not cover every chain) |
| `AI_API_KEY` | AI explanations | console.anthropic.com, or an OpenAI-compatible provider |
| `SLITHER_WORKER_URL`, `SLITHER_WORKER_TOKEN` | Slither findings | deploy `worker/` (below) |
| `RATE_LIMIT_SALT` | keys for hashed client IPs | any random string |

Secrets are only read server-side. The only `NEXT_PUBLIC_` variables are optional footer links.

## Database
```bash
DATABASE_URL=postgres://user:pass@host:5432/db npm run db:migrate
```
Migrations live in `db/migrations` and are tracked in `schema_migrations` (safe to re-run). Tables:
`reports` (full report JSON plus indexed columns), `ai_messages`, `rate_limits`, `usage_events`.
Users are anonymous: a browser gets a random httpOnly cookie; only its SHA-256 hash is stored. It owns
the reports and conversations it creates. Private reports return 404 to everyone else. No emails, wallet
addresses of users or raw IPs are stored.

Without `DATABASE_URL`, an in-memory store is used. The UI and `/api/health` say so explicitly; it is
for development only (lost on restart, not shared across serverless instances).

## AI provider
```bash
AI_PROVIDER=anthropic AI_API_KEY=sk-ant-...          # default model claude-sonnet-5-5 (override with AI_MODEL)
AI_PROVIDER=openai AI_API_KEY=... AI_MODEL=<model> [AI_BASE_URL=https://.../v1]
```
How answers are kept honest:
1. **Targeted context**: the structured report, all permissions, the most relevant findings and functions,
   and source excerpts for the most relevant functions, within a fixed character budget.
2. **Untrusted data fencing**: contract-derived text (code, comments, names) is wrapped in a
   `<contract_data>` block the system prompt says never to obey; attempts to close the block are neutralised.
3. **Structured output**: the model must return JSON (`answer`, `status`, `citations`, `caveats`) validated with Zod;
   anything else is discarded with an error, never shown.
4. **Citation checking**: citations not present in the context are dropped and stripped from the prose;
   answers with no valid citation are flagged in the UI as unverified.

Adding a provider: implement `AiProvider` in `src/lib/ai/provider.ts`.

## Networks
| Network | Chain ID | Verified source from |
|---|---|---|
| Robinhood Chain (primary) | 4663 | Blockscout, Sourcify |
| Robinhood Chain Testnet | 46630 | Blockscout, Sourcify |
| Ethereum | 1 | Etherscan V2 (key), Sourcify |
| Base | 8453 | Etherscan V2 (key), Sourcify |
| Arbitrum One | 42161 | Etherscan V2 (key), Sourcify |
| BNB Smart Chain | 56 | Etherscan V2 (key), Sourcify |
| Optimism | 10 | Etherscan V2 (key), Sourcify |
| Polygon PoS | 137 | Etherscan V2 (key), Sourcify |
| Avalanche C-Chain | 43114 | Etherscan V2 (key), Sourcify |

Robinhood values were verified against [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting)
and match viem's `robinhood`/`robinhoodTestnet` definitions; other chains use viem's maintained definitions.
See [`docs/ROBINHOOD_CHAIN_CHECKLIST.md`](docs/ROBINHOOD_CHAIN_CHECKLIST.md).

### Adding a network
Add one entry to `BASE_NETWORKS` in `src/lib/networks/registry.ts`:
```ts
etherscanNetwork("linea", "Linea", linea, "LINEA_RPC_URL", "Lineascan"),
// or, for a Blockscout chain:
{ id: "mychain", name: "My Chain", shortName: "My Chain", chainId: 12345, testnet: false, primary: false,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcEnvVar: "MYCHAIN_RPC_URL",
  publicRpcUrls: ["https://rpc.mychain.example"],
  explorer: { name: "Blockscout", url: "https://explorer.mychain.example",
              api: { kind: "blockscout", baseUrl: "https://explorer.mychain.example" } },
  sourcify: true, viemChain: myChain },
```
Then add `MYCHAIN_RPC_URL=` to `.env.example`. The selector, homepage table, API allowlist and SSRF
allowlist pick it up automatically. Hide a network with `UNWRAP_DISABLED_NETWORKS=id1,id2`.

## Static analysis (Slither worker)
Compiling untrusted Solidity must never happen in the web server, so Slither runs in `worker/`:
bearer-token auth, body/file/path validation, a fresh temp directory per job, scrubbed environment,
CPU/memory/file-size rlimits and a wall-clock timeout. It only uses pre-installed compilers unless
`SOLC_AUTO_INSTALL=1`.
```bash
docker build -t unwrap-slither ./worker
docker run --rm -p 8787:8787 -e SLITHER_WORKER_TOKEN=$(openssl rand -hex 32) \
  --read-only --tmpfs /tmp --memory 3g --cpus 1 unwrap-slither
```
In production, place the worker on a private
network reachable only by the app (Fly.io private networking, Cloud Run with internal ingress, a VPC),
with no outbound internet. Then set `SLITHER_WORKER_URL` and `SLITHER_WORKER_TOKEN` in the app.
Add solc versions to the Dockerfile as needed; unsupported versions are reported, not guessed.

Without the worker, UNWRAP's own AST rules still run; reports state that Slither was not configured.

## Testing
```bash
npm test                                                     # unit tests (always) + integration (when tools exist)
ANVIL_BIN=$(which anvil) npm test                            # + 10 tests against a real local EVM
TEST_DATABASE_URL=postgres://... npm test                    # + 5 tests against real PostgreSQL (migrate first)
SLITHER_WORKER_URL=http://127.0.0.1:8787 SLITHER_WORKER_TOKEN=... ANVIL_BIN=... npm test   # + Slither assertions
UNWRAP_LIVE_TESTS=1 npm run test:live                        # Robinhood Chain live checks
SOLC=/path/to/solc node tests/fixtures/compile.mjs           # rebuild fixture artifacts
```
External services are mocked in unit tests. The fixture contracts in `tests/fixtures/contracts` are
deliberately unsafe; never deploy them to a real network. The sample report (`src/data/sample-report.json`)
is regenerated from the RiskyToken fixture with `UNWRAP_WRITE_SAMPLE=1` during the anvil test.

## Deploying to Vercel
1. Push the repository to GitHub/GitLab and import it in Vercel (framework preset: Next.js; defaults for build/output).
2. Create a PostgreSQL database (Vercel Marketplace → Neon, or Supabase) and run migrations once from your machine:
   `DATABASE_URL=<production url> npm run db:migrate`.
3. In *Project → Settings → Environment Variables* add at least `DATABASE_URL`, `ROBINHOOD_RPC_URL`,
   `RATE_LIMIT_SALT`, and optionally `AI_API_KEY`, `ETHERSCAN_API_KEY`, `SLITHER_WORKER_URL/TOKEN` and the other RPC URLs.
4. Deploy. Check `https://<your-domain>/api/health`: storage should be `postgres` and `reachable: true`.
5. Function duration: `/api/analyze` exports `maxDuration = 180` and `/api/ask` 60. If your plan's limit is lower,
   reduce `ANALYSIS_TIMEOUT_MS` below it.
6. Deploy the Slither worker separately (Vercel functions cannot run Slither/solc).

## Feature status
**Implemented and verified by automated tests**: network registry and validation; chain-ID check; bytecode,
balance and nonce retrieval; EOA vs contract distinction; Blockscout/Etherscan V2/Sourcify lookup incl.
multi-file; ABI and Solidity AST analysis; permissions with evidence; UNWRAP security rules; Slither worker
and normalisation; EIP-1967 transparent/UUPS/beacon, EIP-1167 and legacy proxy detection; token metadata;
cautious ownership assessment; PostgreSQL store, private reports, conversation history, rate limiting;
AI context building, output validation, citation checking and missing-key handling; API validation and error
handling; SSRF allowlist; production build.

**Implemented, partially verified**: the UI (server-rendered pages checked over HTTP; responsive layout
reviewed in code but not visually tested in a browser); AI answers (request/validation path tested with a mocked
provider; not run against a live model); Robinhood Chain live behaviour (see checklist).

**Not implemented**: transaction/buy-sell simulation (UNWRAP never claims honeypot status); holder statistics;
Vyper analysis; user accounts beyond anonymous browser ownership; wallet connection (not needed for read-only analysis).

## Limitations and before-launch work
- Run `npm run test:live` from a machine with internet access and complete the Robinhood checklist.
- Configure a dedicated Robinhood RPC; the public endpoint is rate-limited.
- Deploy the Slither worker on a private network and pre-install the compiler versions you need.
- Exercise the AI assistant against a real model and review answers for a set of known contracts.
- Visual QA on real devices and an accessibility audit (keyboard paths and ARIA are implemented, not audited).
- The AST analyser approximates inheritance linearisation and does not resolve types or cross-contract data flow;
  findings carry confidence levels for this reason.
- In-memory rate limiting is per instance; use PostgreSQL in production.
- Consider an external security review of UNWRAP itself before handling significant traffic.
