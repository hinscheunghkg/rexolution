// Encoder for o1's router on Arc (0xa130577E…), reverse-engineered from three
// successful transactions (two sells, one buy). The router takes one `bytes`
// argument (selector 0x08c1284c) in a compact custom format:
//
//   nTokens(1) | token addresses (20 each)          token table, referenced by index
//   input header: buy (native in) 00 00 01 | sell (ERC-20 in) 01 00 00 01
//   amountLen(1) | amount (big-endian, minimal)     exact input amount
//   00 00
//   feeRecipient(20) | feeBps(3)                    o1's 1% fee
//   nSplits(1) | [splitRecipient(20) | shareBps(3)] creator share of that fee
//   00 01 00 0b 00 01 2d                            constants in every sample
//   nOps(1) | ops…                                  buy: 3 ops (wrap, swap, pay)
//                                                   sell: 2 ops (swap, unwrap+pay)
//   swap op carries fee(3) | tickSpacing(3) | hooks(20) of the v4 pool
//
// Token table order: buy = [native USDC, token, USDC ERC-20]; sell = [token, native USDC, USDC ERC-20].
// No recipient, deadline or minimum-out field exists in the samples; the router pays msg.sender.

const SELECTOR = '08c1284c';
const NATIVE = '0000000000000000000000000000000000000000';
const USDC_ERC20 = '3600000000000000000000000000000000000000';
const CONST_HDR = '0001000b00012d';
export const O1_FEE = { recipient: 'b25750fa55b302c9a3997f64d24c0b14afdd3165', bps: 100 };

const hex = (s) => s.toLowerCase().replace(/^0x/, '');
const u = (n, bytes) => n.toString(16).padStart(bytes * 2, '0');
function amount(n) {
  let h = n.toString(16); if (h.length % 2) h = '0' + h;
  return u(h.length / 2, 1) + h;
}
function fees({ splits = [] } = {}) {
  let out = hex(O1_FEE.recipient) + u(O1_FEE.bps, 3) + u(splits.length, 1);
  for (const s of splits) out += hex(s.recipient) + u(s.shareBps, 3);
  return out;
}
function poolBytes({ fee = 0, tickSpacing, hooks }) {
  const ts = ((tickSpacing & 0xffffff) >>> 0); // int24 two's complement
  return u(fee, 3) + u(ts, 3) + hex(hooks);
}

/** Buy `token` with `amountIn` native USDC (18-decimal wei). */
export function encodeBuyPayload({ token, amountIn, pool, splits }) {
  return '03' + NATIVE + hex(token) + USDC_ERC20
    + '000001' + amount(amountIn) + '0000'
    + fees({ splits })
    + CONST_HDR + '03'
    + '010002'                       // op: wrap native USDC (t0) → USDC ERC-20 (t2)
    + '02050201' + poolBytes(pool)   // op: v4 swap t2 → t1 on the launch pool
    + '00'
    + '00050003100201040102';        // op: pay out
}

/** Sell `amountIn` of `token` (token wei) for native USDC. Needs token allowance to the router's transfer proxy. */
export function encodeSellPayload({ token, amountIn, pool, splits }) {
  return '03' + hex(token) + NATIVE + USDC_ERC20
    + '01000001' + amount(amountIn) + '0000'
    + fees({ splits })
    + CONST_HDR + '02'
    + '01050002' + poolBytes(pool)   // op: v4 swap t0 → t2 on the launch pool
    + '0001'
    + '020101050211000100030102';    // op: unwrap USDC ERC-20 → native, pay out
}

/** Full calldata: selector + ABI-encoded single `bytes` argument. */
export function encodeCalldata(payloadHex) {
  const len = payloadHex.length / 2;
  const padded = payloadHex + '00'.repeat((32 - (len % 32)) % 32);
  return '0x' + SELECTOR + u(32, 32) + u(len, 32) + padded;
}
