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
rate limiting, AI layer (tested with a mocked model only), Slither worker, 87 automated tests.

## Remaining work, in priority order
1. **Database on Vercel**: the live site still uses in-memory storage, which breaks on serverless
   (analysis succeeds, then the report page can't find it). Connect Neon via Vercel → Storage, redeploy,
   confirm `/api/health` shows `"kind":"postgres"`. Tables are created automatically.
2. **Robinhood live verification**: run `npm run test:live`; analyse testnet WETH
   0x7943e237c7F95DA44E0301572D358911207852Fa and mainnet USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
   on the live site; fix anything that fails; tick off `docs/ROBINHOOD_CHAIN_CHECKLIST.md`.
3. **AI**: add `AI_API_KEY` in Vercel; test real answers on several reports; fix prompt/validation issues.
4. Optional: `ETHERSCAN_API_KEY`, `ROBINHOOD_RPC_URL` (Alchemy), deploy `worker/` (Railway/Fly.io, private network)
   and set `SLITHER_WORKER_URL/TOKEN`, social links (`NEXT_PUBLIC_SOCIAL_*`).
5. Not built (optional in brief): transaction simulation, holder data, user accounts.
