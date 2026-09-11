// Minimal Arc-like JSON-RPC mock to exercise swap.mjs and swap.html offline.
// Run: node test/mock-rpc.mjs   (listens on :8545, chain id 5042)
import http from 'node:http';
import { encodeAbiParameters, keccak256, toHex, pad, encodeEventTopics, parseAbi, decodeFunctionData, decodeAbiParameters, toFunctionSelector } from 'viem';

const TOKEN = '0x1111111111111111111111111111111111111111';
const USDC = '0x3600000000000000000000000000000000000000';
const HOOK = '0x2222222222222222222222222222222222222222';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
const ROUTER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const LATEST = 2_050_000n;
const INIT_BLOCK = 2_040_123n;

const key = { currency0: TOKEN, currency1: USDC, fee: 10000, tickSpacing: 200, hooks: HOOK };
const poolKeyParams = [{ type: 'tuple', components: [
  { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] }];
const poolId = keccak256(encodeAbiParameters(poolKeyParams, [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));

const initEvent = parseAbi(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)']);
const sqrtPriceX96 = 79228162514264337593543950336n / 1000n; // price ≈ 1e-6 currency1 per currency0 (raw)

const sel = (sig) => toFunctionSelector(sig);
const S = {
  decimals: sel('function decimals()'), symbol: sel('function symbol()'), balanceOf: sel('function balanceOf(address)'), totalSupply: sel('function totalSupply()'),
  allowance: sel('function allowance(address,address)'), p2allowance: sel('function allowance(address,address,address)'),
  getSlot0: sel('function getSlot0(bytes32)'), getLiquidity: sel('function getLiquidity(bytes32)'),
  quote: sel('function quoteExactInputSingle((( address,address,uint24,int24,address),bool,uint128,bytes))'.replace('(( ', '((')),
  execute: sel('function execute(bytes,bytes[],uint256)'),
};
const enc = (types, vals) => encodeAbiParameters(types.map((t) => ({ type: t })), vals);
const str = (s) => enc(['string'], [s]);

let seenExecute = null; let txCounter = 0; const sentTxs = []; const zero = '0x0000000000000000000000000000000000000000';
function ethCall({ to, data, value }) {
  to = to.toLowerCase(); const s = data.slice(0, 10);
  if (to === TOKEN || to === USDC) {
    if (s === S.decimals) return enc(['uint8'], [to === USDC ? 6 : 18]);
    if (s === S.symbol) return str(to === USDC ? 'USDC' : 'MEME');
    if (s === S.balanceOf) return enc(['uint256'], [10n ** 30n]);
    if (s === S.totalSupply) return enc(['uint256'], [to === USDC ? 10n ** 15n : 10n ** 9n * 10n ** 18n]);
    if (s === S.allowance) return enc(['uint256'], [0n]);
  }
  if (to === PERMIT2 && s === S.p2allowance) return enc(['uint160', 'uint48', 'uint48'], [0n, 0, 0]);
  if (to === STATE_VIEW) {
    const id = data.slice(10, 74);
    if (id !== poolId.slice(2)) throw new Error('unknown poolId ' + id);
    if (s === S.getSlot0) return enc(['uint160', 'int24', 'uint24', 'uint24'], [sqrtPriceX96, -138163, 0, 10000]);
    if (s === S.getLiquidity) return enc(['uint128'], [10n ** 24n]);
  }
  if (to === QUOTER && s === S.quote) {
    const [p] = decodeAbiParameters([{ type: 'tuple', components: [
      { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] },
      { type: 'bool' }, { type: 'uint128' }, { type: 'bytes' }] }], '0x' + data.slice(10));
    if (p[0][4].toLowerCase() !== HOOK) throw new Error('quoter got wrong hook');
    // pretend 1 USDC (1e6) buys 1000 MEME (1e21): amountOut = amountIn * 1e15
    return enc(['uint256', 'uint256'], [p[2] * 10n ** 15n, 150000n]);
  }
  if (to === ROUTER && s === S.execute) { seenExecute = { data, value }; return '0x'; }
  throw new Error(`unhandled call to=${to} sel=${s}`);
}

const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const reqs = JSON.parse(body); const batch = Array.isArray(reqs); const out = (batch ? reqs : [reqs]).map((r) => {
      try { return { jsonrpc: '2.0', id: r.id, result: handle(r) }; }
      catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: e.message } }; }
    });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(batch ? out : out[0]));
  });
});
function handle({ method, params }) {
  switch (method) {
    case 'eth_chainId': return '0x13b2';
    case 'eth_blockNumber': return toHex(LATEST);
    case 'eth_getBalance': return toHex(5n * 10n ** 18n);
    case 'eth_call': return ethCall(params[0]);
    case 'eth_estimateGas': return '0x30000';
    case 'eth_gasPrice': return '0x4a817c800';
    case 'eth_maxPriorityFeePerGas': return '0x0';
    case 'eth_getTransactionCount': return '0x1';
    case 'eth_sendTransaction': case 'eth_sendRawTransaction': {
      const h = '0x' + (++txCounter).toString(16).padStart(64, '0'); sentTxs.push({ hash: h, tx: params[0] }); return h;
    }
    case 'eth_getTransactionReceipt': {
      const h = params[0]; if (!sentTxs.find((t) => t.hash === h)) return null;
      return { transactionHash: h, blockNumber: toHex(LATEST), blockHash: pad('0xcd'), transactionIndex: '0x0', status: '0x1',
        gasUsed: '0x2a000', cumulativeGasUsed: '0x2a000', effectiveGasPrice: '0x4a817c800', logs: [], logsBloom: '0x' + '0'.repeat(512), type: '0x2', from: (sentTxs.find((t) => t.hash === h).tx.from ?? zero), to: ROUTER, contractAddress: null };
    }
    case 'eth_getBlockByNumber': return { number: toHex(LATEST), hash: pad('0xcd'), parentHash: pad('0xcc'), timestamp: toHex(Math.floor(Date.now() / 1000)), baseFeePerGas: '0x4a817c800', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], miner: zero, nonce: '0x0000000000000000', difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', logsBloom: '0x' + '0'.repeat(512), sha3Uncles: pad('0x00'), stateRoot: pad('0x00'), receiptsRoot: pad('0x00'), transactionsRoot: pad('0x00'), size: '0x0', uncles: [], mixHash: pad('0x00') };
    case 'eth_getLogs': {
      const f = params[0]; const from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
      if (f.address.toLowerCase() !== POOL_MANAGER) return [];
      if (INIT_BLOCK < from || INIT_BLOCK > to) return [];
      const topics = encodeEventTopics({ abi: initEvent, eventName: 'Initialize', args: { id: poolId, currency0: TOKEN, currency1: USDC } });
      const want = f.topics; // [sig, null?, c0, c1]
      if (want[2] && want[2].toLowerCase() !== topics[2].toLowerCase()) return [];
      if (want[3] && want[3].toLowerCase() !== topics[3].toLowerCase()) return [];
      return [{ address: POOL_MANAGER, topics, data: enc(['uint24', 'int24', 'address', 'uint160', 'int24'], [key.fee, key.tickSpacing, key.hooks, sqrtPriceX96, -138163]),
        blockNumber: toHex(INIT_BLOCK), transactionHash: pad('0xab'), transactionIndex: '0x0', blockHash: pad('0xcd'), logIndex: '0x0', removed: false }];
    }
    default: throw new Error('unsupported ' + method);
  }
}
server.listen(8545, () => console.log('mock rpc on :8545, poolId', poolId));
