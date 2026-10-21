# Robinhood Chain test checklist

Configuration verified against https://docs.robinhood.com/chain/connecting (October 2026):
mainnet chain ID **4663**, testnet **46630**, public RPCs `https://rpc.mainnet.chain.robinhood.com` /
`https://rpc.testnet.chain.robinhood.com`, explorers `robinhoodchain.blockscout.com` /
`explorer.testnet.chain.robinhood.com` (both Blockscout, Etherscan-compatible `/api`).

Automated live checks: `UNWRAP_LIVE_TESTS=1 npm run test:live` (`tests/live/robinhood.live.test.ts`).
They use addresses published by their issuers: testnet WETH from Robinhood's
[Token Contracts](https://docs.robinhood.com/chain/contracts) page, mainnet USDG from
[Paxos](https://docs.paxos.com/guides/stablecoin/usdg/mainnet).

"Local" = verified in this repository's test suite against a real EVM node (anvil) with
simulated Blockscout responses. "Live" = must be confirmed against Robinhood's infrastructure.

| Check | How UNWRAP does it | Local | Live |
|---|---|---|---|
| RPC connectivity | viem client, configured RPC first, then public fallback | ✅ | ⬜ run test:live |
| Chain ID validation | `eth_chainId` must equal 4663/46630 before any read; mismatch aborts | ✅ (`CHAIN_ID_MISMATCH` test) | ⬜ |
| Address validation | format + EIP-55 checksum before any request | ✅ unit | n/a |
| Bytecode retrieval | `eth_getCode`; empty code → `NO_CONTRACT_CODE` with nonce | ✅ | ⬜ |
| Verified source | Blockscout `/api?module=contract&action=getsourcecode`, merges `AdditionalSources`; Sourcify fallback | ✅ (simulated Blockscout) | ⬜ |
| ABI parsing | ABI from Blockscout; selectors via viem | ✅ | ⬜ |
| Token metadata | `name/symbol/decimals/totalSupply`, `cap/maxSupply` only if present | ✅ | ⬜ |
| Proxy detection | EIP-1967 slots via `eth_getStorageAt`, beacon call, EIP-1167 template, Blockscout `ImplementationAddress` | ✅ | ⬜ (USDG expected to be a proxy) |
| Report generation | full pipeline, stored in Postgres | ✅ | ⬜ |
| Explorer links | `https://robinhoodchain.blockscout.com/address/<addr>` | ✅ rendered | ⬜ click-through |
| Failure handling | dead RPC → `NETWORK_UNAVAILABLE`; explorer 5xx → recorded, analysis continues | ✅ | ⬜ |

Notes
- The public RPC is rate-limited. Set `ROBINHOOD_RPC_URL` to a provider endpoint (Robinhood recommends Alchemy) for production.
- Robinhood Chain is an Arbitrum Orbit chain; EVM behaviour matches Ethereum for everything UNWRAP reads.
