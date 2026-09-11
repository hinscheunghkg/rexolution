// Browser swap app for o1 Launchpad tokens on Arc (Uniswap v4 via Universal Router).
// Bundled by web/build.mjs into ../swap.html. Talks to the chain only through the
// injected wallet (MetaMask / Rabby / Coinbase Wallet), so no RPC key is needed.

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  fallback,
  defineChain,
  decodeErrorResult,
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

// ---------------------------------------------------------------------------
// Arc mainnet (5042) — Uniswap deployments (Uniswap/contracts deployments/5042.md)
// ---------------------------------------------------------------------------
const ADDR = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  universalRouter: '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1',
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  usdcErc20: '0x3600000000000000000000000000000000000000',
};
// o1 Launchpad on Arc mainnet (from docs.o1.exchange → production contracts → Arc mainnet)
const O1 = {
  launchFactory: '0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605',
  launchHook: '0x20EEad6db6b3d0a4491E9073119DD0EBFF166AcC',
  feeEscrow: '0x1D8c991A9019df7D72ADCd8deA6f12D600C9d02f',
  tokenDeployer: '0xFf70918Ef17A2D74d683a8297813B177BaFaD1f4',
  launchBuyAdapter: '0xacA9150b1ecAeddEf5cF6a24f12b060049Cec06f',
  swapXRouter: '0x528154f6DE668988A2DD1B4db96F470716d0493B',
  startBlock: 20147782n, // "arc-mainnet-launchpad-v4-minimal starts at block 20147782"
};
const ROUTER_CREATION_BLOCK = O1.startBlock; // no o1 pool exists before the launchpad was deployed
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;
const EXPLORER = 'https://arcscan.app';
const BUILD = '__BUILD__';
const DEFAULT_RPC = 'https://rpc.arc-scan.org';

const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [] } },
  blockExplorers: { default: { name: 'Arcscan', url: EXPLORER } },
});

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
const initializeEvent = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
])[0];
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);
const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const knownErrors = [
  // Universal Router / V4Router
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error TransactionDeadlinePassed()',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)',
  'error DeltaNotPositive(address currency)',
  'error DeltaNotNegative(address currency)',
  'error InputLengthMismatch()',
  'error InvalidCommandType(uint256 commandType)',
  'error ContractLocked()',
  'error InsufficientBalance()',
  'error NotPoolManager()',
  // Permit2
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  'error InvalidNonce()',
  // PoolManager / Hooks / CustomRevert
  'error CurrencyNotSettled()',
  'error ManagerLocked()',
  'error PoolNotInitialized()',
  'error SwapAmountCannotBeZero()',
  'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)',
  'error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)',
  'error HookCallFailed()',
  'error InvalidHookResponse()',
  'error HookDeltaExceedsSwapAmount()',
  'error HookAddressNotValid(address hooks)',
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
  'error Wrap__FailedHookCall(address hook, bytes revertReason)',
  // common ERC-20 / hook style reasons
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error TransferFromFailed()',
  'error SafeTransferFromFailed()',
];
const universalRouterAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable', ...knownErrors]);
const errorAbi = parseAbi(knownErrors);

// Turn raw revert bytes into something readable, unwrapping nested reasons.
function describeRevert(data, depth = 0) {
  if (!data || data === '0x') {
    if (depth) return '(no data)';
    const rpc = $('rpcUrl').value.trim() || DEFAULT_RPC;
    return rpc ? `no revert data — the RPC at ${rpc} hides revert reasons; try a different Arc RPC URL under Advanced (Infura, QuickNode, Alchemy)` : 'no revert data — the wallet RPC hid the reason; set an Arc RPC URL under Advanced and retry so the page can read it';
  }
  try {
    const d = decodeErrorResult({ abi: errorAbi, data });
    const args = d.args ?? [];
    const show = (a) => (typeof a === 'bigint' ? a.toString() : typeof a === 'string' && a.length > 66 ? `${a.slice(0, 10)}…` : String(a));
    let out = `${d.errorName}(${args.map(show).join(', ')})`;
    if (d.errorName === 'ExecutionFailed') out = `command ${args[0]} failed → ${describeRevert(args[1], depth + 1)}`;
    if (d.errorName === 'WrappedError') out = `${short(args[0])} reverted → ${describeRevert(args[2], depth + 1)}`;
    if (d.errorName === 'Wrap__FailedHookCall') out = `hook ${short(args[0])} reverted → ${describeRevert(args[1], depth + 1)}`;
    return out;
  } catch {}
  try {
    const d = decodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }, { type: 'error', name: 'Panic', inputs: [{ type: 'uint256' }] }], data });
    return `${d.errorName}(${String(d.args?.[0])})`;
  } catch {}
  return `unknown selector ${data.slice(0, 10)} (${data.length / 2 - 1} bytes)`;
}
const poolKeyAbiParams = [{
  type: 'tuple', name: 'poolKey',
  components: [
    { type: 'address', name: 'currency0' }, { type: 'address', name: 'currency1' },
    { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' },
  ],
}];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const isNative = (c) => c.toLowerCase() === zeroAddress;
const lower = (c) => c.toLowerCase();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const poolIdOf = (key) => keccak256(encodeAbiParameters(poolKeyAbiParams, [key]));
const sortCurrencies = (a, b) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

function trimNum(str, sig = 6) {
  const [int, frac = ''] = str.split('.');
  if (!frac) return int;
  const lead = frac.match(/^0*/)[0].length;
  const cut = frac.slice(0, int !== '0' ? sig : lead + sig).replace(/0+$/, '');
  return cut ? `${int}.${cut}` : int;
}
const fmt = (v, dec, sig) => trimNum(formatUnits(v, dec), sig);
// USDC amount in 1e36 fixed point → "$1.23M" style
function usd(v36) {
  const n = Number(formatUnits(v36, 36));
  if (!isFinite(n)) return '$?';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function revertData(err) {
  let found = null;
  err?.walk?.((e) => { if (!found && typeof e?.data === 'string' && e.data.startsWith('0x') && e.data.length > 2) found = e.data; return false; });
  if (!found && typeof err?.data === 'string') found = err.data;
  if (!found && typeof err?.data?.data === 'string') found = err.data.data;
  if (!found && typeof err?.cause?.data === 'string') found = err.cause.data;
  return found;
}

function explainError(err) {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert?.data?.errorName) return describeRevert(revert.raw ?? revertData(err)) || `${revert.data.errorName}(${(revert.data.args ?? []).join(', ')})`;
    const raw = revertData(err);
    if (raw) return `reverted: ${describeRevert(raw)}`;
    if (/reverted|execution reverted/i.test(err.shortMessage ?? '')) return `reverted: ${describeRevert(null)}`;
    return err.shortMessage ?? err.message;
  }
  if (err?.code === 4001 || /rejected/i.test(err?.message ?? '')) return 'You rejected the request in your wallet.';
  return err?.message ?? String(err);
}

const cacheKey = (token) => `arc-swap:pool:${lower(token)}`;
function readCache(token) { try { const v = localStorage.getItem(cacheKey(token)); return v ? JSON.parse(v) : null; } catch { return null; } }
function writeCache(token, key) { try { localStorage.setItem(cacheKey(token), JSON.stringify(key)); } catch {} }

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const S = {
  provider: null, publicClient: null, walletClient: null, account: null,
  token: null, pool: null, side: 'buy', quote: null, busy: false, connecting: false,
};

// ---------------------------------------------------------------------------
// UI plumbing
// ---------------------------------------------------------------------------
function log(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `log ${kind}`;
  el.innerHTML = msg;
  $('log').prepend(el);
}
function setStatus(msg, kind = '') {
  $('status').textContent = msg;
  $('status').className = `status ${kind}`;
}
function setBusy(b) {
  S.busy = b;
  $('swapBtn').disabled = b || !S.quote;
  $('findBtn').disabled = b;
  document.body.classList.toggle('busy', b);
}
function txLink(hash) { return `<a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`; }

// ---------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------
// Wallet discovery: EIP-6963 announcements (modern wallets) + legacy window.ethereum,
// with a short wait because extensions often inject after DOMContentLoaded.
const announced = [];
window.addEventListener('eip6963:announceProvider', (e) => {
  const d = e.detail; if (d?.provider && !announced.some((x) => x.provider === d.provider)) announced.push(d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

// All wallets we can see, as {name, icon, rdns, provider}.
function listProviders() {
  const out = [];
  for (const d of announced) out.push({ name: d.info?.name ?? 'Wallet', icon: d.info?.icon ?? '', rdns: d.info?.rdns ?? '', provider: d.provider });
  const eth = window.ethereum;
  const legacy = eth ? (Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth]) : [];
  for (const p of legacy) {
    if (out.some((o) => o.provider === p)) continue;
    out.push({ name: p.isRabby ? 'Rabby' : p.isMetaMask ? 'MetaMask' : p.isCoinbaseWallet ? 'Coinbase Wallet' : 'Browser wallet', icon: '', rdns: '', provider: p });
  }
  return out;
}

const WALLET_PREF = 'arc-swap:wallet';
function findProvider() {
  const all = listProviders();
  if (!all.length) return null;
  let pref = null; try { pref = localStorage.getItem(WALLET_PREF); } catch {}
  const chosen = pref && all.find((w) => (w.rdns || w.name) === pref);
  return (chosen ?? all[0]).provider;
}

// When several wallets are installed, let the user pick one (remembered for next time).
function chooseWallet(all) {
  return new Promise((resolve) => {
    const box = $('walletPick');
    box.innerHTML = '<div class="pick-title">Which wallet?</div>';
    for (const w of all) {
      const b = document.createElement('button');
      b.className = 'ghost pick';
      b.innerHTML = `${w.icon ? `<img src="${w.icon}" alt="">` : ''}<span>${w.name}</span>`;
      b.addEventListener('click', () => {
        try { localStorage.setItem(WALLET_PREF, w.rdns || w.name); } catch {}
        box.hidden = true; resolve(w.provider);
      });
      box.appendChild(b);
    }
    box.hidden = false;
  });
}

async function waitForProvider(ms = 2500) {
  const t0 = Date.now();
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  while (Date.now() - t0 < ms) {
    const p = findProvider(); if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  return findProvider();
}

function noWalletHelp() {
  const isFile = location.protocol === 'file:';
  const framed = window.top !== window.self;
  if (framed) return 'This page is inside a preview frame, so wallet extensions cannot reach it. Save the file and open it directly in Chrome, Brave or Firefox.';
  if (isFile) return 'No wallet injected on this file:// page. Either run "npm run web" and open http://localhost:8787, or in Chrome open chrome://extensions → your wallet → Details → enable "Allow access to file URLs", then reload.';
  return 'No wallet extension detected. Install MetaMask or Rabby in this browser, unlock it, then reload this page.';
}

async function ensureArcChain() {
  const current = await S.publicClient.getChainId();
  if (current === arc.id) return;
  try {
    await S.walletClient.switchChain({ id: arc.id });
  } catch (e) {
    const code = e?.code ?? e?.cause?.code ?? e?.walk?.((x) => x.code)?.code;
    const rpc = $('rpcUrl').value.trim();
    if (code === 4902 || /unrecognized|not added|4902/i.test(e?.message ?? '')) {
      if (!rpc) throw new Error('Arc is not in your wallet yet. Paste an Arc RPC URL in Advanced and connect again.');
      await S.walletClient.addChain({ chain: { ...arc, rpcUrls: { default: { http: [rpc] } } } });
      await S.walletClient.switchChain({ id: arc.id });
    } else throw e;
  }
  const after = await S.publicClient.getChainId();
  if (after !== arc.id) throw new Error(`Wallet is on chain ${after}, switch it to Arc (5042).`);
}

// Run a wallet request, and if it takes long, tell the user where the popup is.
async function withWalletHint(label, promise) {
  const t = setTimeout(() => setStatus(`${label} Still waiting: click your wallet's extension icon, unlock it, and approve the pending request there.`, 'err'), 8000);
  try { return await promise; } finally { clearTimeout(t); }
}

function providerName(p) {
  return listProviders().find((w) => w.provider === p)?.name ?? 'your wallet';
}

// Reads and simulations go through a direct RPC when one is set (wallets hide revert
// reasons and rate-limit log scans); transactions always go through the wallet.
const RPC_PREF = 'arc-swap:rpc';
const isRevert = (e) => (e?.code === 3) || /revert/i.test(e?.message ?? '') || /revert/i.test(e?.details ?? '');
function readClient() {
  const typed = $('rpcUrl').value.trim();
  const url = /^https?:\/\//.test(typed) ? typed : DEFAULT_RPC;
  const key = `${url}|${S.provider ? 1 : 0}`;
  if (S.readKey !== key) {
    const direct = http(url, { batch: false, retryCount: 1 });
    // direct RPC first (returns revert reasons); wallet as fallback for network/CORS failures only
    const transport = S.provider ? fallback([direct, custom(S.provider)], { retryCount: 0, shouldThrow: isRevert }) : direct;
    S.readClient = createPublicClient({ chain: arc, transport });
    S.readKey = key;
    if (typed) { try { localStorage.setItem(RPC_PREF, typed); } catch {} }
  }
  return S.readClient;
}

async function connect() {
  if (S.connecting) { setStatus('Already connecting. Check your wallet extension for a pending request.', 'err'); return; }
  S.connecting = true;
  setStatus('Looking for a wallet…');
  let provider = await waitForProvider();
  if (!provider) {
    setStatus(noWalletHelp(), 'err');
    S.connecting = false;
    return;
  }
  const all = listProviders();
  let pref = null; try { pref = localStorage.getItem(WALLET_PREF); } catch {}
  const remembered = pref && all.find((w) => (w.rdns || w.name) === pref);
  if (all.length > 1 && (!remembered || S.forcePick)) {
    setStatus('Several wallets found. Pick the one you want to use.');
    provider = await chooseWallet(all);
  }
  S.forcePick = false;
  const name = providerName(provider);
  try {
    S.provider = provider;
    const transport = custom(provider);
    S.publicClient = createPublicClient({ chain: arc, transport });
    if (location.protocol === 'file:') {
      log(`<b>Heads up:</b> ${name} usually ignores connection requests from file:// pages, so no popup may appear. Open this page over http instead — see the README for the hosted link or run <code>npm run web</code>.`, 'err');
    }
    setStatus(`Found ${name}. Approve the connection in its popup…`);
    let accounts;
    try {
      accounts = await withWalletHint(`${name} is asking you to connect.`, provider.request({ method: 'eth_requestAccounts' }));
    } catch (e) {
      if (e?.code === -32002 || /already pending/i.test(e?.message ?? '')) {
        throw new Error(`${name} already has a connection request waiting. Click the extension icon and approve it, then press Connect again.`);
      }
      throw e;
    }
    if (!accounts?.length) throw new Error(`${name} returned no account. Unlock it and try again.`);
    S.account = getAddress(accounts[0]);
    S.walletClient = createWalletClient({ chain: arc, transport, account: S.account });
    setStatus(`Connected ${short(S.account)}. Switching ${name} to Arc… approve in the popup if asked.`);
    await withWalletHint(`${name} is asking you to switch to Arc.`, ensureArcChain());
    $('connectBtn').textContent = `${name} · ${short(S.account)}`;
    $('connectBtn').classList.add('connected');
    $('connectBtn').title = 'Click to switch wallet';
    setStatus('Connected to Arc.', 'ok');
    provider.on?.('accountsChanged', () => location.reload());
    provider.on?.('chainChanged', () => location.reload());
    await refreshBalances();
    if (S.token && !S.pool) await findPool();
  } catch (e) {
    setStatus(explainError(e), 'err');
  } finally {
    S.connecting = false;
  }
}

// ---------------------------------------------------------------------------
// pool
// ---------------------------------------------------------------------------
async function currencyMeta(currency) {
  if (isNative(currency)) return { symbol: 'USDC', decimals: 18, native: true };
  const c = readClient();
  const [decimals, symbol] = await Promise.all([
    c.readContract({ address: currency, abi: erc20Abi, functionName: 'decimals' }),
    c.readContract({ address: currency, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
  ]);
  return { symbol, decimals, native: false };
}

async function balanceOf(currency, owner) {
  if (isNative(currency)) return readClient().getBalance({ address: owner });
  return readClient().readContract({ address: currency, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

function manualKey(token) {
  const hook = $('hook').value.trim(), fee = $('fee').value.trim(), ts = $('tickSpacing').value.trim(), quoteSel = $('quoteSel').value;
  if (!hook && !fee && !ts) return null;
  if (!(isAddress(hook) && fee !== '' && ts !== '')) throw new Error('Manual pool needs hook, fee and tick spacing together.');
  const quote = quoteSel === 'native' ? zeroAddress : ADDR.usdcErc20;
  const [currency0, currency1] = sortCurrencies(quote, token);
  return { currency0, currency1, fee: Number(fee), tickSpacing: Number(ts), hooks: getAddress(hook) };
}

async function discoverKey(token) {
  const c = readClient();
  const latest = await c.getBlockNumber();
  const fromInput = $('fromBlock').value.trim();
  const floor = fromInput ? BigInt(fromInput) : ROUTER_CREATION_BLOCK;
  const chunk = BigInt($('logChunk').value || 10000);
  const candidates = [zeroAddress, ADDR.usdcErc20].map((q) => sortCurrencies(q, token));
  const total = latest - floor;
  let found = [];
  for (let to = latest; to >= floor && found.length === 0; to -= chunk) {
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    setStatus(`Looking for the pool… scanned ${Number(((latest - from) * 100n) / (total || 1n))}% (block ${from})`);
    for (const [c0, c1] of candidates) {
      const logs = await c.getLogs({ address: ADDR.poolManager, event: initializeEvent, args: { currency0: c0, currency1: c1 }, fromBlock: from, toBlock: to });
      found.push(...logs);
    }
  }
  if (!found.length) throw new Error('No Uniswap v4 pool found for this token against USDC. Check the address, or fill in the pool manually under Advanced.');
  const l = found.find((x) => !isNative(x.args.hooks)) ?? found[0];
  return { currency0: getAddress(l.args.currency0), currency1: getAddress(l.args.currency1), fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing), hooks: getAddress(l.args.hooks) };
}

async function findPool() {
  const raw = $('token').value.trim();
  if (!isAddress(raw)) { setStatus('Paste a valid token address (0x…).', 'err'); return; }
  if (!S.publicClient) { setStatus('Connect your wallet first.', 'err'); return; }
  const token = getAddress(raw);
  S.token = token; S.pool = null; S.quote = null; $('quoteBox').hidden = true; $('swapBtn').disabled = true;
  setBusy(true);
  try {
    let key = manualKey(token) ?? readCache(token);
    if (key) setStatus('Checking pool…');
    let verified = false;
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      if (!key) key = await discoverKey(token);
      const id = poolIdOf(key);
      const [slot0] = await readClient().readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [id] });
      if (slot0 !== 0n) verified = true; else key = null; // stale cache → rescan
    }
    if (!verified) throw new Error('Pool key did not resolve to an initialized pool.');
    writeCache(token, key);
    const id = poolIdOf(key);
    const quote = lower(key.currency0) === lower(token) ? key.currency1 : key.currency0;
    const [tokenMeta, quoteMeta, slot0, liquidity, supply] = await Promise.all([
      currencyMeta(token), currencyMeta(quote),
      readClient().readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [id] }),
      readClient().readContract({ address: ADDR.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [id] }),
      readClient().readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }).catch(() => null),
    ]);
    const price = priceOf(key, token, slot0[0], tokenMeta.decimals, quoteMeta.decimals);
    // market cap (USDC, 1e36 fixed) = price × totalSupply / 10^tokenDecimals
    const mcap = supply === null ? null : (price * supply) / 10n ** BigInt(tokenMeta.decimals);
    S.pool = { key, id, quote, tokenMeta, quoteMeta, liquidity, price, mcap, supply, lpFee: slot0[3] };
    $('poolBox').hidden = false;
    $('poolSymbol').textContent = tokenMeta.symbol;
    $('poolPrice').textContent = `1 ${tokenMeta.symbol} ≈ ${trimNum(formatUnits(price, 36))} USDC`;
    $('poolMcap').textContent = mcap === null ? 'market cap n/a' : `market cap ${usd(mcap)}`;
    $('poolFee').textContent = `${(Number(slot0[3]) / 10000).toFixed(2)}% pool fee` + (isNative(key.hooks) ? '' : ` · hook ${short(key.hooks)}`);
    $('poolQuoteKind').textContent = quoteMeta.native ? 'native USDC' : 'USDC (ERC-20)';
    $('poolId').textContent = id;
    setStatus(`Pool found for ${tokenMeta.symbol}.`, 'ok');
    updateSideLabels();
    await refreshBalances();
    await requote();
  } catch (e) {
    setStatus(explainError(e), 'err');
  } finally { setBusy(false); }
}

function priceOf(key, token, sqrtPriceX96, tokenDec, quoteDec) {
  const Q192 = 2n ** 192n, SCALE = 10n ** 36n;
  const tokenIs0 = lower(key.currency0) === lower(token);
  const dec0 = tokenIs0 ? tokenDec : quoteDec, dec1 = tokenIs0 ? quoteDec : tokenDec;
  let num = sqrtPriceX96 * sqrtPriceX96 * SCALE;
  const d = BigInt(dec0 - dec1);
  num = d >= 0n ? num * 10n ** d : num / 10n ** -d;
  const p = num / Q192;
  return tokenIs0 ? p : p === 0n ? 0n : (SCALE * SCALE) / p;
}

// ---------------------------------------------------------------------------
// balances, quote, swap
// ---------------------------------------------------------------------------
async function refreshBalances() {
  if (!S.account) return;
  const gas = await readClient().getBalance({ address: S.account });
  $('gasBal').textContent = `${fmt(gas, 18, 4)} USDC for gas`;
  if (!S.pool) return;
  const { quote, quoteMeta, tokenMeta } = S.pool;
  const [q, t] = await Promise.all([balanceOf(quote, S.account), balanceOf(S.token, S.account)]);
  S.pool.balances = { quote: q, token: t };
  const inBal = S.side === 'buy' ? `${fmt(q, quoteMeta.decimals, 4)} USDC` : `${fmt(t, tokenMeta.decimals, 4)} ${tokenMeta.symbol}`;
  $('inBal').textContent = `Balance: ${inBal}`;
}

function sideInfo() {
  const { key, quote, tokenMeta, quoteMeta } = S.pool;
  const buying = S.side === 'buy';
  const currencyIn = buying ? quote : S.token, currencyOut = buying ? S.token : quote;
  return { buying, currencyIn, currencyOut, inMeta: buying ? quoteMeta : tokenMeta, outMeta: buying ? tokenMeta : quoteMeta, zeroForOne: lower(currencyIn) === lower(key.currency0) };
}

function updateSideLabels() {
  const sym = S.pool?.tokenMeta.symbol ?? 'TOKEN';
  $('inSym').textContent = S.side === 'buy' ? 'USDC' : sym;
  $('outSym').textContent = S.side === 'buy' ? sym : 'USDC';
  $('swapBtn').textContent = S.side === 'buy' ? `Buy ${sym}` : `Sell ${sym}`;
}

let quoteTimer;
function scheduleQuote() { clearTimeout(quoteTimer); quoteTimer = setTimeout(requote, 350); }

async function requote() {
  S.quote = null; $('swapBtn').disabled = true;
  if (!S.pool || !S.account) return;
  const amt = $('amount').value.trim();
  if (!(Number(amt) > 0)) { $('quoteBox').hidden = true; return; }
  const { currencyIn, inMeta, outMeta, zeroForOne } = sideInfo();
  let amountIn;
  try { amountIn = parseUnits(amt, inMeta.decimals); } catch { setStatus('Invalid amount.', 'err'); return; }
  const slippagePct = Number($('slippage').value || 1);
  try {
    const { result } = await readClient().simulateContract({
      address: ADDR.v4Quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ poolKey: S.pool.key, zeroForOne, exactAmount: amountIn, hookData: hookData() }],
    });
    const amountOut = result[0];
    const minOut = amountOut - (amountOut * BigInt(Math.round(slippagePct * 100))) / 10000n;
    S.quote = { amountIn, amountOut, minOut, currencyIn, zeroForOne };
    $('quoteBox').hidden = false;
    $('quoteOut').textContent = `${fmt(amountOut, outMeta.decimals)} ${outMeta.symbol}`;
    $('quoteMin').textContent = `min ${fmt(minOut, outMeta.decimals)} ${outMeta.symbol} after ${slippagePct}% slippage`;
    const bal = S.pool.balances ? (S.side === 'buy' ? S.pool.balances.quote : S.pool.balances.token) : null;
    if (bal !== null && bal < amountIn) { setStatus(`Not enough ${inMeta.symbol} in your wallet.`, 'err'); return; }
    setStatus('Quote ready.', 'ok');
    $('swapBtn').disabled = S.busy;
  } catch (e) {
    $('quoteBox').hidden = true;
    setStatus(`Quote failed: ${explainError(e)}`, 'err');
  }
}

function hookData() { const v = $('hookData').value.trim(); return v && v !== '0x' ? v : '0x'; }

function encodeSwap({ key, zeroForOne, amountIn, minOut }) {
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]);
  const swapParams = encodeAbiParameters(
    [{ type: 'tuple', components: [...poolKeyAbiParams, { type: 'bool', name: 'zeroForOne' }, { type: 'uint128', name: 'amountIn' }, { type: 'uint128', name: 'amountOutMinimum' }, { type: 'bytes', name: 'hookData' }] }],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: hookData() }],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyIn, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyOut, minOut]);
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swapParams, settle, take]]);
  return { commands: encodePacked(['uint8'], [CMD_V4_SWAP]), inputs: [input] };
}

async function sendAndWait(label, request) {
  setStatus(`${label}: confirm in your wallet…`);
  const hash = await S.walletClient.writeContract(request);
  log(`${label} sent ${txLink(hash)}`);
  setStatus(`${label}: waiting for confirmation…`);
  const r = await S.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} reverted on chain (${short(hash)})`);
  return hash;
}

async function ensureApprovals(currency, amount) {
  if (isNative(currency)) return;
  const owner = S.account;
  const erc20Allowance = await readClient().readContract({ address: currency, abi: erc20Abi, functionName: 'allowance', args: [owner, ADDR.permit2] });
  if (erc20Allowance < amount) {
    await sendAndWait('Approve token', { address: currency, abi: erc20Abi, functionName: 'approve', args: [ADDR.permit2, maxUint256], account: S.account });
  }
  const [p2Amount, p2Exp] = await readClient().readContract({ address: ADDR.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, currency, ADDR.universalRouter] });
  const now = Math.floor(Date.now() / 1000);
  if (p2Amount < amount || p2Exp <= now) {
    await sendAndWait('Approve router', { address: ADDR.permit2, abi: permit2Abi, functionName: 'approve', args: [currency, ADDR.universalRouter, maxUint160, now + 30 * 24 * 3600], account: S.account });
  }
}

async function swap() {
  if (!S.quote || S.busy) return;
  setBusy(true);
  const { inMeta, outMeta } = sideInfo();
  try {
    await ensureArcChain();
    const { amountIn, minOut, currencyIn, zeroForOne } = S.quote;
    await ensureApprovals(currencyIn, amountIn);
    const { commands, inputs } = encodeSwap({ key: S.pool.key, zeroForOne, amountIn, minOut });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
    const value = isNative(currencyIn) ? amountIn : 0n;
    setStatus('Simulating swap…');
    S.lastSwap = { currencyIn, amountIn, minOut, zeroForOne, deadline };
    const { request } = await readClient().simulateContract({
      address: ADDR.universalRouter, abi: universalRouterAbi, functionName: 'execute', args: [commands, inputs, deadline], value, account: S.account,
    });
    const hash = await sendAndWait('Swap', request);
    const after = await balanceOf(S.side === 'buy' ? S.token : S.pool.quote, S.account);
    log(`<b>Swap confirmed</b> ${txLink(hash)} — ${fmt(amountIn, inMeta.decimals)} ${inMeta.symbol} → ≥ ${fmt(minOut, outMeta.decimals)} ${outMeta.symbol}. Balance now ${fmt(after, outMeta.decimals)} ${outMeta.symbol}.`, 'ok');
    setStatus('Swap confirmed.', 'ok');
    $('amount').value = '';
    $('quoteBox').hidden = true; S.quote = null;
    await refreshBalances();
  } catch (e) {
    const msg = explainError(e);
    log(`Swap failed: ${msg}`, 'err');
    setStatus(msg, 'err');
    if (S.lastSwap) diagnose(S.lastSwap).catch((d) => log(`diagnosis failed: ${explainError(d)}`, 'err'));
  } finally { setBusy(false); }
}

// After a failed swap: check every precondition and say which one is off.
async function diagnose({ currencyIn, amountIn, minOut, zeroForOne, deadline }) {
  const c = readClient();
  const { inMeta, outMeta } = sideInfo();
  const lines = [];
  const block = await c.getBlock({ blockTag: 'latest' });
  const skew = Number(deadline) - Number(block.timestamp);
  lines.push(`chain time ${new Date(Number(block.timestamp) * 1000).toISOString().slice(11, 19)} UTC, deadline ${skew >= 0 ? `in ${skew}s` : `PASSED by ${-skew}s — your computer clock is behind the chain`}`);
  const bal = await balanceOf(currencyIn, S.account);
  lines.push(`${inMeta.symbol} balance ${fmt(bal, inMeta.decimals)} vs needed ${fmt(amountIn, inMeta.decimals)} ${bal >= amountIn ? 'ok' : 'INSUFFICIENT'}`);
  if (!isNative(currencyIn)) {
    const a1 = await c.readContract({ address: currencyIn, abi: erc20Abi, functionName: 'allowance', args: [S.account, ADDR.permit2] });
    const [a2, exp] = await c.readContract({ address: ADDR.permit2, abi: permit2Abi, functionName: 'allowance', args: [S.account, currencyIn, ADDR.universalRouter] });
    lines.push(`token→Permit2 allowance ${a1 >= amountIn ? 'ok' : 'MISSING'} (${a1})`);
    lines.push(`Permit2→router allowance ${a2 >= amountIn && Number(exp) > Number(block.timestamp) ? 'ok' : 'MISSING/EXPIRED'} (${a2}, exp ${exp})`);
  }
  if (!isNative(currencyIn)) {
    // Can Permit2 actually pull the tokens for the router? (eth_call impersonating the router / Permit2)
    try {
      await c.simulateContract({ address: currencyIn, abi: parseAbi(['function transferFrom(address from, address to, uint256 amount) returns (bool)']), functionName: 'transferFrom', args: [S.account, ADDR.poolManager, amountIn], account: ADDR.permit2 });
      lines.push(`${inMeta.symbol}.transferFrom by Permit2: ok`);
    } catch (te) { lines.push(`${inMeta.symbol}.transferFrom by Permit2 FAILS: ${explainError(te)}`); }
    try {
      await c.simulateContract({ address: ADDR.permit2, abi: parseAbi(['function transferFrom(address from, address to, uint160 amount, address token)']), functionName: 'transferFrom', args: [S.account, ADDR.poolManager, amountIn, currencyIn], account: ADDR.universalRouter });
      lines.push('Permit2.transferFrom for the router: ok');
    } catch (pe) { lines.push(`Permit2.transferFrom for the router FAILS: ${explainError(pe)}`); }
  }
  try {
    const { result } = await c.simulateContract({ address: ADDR.v4Quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: S.pool.key, zeroForOne, exactAmount: amountIn, hookData: hookData() }] });
    lines.push(`re-quote ${fmt(result[0], outMeta.decimals)} ${outMeta.symbol} (min ${fmt(minOut, outMeta.decimals)}) ${result[0] >= minOut ? 'ok' : 'BELOW MIN — raise slippage'}`);
  } catch (qe) { lines.push(`re-quote FAILED: ${explainError(qe)}`); }
  // same swap with no minimum: isolates slippage from everything else
  try {
    const { commands, inputs } = encodeSwap({ key: S.pool.key, zeroForOne, amountIn, minOut: 0n });
    await c.simulateContract({ address: ADDR.universalRouter, abi: universalRouterAbi, functionName: 'execute', args: [commands, inputs, BigInt(Number(block.timestamp) + 600)], value: isNative(currencyIn) ? amountIn : 0n, account: S.account });
    lines.push('swap with minOut=0 and fresh deadline: OK → the failure is slippage or the deadline');
  } catch (se) { lines.push(`swap with minOut=0 still fails: ${explainError(se)}`); }
  lines.push(`hook ${S.pool.key.hooks} · router ${ADDR.universalRouter} · build ${BUILD}`);
  log(`<b>Diagnosis</b><br>${lines.map((l) => `• ${l}`).join('<br>')}`, 'info');
}

// ---------------------------------------------------------------------------
// wire up
// ---------------------------------------------------------------------------
function init() {
  $('connectBtn').addEventListener('click', () => {
    if (S.account) { S.forcePick = true; try { localStorage.removeItem(WALLET_PREF); } catch {} location.reload(); return; }
    connect();
  });
  $('findBtn').addEventListener('click', findPool);
  $('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') findPool(); });
  $('amount').addEventListener('input', scheduleQuote);
  $('slippage').addEventListener('input', scheduleQuote);
  $('swapBtn').addEventListener('click', swap);
  $('maxBtn').addEventListener('click', () => {
    if (!S.pool?.balances) return;
    const { inMeta } = sideInfo();
    let bal = S.side === 'buy' ? S.pool.balances.quote : S.pool.balances.token;
    if (S.side === 'buy' && S.pool.quoteMeta.native) bal = bal > 10n ** 18n ? bal - 10n ** 18n : 0n; // leave 1 USDC for gas
    $('amount').value = formatUnits(bal, inMeta.decimals);
    scheduleQuote();
  });
  for (const btn of document.querySelectorAll('[data-side]')) {
    btn.addEventListener('click', async () => {
      S.side = btn.dataset.side;
      document.querySelectorAll('[data-side]').forEach((b) => b.classList.toggle('active', b === btn));
      updateSideLabels();
      await refreshBalances();
      scheduleQuote();
    });
  }
  $('advToggle').addEventListener('click', () => { $('adv').hidden = !$('adv').hidden; });
  try { const saved = localStorage.getItem(RPC_PREF); if (saved && !$('rpcUrl').value) $('rpcUrl').value = saved; } catch {}
  const params = new URLSearchParams(location.search);
  if (params.get('token')) $('token').value = params.get('token');
  $('build').textContent = `build ${BUILD}`;
  setStatus('Connect your wallet to start.');
  waitForProvider(3000).then((p) => { if (!p) setStatus(noWalletHelp(), 'err'); });
}
document.addEventListener('DOMContentLoaded', init);
