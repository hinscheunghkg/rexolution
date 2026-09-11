# arc-swap — trade o1 Launchpad tokens on Arc without a UI

o1 Launchpad tokens have no bonding curve and no "graduation". The whole supply is
placed in one permanent Uniswap v4 pool (with o1's fee hook) the moment the token
launches, paired against USDC. So trading one is a plain Uniswap v4 swap on Arc,
and this script does that swap directly against the contracts.

## Requirements

- Node 20.6+ (uses `--env-file`)
- An Arc mainnet RPC URL (chain id 5042). Take one from the Arc docs or your node provider.
- A wallet with USDC **on Arc**. Gas on Arc is paid in USDC, so bridge USDC to Arc
  first via Circle CCTP. Nothing works without it.

## Setup

```bash
cd scripts/arc-swap
npm install
cp .env.example .env   # fill in ARC_RPC_URL and PRIVATE_KEY
```

## Use

```bash
# inspect the pool: PoolKey, hook, liquidity, current price
npm run swap -- pool 0xTOKEN

# buy with 25 USDC, 1% max slippage, simulate only
npm run swap -- buy 0xTOKEN 25 --slippage 1 --dry-run

# buy for real
npm run swap -- buy 0xTOKEN 25

# sell 1,000,000 tokens back to USDC
npm run swap -- sell 0xTOKEN 1000000
```

Amounts are human units (`25` = 25 USDC). Always run `--dry-run` first: it quotes
the trade and simulates the exact Universal Router call, so a revert shows up
before you spend anything.

## How it finds the pool

It scans the v4 PoolManager for `Initialize` events whose currencies are the token
and USDC (both the native USDC form and the 6-decimal ERC-20 predeploy are tried),
newest blocks first. If your RPC is slow or caps log ranges, set `POOL_FROM_BLOCK`
to the block of the token's launch tx (from Arcscan) and lower `LOG_CHUNK`.

If you already know the pool from the o1 "production contracts" page, skip the scan
by setting `QUOTE`, `HOOK`, `FEE` and `TICK_SPACING` in `.env`.

## What a swap does on chain

1. **ERC-20 leg only:** `approve(token → Permit2)` once, then `Permit2.approve(token, UniversalRouter)`.
   Native USDC is sent as `msg.value` and needs no approval.
2. Quote via `V4Quoter.quoteExactInputSingle`.
3. `UniversalRouter.execute` with command `V4_SWAP` and actions
   `SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL`, with `amountOutMinimum` set from
   the quote and your slippage. Output goes straight to your wallet.

## Addresses used (Arc mainnet, 5042)

| Contract | Address |
|---|---|
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Universal Router | `0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1` |
| V4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| USDC ERC-20 predeploy (6 dec) | `0x3600000000000000000000000000000000000000` |

Sources: Uniswap `contracts` repo `deployments/5042.md`, `sdk-core` `ARC_ADDRESSES`,
`universal-router-sdk` `CHAIN_CONFIGS[5042]`, Uniswap/UniswapX `playbook/chains/arc.md`.

## Gotchas

- **USDC has two faces on Arc.** Native balance is 18 decimals, the ERC-20 predeploy
  is 6 decimals, same money. The script reads decimals from whichever form the pool
  uses, so pass human amounts and don't convert yourself.
- **Anti-snipe window.** o1's hook can block or tax swaps for a short period after
  launch. The quote will revert with the hook's error; wait and retry.
- **Hook data.** o1's hook takes no calldata by default (`HOOK_DATA=0x`). If a launch
  needs something, set `HOOK_DATA` in `.env`.
- **Private key.** `.env` is git-ignored. Use a fresh hot wallet, not your main one.
