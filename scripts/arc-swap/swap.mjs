#!/usr/bin/env node
// Buy / sell an o1 Launchpad token on Arc mainnet straight through Uniswap v4.
//
// o1 Launchpad tokens have no bonding curve: the whole supply sits in one
// permanent Uniswap v4 pool (with o1's fee hook) from the moment they launch,
// paired against USDC. So "swapping" is just a v4 swap through the
// Universal Router. This script:
//
//   1. finds the pool for <token> (scans PoolManager `Initialize` events, or
//      uses a PoolKey you give it),
//   2. quotes the trade with the v4 Quoter,
//   3. approves via Permit2 (ERC-20 leg only),
//   4. sends the swap through the Universal Router with a min-out for slippage.
//
// Usage:
//   node --env-file=.env swap.mjs buy  <token> <usdcAmount>  [--slippage 1] [--dry-run]
//   node --env-file=.env swap.mjs sell <token> <tokenAmount> [--slippage 1] [--dry-run]
//   node --env-file=.env swap.mjs pool <token>          # just print the PoolKey / price
//
// Amounts are human units ("25" = 25 USDC, "1000000" = 1M tokens).

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseUnits,
  formatUnits,
  getAddress,
  isAddress,
  maxUint256,
  maxUint160,
  zeroAddress,
  parseAbi,
  BaseError,
  ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc } from 'viem/chains';

// ---------------------------------------------------------------------------
// Arc mainnet (chain id 5042) — Uniswap deployments
// Source: Uniswap/contracts deployments/5042.md, Uniswap/sdks sdk-core ARC_ADDRESSES,
//         universal-router-sdk CHAIN_CONFIGS[5042].
// ---------------------------------------------------------------------------
const ADDR = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  universalRouter: '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1',
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  // USDC on Arc: native gas token (18 dec via msg.value) AND this 6-decimal ERC-20 predeploy.
  usdcErc20: '0x3600000000000000000000000000000000000000',
};
const UNIVERSAL_ROUTER_CREATION_BLOCK = 20147782n; // o1 launchpad suite start block on Arc; no o1 pool exists earlier

// Universal Router command + v4 router actions (Commands.sol / Actions.sol)
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;

// ---------------------------------------------------------------------------
// ABIs (only what we call)
// ---------------------------------------------------------------------------
const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const permit2Abi = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

const poolManagerAbi = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);

const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

const poolKeyAbiParams = [
  {
    type: 'tuple',
    name: 'poolKey',
    components: [
      { type: 'address', name: 'currency0' },
      { type: 'address', name: 'currency1' },
      { type: 'uint24', name: 'fee' },
      { type: 'int24', name: 'tickSpacing' },
      { type: 'address', name: 'hooks' },
    ],
  },
];

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage:
  node --env-file=.env swap.mjs buy  <token> <usdcAmount>  [--slippage <pct>] [--dry-run]
  node --env-file=.env swap.mjs sell <token> <tokenAmount> [--slippage <pct>] [--dry-run]
  node --env-file=.env swap.mjs pool <token>

env: ARC_RPC_URL (required), PRIVATE_KEY (required for buy/sell),
     optional POOL_FROM_BLOCK, LOG_CHUNK, QUOTE/HOOK/FEE/TICK_SPACING, HOOK_DATA`);
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const args = { slippagePct: 1, dryRun: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slippage') args.slippagePct = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('--')) usage(`unknown flag ${a}`);
    else args.positional.push(a);
  }
  const [cmd, token, amount] = args.positional;
  if (!['buy', 'sell', 'pool'].includes(cmd)) usage('command must be buy, sell or pool');
  if (!token || !isAddress(token)) usage('token must be a 0x address');
  if (cmd !== 'pool' && !(amount && Number(amount) > 0)) usage('amount must be a positive number');
  if (!(args.slippagePct >= 0 && args.slippagePct < 100)) usage('--slippage must be 0..100');
  return { ...args, cmd, token: getAddress(token), amount };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const isNative = (c) => c.toLowerCase() === zeroAddress;
const lower = (c) => c.toLowerCase();

function trimNum(str, sig = 8) {
  // keep `sig` significant digits after the leading zeros, drop trailing zeros
  const [int, frac = ''] = str.split('.');
  if (!frac) return int;
  const lead = frac.match(/^0*/)[0].length;
  const cut = frac.slice(0, int !== '0' ? sig : lead + sig).replace(/0+$/, '');
  return cut ? `${int}.${cut}` : int;
}

function poolId(key) {
  return keccak256(encodeAbiParameters(poolKeyAbiParams, [key]));
}

function sortCurrencies(a, b) {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

async function currencyMeta(client, currency) {
  if (isNative(currency)) return { symbol: 'USDC(native)', decimals: 18 };
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: currency, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address: currency, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
  ]);
  return { symbol, decimals };
}

async function balanceOf(client, currency, owner) {
  if (isNative(currency)) return client.getBalance({ address: owner });
  return client.readContract({ address: currency, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

function explainError(err) {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert?.data) return `${revert.data.errorName}(${(revert.data.args ?? []).join(', ')})`;
    return err.shortMessage ?? err.message;
  }
  return err?.message ?? String(err);
}

// ---------------------------------------------------------------------------
// Pool discovery
// ---------------------------------------------------------------------------
function manualPoolKey(token) {
  const { QUOTE, HOOK, FEE, TICK_SPACING } = process.env;
  const given = [QUOTE, HOOK, FEE, TICK_SPACING].filter((v) => v !== undefined && v !== '');
  if (given.length === 0) return null;
  if (given.length !== 4) usage('QUOTE, HOOK, FEE and TICK_SPACING must all be set together');
  const quote = QUOTE.toLowerCase() === 'native' ? zeroAddress : getAddress(QUOTE);
  if (!isAddress(HOOK)) usage('HOOK must be an address');
  const [currency0, currency1] = sortCurrencies(quote, token);
  return {
    currency0,
    currency1,
    fee: Number(FEE),
    tickSpacing: Number(TICK_SPACING),
    hooks: getAddress(HOOK),
  };
}

async function discoverPoolKey(client, token) {
  const latest = await client.getBlockNumber();
  const fromEnv = process.env.POOL_FROM_BLOCK ? BigInt(process.env.POOL_FROM_BLOCK) : null;
  const floor = fromEnv ?? UNIVERSAL_ROUTER_CREATION_BLOCK;
  const chunk = BigInt(process.env.LOG_CHUNK ?? 20000);

  // Both possible USDC representations; whichever the launchpad chose sorts
  // below or above the token address, so try both orderings.
  const candidates = [zeroAddress, ADDR.usdcErc20].map((q) => sortCurrencies(q, token));

  console.error(`scanning PoolManager Initialize events for ${token} (blocks ${floor} .. ${latest}, newest first)`);
  let found = [];
  for (let to = latest; to >= floor && found.length === 0; to -= chunk) {
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    for (const [c0, c1] of candidates) {
      const logs = await client.getLogs({
        address: ADDR.poolManager,
        event: poolManagerAbi[0],
        args: { currency0: c0, currency1: c1 },
        fromBlock: from,
        toBlock: to,
      });
      found.push(...logs);
    }
    if (found.length === 0) process.stderr.write('.');
  }
  process.stderr.write('\n');
  if (found.length === 0) {
    throw new Error(
      `no Uniswap v4 pool found for ${token} against USDC. ` +
        `Either the token is not an o1 Launchpad token on Arc, your RPC returned no logs, ` +
        `or set POOL_FROM_BLOCK / a manual PoolKey (QUOTE, HOOK, FEE, TICK_SPACING) in .env.`,
    );
  }
  // Prefer a hooked pool (o1 attaches its fee hook); otherwise the first found.
  const log = found.find((l) => !isNative(l.args.hooks)) ?? found[0];
  if (found.length > 1) console.error(`note: ${found.length} pools found; using the hooked one from block ${log.blockNumber}`);
  return {
    currency0: getAddress(log.args.currency0),
    currency1: getAddress(log.args.currency1),
    fee: Number(log.args.fee),
    tickSpacing: Number(log.args.tickSpacing),
    hooks: getAddress(log.args.hooks),
  };
}

async function loadPool(client, token) {
  const key = manualPoolKey(token) ?? (await discoverPoolKey(client, token));
  const id = poolId(key);
  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [id] }),
    client.readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [id] }),
  ]);
  const [sqrtPriceX96] = slot0;
  if (sqrtPriceX96 === 0n) throw new Error(`pool ${id} is not initialized on PoolManager (wrong PoolKey?)`);

  const quote = lower(key.currency0) === lower(token) ? key.currency1 : key.currency0;
  const [tokenMeta, quoteMeta] = await Promise.all([currencyMeta(client, token), currencyMeta(client, quote)]);

  // Price of 1 token in quote units, 1e36 fixed point so sub-gwei meme prices survive.
  const Q192 = 2n ** 192n;
  const SCALE = 10n ** 36n;
  const tokenIs0 = lower(key.currency0) === lower(token);
  const dec0 = tokenIs0 ? tokenMeta.decimals : quoteMeta.decimals;
  const dec1 = tokenIs0 ? quoteMeta.decimals : tokenMeta.decimals;
  let num = sqrtPriceX96 * sqrtPriceX96 * SCALE; // raw currency1 per currency0
  const d = BigInt(dec0 - dec1);
  num = d >= 0n ? num * 10n ** d : num / 10n ** -d; // raw → human units
  const p1per0 = num / Q192;
  const priceHuman = tokenIs0 ? p1per0 : p1per0 === 0n ? 0n : (SCALE * SCALE) / p1per0;

  const supply = await client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }).catch(() => null);
  const mcap = supply === null ? null : (priceHuman * supply) / 10n ** BigInt(tokenMeta.decimals);
  return { key, id, quote, tokenMeta, quoteMeta, slot0, liquidity, priceHuman, supply, mcap };
}

function printPool(token, pool) {
  const { key, id, quote, tokenMeta, quoteMeta, slot0, liquidity, priceHuman, supply, mcap } = pool;
  console.log(`token        ${token} (${tokenMeta.symbol}, ${tokenMeta.decimals} dec)`);
  console.log(`quote        ${quote} (${quoteMeta.symbol}, ${quoteMeta.decimals} dec)`);
  console.log(`poolId       ${id}`);
  console.log(`PoolKey      currency0=${key.currency0} currency1=${key.currency1}`);
  console.log(`             fee=${key.fee} tickSpacing=${key.tickSpacing} hooks=${key.hooks}`);
  console.log(`tick         ${slot0[1]}   lpFee=${slot0[3]}   liquidity=${liquidity}`);
  console.log(`price        1 ${tokenMeta.symbol} ≈ ${trimNum(formatUnits(priceHuman, 36))} ${quoteMeta.symbol}`);
  if (mcap !== null) {
    console.log(`supply       ${trimNum(formatUnits(supply, tokenMeta.decimals))} ${tokenMeta.symbol}`);
    console.log(`market cap   ${trimNum(formatUnits(mcap, 36), 2)} ${quoteMeta.symbol}`);
  }
}

// ---------------------------------------------------------------------------
// Swap encoding (Universal Router → V4_SWAP → [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL])
// ---------------------------------------------------------------------------
function encodeV4ExactInSingle({ key, zeroForOne, amountIn, minOut, hookData }) {
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;

  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]);
  const swapParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          ...poolKeyAbiParams,
          { type: 'bool', name: 'zeroForOne' },
          { type: 'uint128', name: 'amountIn' },
          { type: 'uint128', name: 'amountOutMinimum' },
          { type: 'bytes', name: 'hookData' },
        ],
      },
    ],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData }],
  );
  const settleParams = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyIn, amountIn]);
  const takeParams = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyOut, minOut]);

  const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swapParams, settleParams, takeParams]]);
  const commands = encodePacked(['uint8'], [CMD_V4_SWAP]);
  return { commands, inputs: [v4Input], currencyIn, currencyOut };
}

// ---------------------------------------------------------------------------
// Approvals (ERC-20 → Permit2 → Universal Router)
// ---------------------------------------------------------------------------
async function ensurePermit2Allowance({ publicClient, walletClient, account, currency, amount, dryRun }) {
  if (isNative(currency)) return; // native leg is paid with msg.value
  const owner = account.address;

  const erc20Allowance = await publicClient.readContract({
    address: currency, abi: erc20Abi, functionName: 'allowance', args: [owner, ADDR.permit2],
  });
  if (erc20Allowance < amount) {
    console.error(`approving ${currency} → Permit2 (max)`);
    if (!dryRun) {
      const hash = await walletClient.writeContract({
        address: currency, abi: erc20Abi, functionName: 'approve', args: [ADDR.permit2, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.error(`  ok ${hash}`);
    }
  }

  const [p2Amount, p2Exp] = await publicClient.readContract({
    address: ADDR.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, currency, ADDR.universalRouter],
  });
  const now = Math.floor(Date.now() / 1000);
  if (p2Amount < amount || p2Exp <= now) {
    const expiration = now + 30 * 24 * 3600; // 30 days
    console.error(`approving Permit2 → Universal Router for ${currency} (max, 30d)`);
    if (!dryRun) {
      const hash = await walletClient.writeContract({
        address: ADDR.permit2, abi: permit2Abi, functionName: 'approve',
        args: [currency, ADDR.universalRouter, maxUint160, expiration],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.error(`  ok ${hash}`);
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpc = process.env.ARC_RPC_URL;
  if (!rpc) usage('ARC_RPC_URL is not set');

  const publicClient = createPublicClient({ chain: arc, transport: http(rpc) });
  const chainId = await publicClient.getChainId();
  if (chainId !== arc.id) throw new Error(`RPC is chain ${chainId}, expected Arc mainnet ${arc.id}`);

  const pool = await loadPool(publicClient, args.token);
  printPool(args.token, pool);
  if (args.cmd === 'pool') return;

  if (!process.env.PRIVATE_KEY) usage('PRIVATE_KEY is not set');
  const account = privateKeyToAccount(process.env.PRIVATE_KEY);
  const walletClient = createWalletClient({ account, chain: arc, transport: http(rpc) });
  const hookData = (process.env.HOOK_DATA ?? '0x');

  const { key, quote, tokenMeta, quoteMeta } = pool;
  const buying = args.cmd === 'buy';
  const currencyIn = buying ? quote : args.token;
  const currencyOut = buying ? args.token : quote;
  const inMeta = buying ? quoteMeta : tokenMeta;
  const outMeta = buying ? tokenMeta : quoteMeta;
  const amountIn = parseUnits(args.amount, inMeta.decimals);
  const zeroForOne = lower(currencyIn) === lower(key.currency0);

  console.log(`\n${args.cmd.toUpperCase()}  ${args.amount} ${inMeta.symbol} → ${outMeta.symbol}  (slippage ${args.slippagePct}%)`);
  console.log(`wallet       ${account.address}`);

  const bal = await balanceOf(publicClient, currencyIn, account.address);
  if (bal < amountIn) {
    throw new Error(`insufficient ${inMeta.symbol}: have ${formatUnits(bal, inMeta.decimals)}, need ${args.amount}`);
  }
  const gasBal = await publicClient.getBalance({ address: account.address });
  if (gasBal === 0n) throw new Error('wallet has 0 native USDC on Arc — gas is paid in USDC, bridge some first');

  // quote
  let amountOut;
  try {
    const { result } = await publicClient.simulateContract({
      address: ADDR.v4Quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData }],
    });
    amountOut = result[0];
  } catch (e) {
    throw new Error(`quote failed: ${explainError(e)}\n(the o1 hook may block swaps during the anti-snipe window, or the amount exceeds pool liquidity)`);
  }
  const minOut = amountOut - (amountOut * BigInt(Math.round(args.slippagePct * 100))) / 10000n;
  console.log(`quote        ${formatUnits(amountOut, outMeta.decimals)} ${outMeta.symbol}`);
  console.log(`min out      ${formatUnits(minOut, outMeta.decimals)} ${outMeta.symbol}`);

  await ensurePermit2Allowance({ publicClient, walletClient, account, currency: currencyIn, amount: amountIn, dryRun: args.dryRun });

  const { commands, inputs } = encodeV4ExactInSingle({ key, zeroForOne, amountIn, minOut, hookData });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
  const value = isNative(currencyIn) ? amountIn : 0n;

  const request = {
    address: ADDR.universalRouter, abi: universalRouterAbi, functionName: 'execute',
    args: [commands, inputs, deadline], value, account,
  };

  if (args.dryRun) {
    console.log('\n[dry-run] would send Universal Router.execute with:');
    console.log(`  commands ${commands}`);
    console.log(`  inputs   ${inputs[0]}`);
    console.log(`  value    ${value}`);
    try {
      await publicClient.simulateContract(request);
      console.log('  simulation: OK');
    } catch (e) {
      console.log(`  simulation: REVERT ${explainError(e)}`);
    }
    return;
  }

  let hash;
  try {
    const { request: sim } = await publicClient.simulateContract(request);
    hash = await walletClient.writeContract(sim);
  } catch (e) {
    throw new Error(`swap reverted: ${explainError(e)}`);
  }
  console.log(`\ntx           ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`status       ${receipt.status}  block ${receipt.blockNumber}  gasUsed ${receipt.gasUsed}`);
  const after = await balanceOf(publicClient, currencyOut, account.address);
  console.log(`balance      ${formatUnits(after, outMeta.decimals)} ${outMeta.symbol}`);
}

main().catch((e) => {
  console.error(`\nerror: ${e.message ?? e}`);
  process.exit(1);
});
