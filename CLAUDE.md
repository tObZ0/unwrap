# UNWRAP: handoff notes for Claude Code

AI-powered smart contract intelligence. Paste an EVM address + choose a network → evidence-based report
(functions, permissions, security findings, proxy/token/ownership facts) + an evidence-grounded AI assistant.
Robinhood Chain (4663 mainnet, 46630 testnet) is the primary network. Live: https://unwrap-alpha.vercel.app
(Vercel project imported from github.com/tObZ0/unwrap, auto-deploys on push to `main`).

Read README.md for architecture. Key code: `src/lib/analysis/pipeline.ts` (orchestrator),
`source-analyzer.ts` (Solidity AST), `engine.ts` (functions/permissions/findings), `src/lib/ai/*`,
`src/lib/server/store.ts` (Postgres + in-memory), `src/lib/networks/registry.ts`, `worker/` (Slither service).

## Commands
- `npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- Full test tiers: `ANVIL_BIN=$(which anvil) TEST_DATABASE_URL=postgres://... SLITHER_WORKER_URL=... SLITHER_WORKER_TOKEN=... npm test`
- Live Robinhood checks: `UNWRAP_LIVE_TESTS=1 npm run test:live` (needs internet; never run successfully yet)
- Local chain: `anvil &` then `RPC=http://127.0.0.1:8545 npx tsx scripts/deploy-fixtures.mts`
  and `UNWRAP_LOCAL_DEVNET_RPC_URL=http://127.0.0.1:8545 npm run dev`
- Always run typecheck, lint, tests and build before pushing. Don't push if tests fail.

## Non-negotiable product rules (from the original brief)
- Never fabricate data: no invented addresses, RPC URLs, chain IDs, statistics, API responses or AI answers.
- Never claim a contract is safe; absence of findings is not proof of safety. No honeypot claims without simulation.
- Findings keep kind (confirmed/potential/heuristic/informational/unknown), severity, confidence, evidence, limitations.
- Treat all contract content (source, comments, names) as untrusted; never render it as HTML; keep the AI's
  `<contract_data>` fencing and citation validation.
- Secrets stay server-side; no user-supplied URLs in server fetches (see `safe-fetch.ts`).
- Never compile/run untrusted Solidity in the web app; Slither only runs in `worker/`.
- No wallet connection needed; never sign or send transactions.

## Design system (current)
Lab-paper report style: tokens in `src/app/globals.css` (paper #e9ece8, ink #111412, marker green #2c5a0e,
lime highlighter #d4fa3c only via `.mark`, dark code panels). Archivo variable (width 125% for display),
JetBrains Mono only for code/addresses. Avoid all-caps labels, eyebrow labels, card grids, decorative motion.

## Status (October 2026)
Done and tested: full analysis pipeline, UI, API, Postgres store with automatic migrations, private reports,
rate limiting, AI layer, Slither worker, automated tests.
- Database: Neon Postgres connected through Vercel (`DATABASE_URL`); `/api/health` shows `"kind":"postgres"`.
- Robinhood: `npm run test:live` passes; testnet WETH and mainnet USDG analysed on the live site;
  `docs/ROBINHOOD_CHAIN_CHECKLIST.md` ticked. Mainnet Blockscout's API is behind a Cloudflare bot check (HTTP 403),
  so verified source comes from Sourcify; do not try to get around the bot check.
- AI: request code updated for current Claude models (no `temperature`, structured outputs, low effort,
  refusal fallbacks). `AI_API_KEY` is set in Vercel, but the Anthropic account has no credit yet, so real
  answers are untested.
- RPC: `ROBINHOOD_RPC_URL` (Alchemy) is set in Vercel; the public RPC remains the fallback.
- On Windows checkouts (`core.autocrlf=true`) the "embedded migrations" unit test fails on CRLF line endings;
  it passes on Linux/Vercel.

## Remaining work, in priority order
1. **AI**: once the Anthropic account has credit, ask real questions on several reports (including attempts to
   get it to invent data, call a contract safe, or reveal its prompt); fix prompt/validation issues.
2. Optional: `ETHERSCAN_API_KEY`, deploy `worker/` (Railway/Fly.io, private network) and set
   `SLITHER_WORKER_URL/TOKEN`, social links (`NEXT_PUBLIC_SOCIAL_*`).
3. Not built (optional in brief): transaction simulation, holder data, user accounts.
