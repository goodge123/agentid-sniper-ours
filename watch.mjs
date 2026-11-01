// AgentID Sniper
// Agent ID 专属铸造监控/自动铸造工具：
// 逐块扫 BSC 发现项目 -> 免费实测可打才自动打（合约审核门把关）-> 收费只出分析等确认。
// 持仓自动止盈：3 倍卖出回本+50% 利润，从高点回落 40% 全卖（用户 2026-11-01 定）。
// 执行统一走币安 Agentic Wallet（baw），本程序不碰私钥。
import { execFile } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const SELFTEST = process.argv.includes('--selftest');
let CONFIG;
try { CONFIG = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8')); }
catch (e) { if (!SELFTEST) throw e; CONFIG = { wallets: [], paid: {}, timeZone: 'Asia/Shanghai' }; }
// 叙事 AI 配置可单独放 narrative.env（AI_API_KEY/AI_BASE_URL/AI_MODEL），部署覆盖 config.json 时不丢
try {
  if (!CONFIG.narrative?.apiKey && existsSync(join(DIR, 'narrative.env'))) {
    const kv = {};
    for (const line of readFileSync(join(DIR, 'narrative.env'), 'utf8').split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    if (kv.AI_API_KEY) CONFIG.narrative = { apiKey: kv.AI_API_KEY, baseUrl: kv.AI_BASE_URL || 'https://api.siliconflow.cn/v1', model: kv.AI_MODEL || 'Qwen/Qwen2.5-7B-Instruct' };
  }
} catch {}
// 专属 RPC 可单独放 rpcs.env（一行一个地址）：只存服务器、不进 git，部署覆盖 config.json 时不丢
let PAID_RPCS = Array.isArray(CONFIG.rpcs) ? CONFIG.rpcs.filter(Boolean) : [];
try {
  if (!PAID_RPCS.length && existsSync(join(DIR, 'rpcs.env'))) PAID_RPCS = readFileSync(join(DIR, 'rpcs.env'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s.startsWith('http'));
} catch {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const LC = (a) => String(a || '').toLowerCase();

// 行为口径（改行为只改这里）
const OUR = {
  freeOnly: true,      // 只打 value=0 的真免费
  audit: true,         // 合约审核门（A 档：硬红旗拦、软提示/未验证标注放行）
  paidMaxUsd: Math.min(Number(CONFIG.paid?.maxUsd) || 10, 10), // 收费每钱包每项目上限（U）
  paidDailyBnbCap: Number(CONFIG.paid?.maxBnbPerDay ?? 0.1),   // 收费兜底日上限（BNB）
  dailyMintCap: 100,   // 免费每个钱包每天自动打上限
  gasCap: 600000n,     // gas 估算超过这个数拦截报告
  goPct: 0.6,          // 进场进度门槛
  crowdGo: 100,        // 读不到进度时，要多少个 Agent ID 钱包在打才进场
  tpX: 3,              // 自动止盈触发倍数
  tpProfit: 0.5,       // 到 tpX 时卖出「成本×(1+tpProfit)」对应的量（3 倍时 = 卖 50%）
  tpCrash: 0.4,        // 从高点回落 40% 全卖（高点须 ≥2 倍，连续 2 次确认）
};

// 链上常量（BSC）
const REGISTRY_CODE = '60b9262456de011f7d15a54cdd8c48baaa8b022f'; // Agent ID 登记合约，出现在合约代码里 = Agent ID 专属
const REGISTRY = '0x' + REGISTRY_CODE;
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const PANCAKE_FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';

// ---------- 状态（单文件 JSON，防写坏：临时文件 + 改名） ----------
mkdirSync(join(DIR, 'data'), { recursive: true });
const STATE_FILE = join(DIR, 'data', 'state.json');
function parseState(txt) { try { const o = JSON.parse(txt); return o && typeof o === 'object' ? o : null; } catch { return null; } }
let S = existsSync(STATE_FILE) ? parseState(readFileSync(STATE_FILE, 'utf8')) : null;
if (!S) {
  // 主文件损坏：原件改名留证，尝试用 .bak 恢复
  try { if (existsSync(STATE_FILE)) renameSync(STATE_FILE, STATE_FILE + '.corrupt-' + Date.now()); } catch {}
  S = (existsSync(STATE_FILE + '.bak') ? parseState(readFileSync(STATE_FILE + '.bak', 'utf8')) : null) || {};
  if (Object.keys(S).length) console.error('state.json 损坏，已从 state.json.bak 恢复');
}
S.track = S.track || {};       // 追踪中的合约： addr -> {name, at, agents, progress, done:{wallet:status}, kind, ...}
for (const P of Object.values(S.track)) if (P.links && P.links.v !== 3) delete P.links; // 一次性清理旧版提取的垃圾链接（库文件参考链接冒充官网）
S.hold = S.hold || [];         // 持仓： {sym, addr, cost(USD), only, openPx, flags:{}}
S.black = S.black || {};       // 部署者黑名单： addr -> {why, at}
S.mintCnt = S.mintCnt || {};   // 每日免费打计数
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const t = STATE_FILE + '.tmp';
      writeFileSync(t, JSON.stringify(S));
      try { if (existsSync(STATE_FILE) && parseState(readFileSync(STATE_FILE, 'utf8'))) copyFileSync(STATE_FILE, STATE_FILE + '.bak'); } catch {}
      renameSync(t, STATE_FILE);
    } catch {}
  }, 800);
}
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: CONFIG.timeZone || 'Asia/Shanghai', hour12: false })}] ${msg}`;
  console.log(line);
}

// 单实例锁：已有同目录实例在跑就退出（防双开重复打）
const LOCK_FILE = join(DIR, 'data', 'lock');
if (!SELFTEST) try {
  if (existsSync(LOCK_FILE)) {
    const pid = Number(readFileSync(LOCK_FILE, 'utf8'));
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); console.error('已有实例在跑 pid=' + pid); process.exit(1); } catch {} }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
} catch {}

// ---------- RPC：公共节点优先，限流/全失败时切专属节点顶上，公共恢复自动切回（用户 16:20 口径）；专属按估算 CU 用量，单 key 到 90% 自动换下一个；坏节点短暂冷却 ----------
const PUBLIC_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc.publicnode.com',
  'https://bsc.drpc.org',
];
const CU_CAP = 9_000_000; // 每 key 总额度 1000 万 CU，估算用量到 90% 即切换（用户 16:12 口径）
const CU_W = { eth_blockNumber: 5, eth_getBlockByNumber: 20, eth_call: 26, eth_getCode: 15, eth_getBalance: 15, eth_estimateGas: 26, eth_getLogs: 75, eth_getTransactionReceipt: 15, eth_getTransactionByHash: 15 };
const cuWeight = (m) => CU_W[m] || 20; // NodeReal CU 单价为估算口径，够用于切换决策
const RPC_USAGE_FILE = join(DIR, 'rpc-usage.json'); // 放在程序目录（非 data/），部署清 state 时不重置
let rpcUse = {};
try { rpcUse = JSON.parse(readFileSync(RPC_USAGE_FILE, 'utf8')); } catch {}
let rpcCallsSinceSave = 0;
function saveRpcUse() { try { writeFileSync(RPC_USAGE_FILE, JSON.stringify(rpcUse)); } catch {} }
const rpcExhausted = (u) => (rpcUse[u] || 0) >= CU_CAP;
const rpcPools = () => { const paid = PAID_RPCS.filter((u) => !rpcExhausted(u)); return paid.length ? [PUBLIC_RPCS, paid] : [PUBLIC_RPCS]; }; // 公共在前，专属只作限流时的备用池
function addRpcUse(u, method) {
  if (!PAID_RPCS.includes(u)) return;
  const before = rpcUse[u] || 0;
  rpcUse[u] = before + cuWeight(method);
  if (before < CU_CAP && rpcUse[u] >= CU_CAP) { saveRpcUse(); log(`专属 RPC 第 ${PAID_RPCS.indexOf(u) + 1} 个 key 估算用量已达 90%（约 ${Math.round(rpcUse[u] / 10000)} 万 CU），自动切换下一个`); }
  else if (++rpcCallsSinceSave >= 100) { rpcCallsSinceSave = 0; saveRpcUse(); }
}
if (PAID_RPCS.length) log(`RPC：公共节点优先，限流时切专属节点 ${PAID_RPCS.length} 个顶上（单 key 估算到 90% 自动换下一个，公共恢复自动切回）`);
let riUrl = '';
const rpcBad = new Map();
const rpcFailN = new Map();
async function tryPool(pool, method, params, forceOne = true) {
  let last = null;
  const start = Math.max(0, pool.indexOf(riUrl));
  const order = pool.map((_, i) => pool[(start + i) % pool.length]);
  const avail = order.filter((u) => (rpcBad.get(u) || 0) <= now());
  if (!avail.length && !forceOne) throw new Error('pool cooling'); // 后面还有备用池时，不硬敲全在冷却（限流中）的池，直接换池
  // 最后一个池全在冷却时也至少试最早解禁的一个，绝不整批放弃（否则一波限流就永久假死）
  const tryList = avail.length ? avail : [order.reduce((a, b) => ((rpcBad.get(a) || 0) <= (rpcBad.get(b) || 0) ? a : b))];
  for (const u of tryList) {
    try {
      const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      rpcBad.delete(u); rpcFailN.delete(u);
      riUrl = u;
      addRpcUse(u, method);
      return j.result;
    } catch (e) {
      last = e;
      const n = (rpcFailN.get(u) || 0) + 1;
      if (n >= 2) { rpcBad.set(u, now() + 10000); rpcFailN.set(u, 0); } else rpcFailN.set(u, n);
    }
  }
  throw last || new Error('all rpc down');
}
async function rpc(method, params) {
  const pools = rpcPools();
  let last = null;
  for (let i = 0; i < pools.length; i++) {
    try { return await tryPool(pools[i], method, params, i === pools.length - 1); }
    catch (e) { last = e; } // 公共池限流/失败 → 下一个池（专属）顶上；下次调用又从公共池开始，恢复即切回
  }
  throw last || new Error('all rpc down');
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
const big = (h) => (h && h !== '0x' && h.length >= 66 ? BigInt(h.slice(0, 66)) : 0n);
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const wa = (a) => LC(a).replace(/^0x/, '').padStart(64, '0');
const wordAddr = (h, i = 0) => '0x' + String(h).slice(2 + i * 64).slice(24, 64).toLowerCase();

// ---------- 合约代码与代理解析 ----------
const codeCache = new Map();
async function codeOf(a) {
  a = LC(a);
  if (!codeCache.has(a)) codeCache.set(a, ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase());
  return codeCache.get(a);
}
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
async function implOf(a) {
  // EIP-1967 直接实现 / 信标实现 / 1167 最小代理，三种常见代理都追到逻辑合约
  a = LC(a);
  try {
    const s = await rpc('eth_getStorageAt', [a, IMPL_SLOT, 'latest']).catch(() => null);
    let impl = s && s.length >= 66 ? wordAddr(s) : '';
    if (!impl || impl === ZERO) {
      const b = await rpc('eth_getStorageAt', [a, BEACON_SLOT, 'latest']).catch(() => null);
      const beacon = b && b.length >= 66 ? wordAddr(b) : '';
      if (beacon && beacon !== ZERO) { const r = await call(beacon, '0x5c60da1b'); if (r && r.length >= 66) impl = wordAddr(r); }
    }
    if (impl && impl !== ZERO && impl !== a) return impl;
  } catch {}
  const code = await codeOf(a);
  const m = code.match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
  if (m) return '0x' + m[1];
  return '';
}
async function logicCode(a) {
  const impl = await implOf(a).catch(() => '');
  return impl ? codeOf(impl) : codeOf(a);
}
async function logicAddr(a) {
  const impl = await implOf(a).catch(() => '');
  return impl || LC(a);
}

// ---------- Agent ID：登记合约是 ERC721，用 tokenOfOwnerByIndex 取自己的编号 ----------
const agentIdCache = new Map();
async function agentIdOf(addr) {
  addr = LC(addr);
  if (agentIdCache.has(addr)) return agentIdCache.get(addr);
  let id = null;
  const bal = big(await call(REGISTRY, '0x70a08231' + wa(addr)));
  if (bal > 0n) { const r = await call(REGISTRY, '0x2f745c59' + wa(addr) + w(0)); if (r && r.length >= 66) id = BigInt(r.slice(0, 66)); }
  agentIdCache.set(addr, id);
  return id;
}
async function isAgentWallet(addr) {
  // 是不是持 .ai Agent ID 的钱包（热度计数用，带缓存）
  addr = LC(addr);
  if (agentIdCache.has(addr + ':has')) return agentIdCache.get(addr + ':has');
  const bal = big(await call(REGISTRY, '0x70a08231' + wa(addr)));
  const has = bal > 0n;
  agentIdCache.set(addr + ':has', has);
  return has;
}

// ---------- baw（币安 Agentic Wallet CLI）：所有交易都经它预演+执行 ----------
function parseJsonOut(t) { let j = null; try { j = JSON.parse(t.slice(t.indexOf('{'))); } catch {} return j; }
function makeBaw() {
  return (args, timeout = 180000) => new Promise((res) => {
    execFile('baw', [...args, '--json'], { timeout, maxBuffer: 4 << 20, windowsHide: true }, (e, so, se) => {
      const t = String(so || se || e?.message || '');
      res({ t, j: parseJsonOut(t) });
    });
  });
}
const WALLETS = (CONFIG.wallets || []).map((wc) => ({ name: wc.name, addr: LC(wc.address), baw: makeBaw() }));
if (!WALLETS.length && !SELFTEST) { console.error('config.json 里没有 wallets'); process.exit(1); }
const ME = WALLETS[0];

// ---------- 价格：BNB/USD 读 Pancake 主池储备 ----------
async function bnbUsd() {
  const p = await call(PANCAKE_FACTORY, '0xe6a43905' + wa(WBNB) + wa(USDT));
  const pair = p ? wordAddr(p) : '';
  if (!pair || pair === ZERO) return 0;
  const r = await call(pair, '0x0902f1ac');
  const t0 = await call(pair, '0x0dfe1681');
  if (!r || !t0 || r.length < 130) return 0;
  const a = BigInt(r.slice(0, 66)), b = BigInt('0x' + r.slice(66, 130));
  if (!a || !b) return 0;
  return wordAddr(t0) === WBNB ? Number(b) / Number(a) : Number(a) / Number(b);
}

// ---------- 通知：TG 原生 + 可选 QQ 双推（脚本由 config.qqPushScript 指定） ----------
const TG = CONFIG.telegram?.botToken && CONFIG.telegram?.chatId ? { token: CONFIG.telegram.botToken, chat: CONFIG.telegram.chatId, group: CONFIG.telegram.groupChatId || '' } : null;
const qqLast = new Map();
function qqBridge(text) {
  const script = CONFIG.qqPushScript;
  if (!script) return;
  if (!/^(🆓|🛒|🚀|💰|⚠️|🔔|🛡)/u.test(text)) return;
  const t = now();
  if (qqLast.get(text) && t - qqLast.get(text) < 3600e3) return;
  qqLast.set(text, t);
  try {
    const f = join(DIR, 'data', 'qq_last.txt');
    writeFileSync(f, text);
    execFile('bash', [script, f], { timeout: 30000 }, () => {});
  } catch {}
}
function tgApi(method, payload, timeoutMs = 10000) {
  // Telegram 专用请求：强制 IPv4（服务器上 Node fetch 走 IPv6 会超时，curl/https 不受影响）
  return new Promise((resolve) => {
    if (!TG) return resolve(null);
    const body = JSON.stringify(payload || {});
    const req = httpsRequest(`https://api.telegram.org/bot${TG.token}/${method}`, { method: 'POST', family: 4, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}
async function tg(text, toGroup = false) {
  // 返回是否确认送达（TG 未配置或接口报错 = 未送达）；普通调用方不看返回值
  log('TG: ' + text.replace(/\n/g, ' | '));
  qqBridge(text);
  if (!TG) return false;
  const chat = toGroup && TG.group ? TG.group : TG.chat;
  const j = await tgApi('sendMessage', { chat_id: chat, text, disable_web_page_preview: true });
  return !!(j && j.ok);
}

// ---------- 基础读数：名字、关联代币、进度、是否开池 ----------
function tokStr(r) {
  try { const h = String(r).slice(2); const len = Number(BigInt('0x' + h.slice(64, 128))); return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return ''; }
}
async function nameOf(c) {
  const n = tokStr(await call(c, '0x06fdde03'));
  if (n) return n;
  const tk = await tokenOf(c).catch(() => '');
  if (tk && tk !== LC(c)) { const n2 = tokStr(await call(tk, '0x06fdde03')); if (n2) return n2; }
  return '';
}
async function tokenOf(c) {
  // 有些铸造合约是金库/销售合约，真正的代币在另一个地址（getter 0xfc0c546a）
  const r = await call(c, '0xfc0c546a');
  if (r && r.length >= 66) { const a = wordAddr(r); if (a && a !== ZERO) return a; }
  return LC(c);
}
const CAP_SELS = ['d5abeb01', '32cb6b0c', '355274ea', 'e985e367', 'f1aee5a2', '0f2cdd6c', 'a035b1fe', 'a0e23ebd'];
const SOLD_SELS = ['a2309ff8'];
const progCache = new Map();
async function readProgress(c) {
  const hit = progCache.get(c);
  if (hit && now() - hit.t < 30000) return hit.p;
  let p = null;
  try {
    const decR = await call(c, '0x313ce567');
    const dec = decR && decR.length >= 66 ? Number(BigInt(decR.slice(0, 66))) : -1;
    const isErc20 = dec > 0 && dec <= 36; // ERC20 常一开始就全发，用已发/总量会误判 100%，不适用
    if (!isErc20) {
      const sup = Number(big(await call(c, '0x18160ddd')));
      if (sup > 0) for (const s of CAP_SELS) { const x = Number(big(await call(c, '0x' + s))); if (x >= sup && x < 1e15) { p = sup / x; break; } }
    }
    if (p == null) for (const s of SOLD_SELS) {
      const sold = Number(big(await call(c, '0x' + s)));
      if (sold > 0) for (const cs of CAP_SELS) { const cap = Number(big(await call(c, '0x' + cs))); if (cap >= sold && cap > 0 && cap < 1e15) { p = sold / cap; break; } }
      if (p != null) break;
    }
  } catch {}
  progCache.set(c, { t: now(), p });
  return p;
}
async function readSoldCap(c) {
  // 给付费分析用：尽量读出已售/总量原数
  let sold = null, cap = null;
  const sup = Number(big(await call(c, '0x18160ddd')));
  for (const s of CAP_SELS) { const x = Number(big(await call(c, '0x' + s))); if (x > 0 && x < 1e15 && (cap == null || x < cap)) cap = x; }
  if (sup > 0 && cap != null && sup <= cap) sold = sup;
  if (sold == null) for (const s of SOLD_SELS) { const x = Number(big(await call(c, '0x' + s))); if (x > 0) { sold = x; break; } }
  return { sold, cap };
}
async function poolOpen(token) {
  token = LC(token);
  try {
    for (const q of [WBNB, USDT]) {
      const p = await call(PANCAKE_FACTORY, '0xe6a43905' + wa(token) + wa(q));
      const pair = p ? wordAddr(p) : '';
      if (pair && pair !== ZERO) { const r = await call(pair, '0x0902f1ac'); if (r && r.length >= 130 && (BigInt(r.slice(0, 66)) > 0n || BigInt('0x' + r.slice(66, 130)) > 0n)) return true; }
    }
  } catch {}
  try {
    const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + token, { signal: AbortSignal.timeout(8000) })).json();
    return (j.pairs || []).some((x) => x.chainId === 'bsc' && (x.liquidity?.usd || 0) > 50);
  } catch { return false; }
}

// ---------- 免费探测：候选函数表逐个用自己钱包 eth_call 试（金额 0） ----------
const BAD_SEL = new Set(['0xa9059cbb', '0x095ea7b3', '0x23b872dd', '0x42842e0e', '0xb88d4fde', '0xa22cb465']);
const PROBES = [
  ['mint()', '0x1249c58b', 'none'],
  ['mint(uint256)', '0xa0712d68', 'one'],
  ['mint(uint256)#id', '0xa0712d68', 'agentid'],
  ['mint(address)', '0x6a627842', 'self'],
  ['mint(address,uint256)', '0x40c10f19', 'selfOne'],
  ['claim()', '0x4e71d92d', 'none'],
  ['claim(uint256)#id', '0x379607f5', 'agentid'],
  ['claim(uint256)', '0x379607f5', 'one'],
];
async function probeData(W, kind) {
  if (kind === 'none') return '';
  if (kind === 'one') return w(1);
  if (kind === 'self') return wa(W.addr);
  if (kind === 'selfOne') return wa(W.addr) + w(1);
  if (kind === 'agentid') { const id = await agentIdOf(W.addr); return id == null ? null : w(id); }
  return '';
}
async function findFree(W, c) {
  const code = await logicCode(c);
  for (const [label, sel, kind] of PROBES) {
    if (!code.includes(sel.slice(2))) continue;
    const args = await probeData(W, kind);
    if (args == null) continue;
    const data = sel + args;
    try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x0' }, 'latest']); return { data, label }; } catch {}
  }
  // 照抄学习：别人（Agent ID 钱包）成功打过的 calldata，换成自己的地址/编号再试
  for (const d0 of S.learned?.[c] || []) {
    const d = await sanitizeLearned(W, d0);
    if (!d) continue;
    try { await rpc('eth_call', [{ from: W.addr, to: c, data: d, value: '0x0' }, 'latest']); return { data: d, label: '照抄学习' }; } catch {}
  }
  return null;
}
async function sanitizeLearned(W, d) {
  if (!d || d.length < 10 || BAD_SEL.has(d.slice(0, 10).toLowerCase())) return null;
  const src = d.slice(10).match(/.{64}/g) || [];
  const myId = await agentIdOf(W.addr);
  const out = [];
  for (const word of src) {
    // 别人的地址换成自己的；无法识别的数字原样保留（金额类在 value=0 探测时会自然失败或被后续模拟拦）
    if (word.slice(0, 24) === '000000000000000000000000' && word.slice(24) !== '0'.repeat(40)) out.push(wa(W.addr));
    else out.push(word);
  }
  void myId;
  return d.slice(0, 10) + out.join('');
}

// ---------- 发现：逐块扫新部署合约 + 热度（同一合约被多个 Agent ID 钱包调用） ----------
const heat = new Map(); // addr -> Map(sender -> lastTs)
function noteHeat(c, sender) {
  if (!heat.has(c)) heat.set(c, new Map());
  const m = heat.get(c);
  m.set(sender, now());
  for (const [s, t] of m) if (now() - t > 600e3) m.delete(s);
  return m.size;
}
async function isAgentContract(c) {
  const code = await logicCode(c).catch(() => '');
  return code.includes(REGISTRY_CODE) || code.includes('9f92d0dd');
}
async function trackNew(c, deployer, why) {
  c = LC(c);
  if (S.track[c]) { if (deployer && !S.track[c].deployer) S.track[c].deployer = LC(deployer); return; }
  const name = await nameOf(c).catch(() => '');
  S.track[c] = { at: now(), name, deployer: deployer ? LC(deployer) : '', done: {}, agents: 0, why };
  S.devProjects = S.devProjects || {};
  if (deployer) { const d = LC(deployer); S.devProjects[d] = S.devProjects[d] || []; if (!S.devProjects[d].includes(c)) S.devProjects[d].push(c); }
  save();
  log(`发现 Agent ID 合约 ${name || ''} ${c}（${why}）`);
  // 发现即初筛：免费可打就排队（执行链自己还会过时机/审核/模拟关）
  for (const W of WALLETS) {
    const ff = await findFree(W, c).catch(() => null);
    if (ff) queueMint(c, ff, W);
  }
  const tk = await tokenOf(c).catch(() => c);
  void tk;
}
const checkedCode = new Set();
async function scanBlocks(from, to) {
  const failed = [];
  for (let b = from; b <= to; b++) {
    const blk = await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), true]).catch(() => null);
    if (!blk) { failed.push(b); continue; }
    for (const tx of blk.transactions || []) {
      try {
        const to = tx.to ? LC(tx.to) : '';
        const fromA = LC(tx.from);
        if (!to) {
          const rc = await rpc('eth_getTransactionReceipt', [tx.hash]).catch(() => null);
          if (!rc) { if (!failed.includes(b)) failed.push(b); continue; }
          const ca = rc?.contractAddress ? LC(rc.contractAddress) : '';
          if (ca && !S.track[ca] && !checkedCode.has(ca)) { checkedCode.add(ca); if (await isAgentContract(ca)) await trackNew(ca, fromA, '新部署'); }
          continue;
        }
        // 热度：同一合约短时间内被多个不同钱包调用，先粗筛再验身份与代码
        if (!S.track[to] && !checkedCode.has(to)) {
          const n = noteHeat(to, fromA);
          if (n >= 3) {
            checkedCode.add(to);
            bgJob(async () => {
              // 叫过的钱包里有 Agent ID 钱包、且合约代码含登记合约，才算数
              let agents = 0;
              for (const s of heat.get(to)?.keys() || []) { if (await isAgentWallet(s).catch(() => false)) agents++; }
              if (agents >= 2 && await isAgentContract(to)) await trackNew(to, '', '热度发现');
            });
          }
        }
        // 学习：已追踪合约被 Agent ID 钱包成功调用的 calldata 记下来（回滚的不记要靠回执，简化为只记已打包交易）
        if (S.track[to] && tx.input && tx.input.length >= 10 && !BAD_SEL.has(tx.input.slice(0, 10).toLowerCase())) {
          bgJob(async () => {
            if (!(await isAgentWallet(fromA).catch(() => false))) return;
            S.learned = S.learned || {};
            S.learned[to] = S.learned[to] || [];
            if (!S.learned[to].includes(tx.input)) { S.learned[to].push(tx.input); if (S.learned[to].length > 4) S.learned[to].shift(); save(); }
            // 参与计数（去重钱包）
            const P = S.track[to];
            P.agentSet = P.agentSet || {};
            if (!P.agentSet[fromA]) { P.agentSet[fromA] = 1; P.agents = Object.keys(P.agentSet).length; P.agentBlocks = P.agentBlocks || {}; P.agentBlocks[b] = (P.agentBlocks[b] || 0) + 1; save(); }
          });
        }
      } catch {}
    }
  }
  return failed;
}
const bgJobs = new Set();
function bgJob(fn) { const p = Promise.resolve().then(fn).catch(() => {}); bgJobs.add(p); p.finally(() => bgJobs.delete(p)); }

// ---------- 合约审核门（A 档）+ 权限提醒 ----------
// 静态源码审：拉 Sourcify 已验证源码扫红旗；动态风险（隐藏收费/额外转账）靠 baw 预览模拟兜底。
const auditCache = new Map();
async function sourcifySrc(addr) {
  try {
    const r = await fetch('https://sourcify.dev/server/v2/contract/56/' + addr + '?fields=sources', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    const src = j && j.sources;
    if (!src || !Object.keys(src).length) return null;
    return Object.values(src).map((f) => (f && f.content) || '').join('\n').slice(0, 2000000);
  } catch { return null; }
}
async function sourcifyMainSrc(addr) {
  // 只取项目主合约文件（剔除 OpenZeppelin 等库文件——库里的参考链接不是项目官网）
  try {
    const r = await fetch('https://sourcify.dev/server/v2/contract/56/' + addr + '?fields=sources', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    const src = j && j.sources;
    if (!src || !Object.keys(src).length) return null;
    const paths = Object.keys(src);
    const main = paths.filter((p) => !/(openzeppelin|@openzeppelin|\/lib\/|node_modules|libsol|forge-std|hardhat|@chainlink|@ensdomains)/i.test(p));
    return (main.length ? main : paths).map((p) => src[p]?.content || '').join('\n').slice(0, 500000);
  } catch { return null; }
}
function auditFlags(src) {
  const hard = [], soft = [];
  if (src.includes('selfdestruct') || src.includes('suicide(')) hard.push('含 selfdestruct');
  if (src.includes('.delegatecall')) hard.push('含 delegatecall');
  if (src.includes('tx.origin')) hard.push('用 tx.origin 校验');
  if (src.includes('upgradeTo') || src.includes('_authorizeUpgrade') || src.includes('diamondCut')) hard.push('逻辑合约本身可升级（UUPS/钻石）');
  const hn = new Set(), sn = new Set();
  for (const m of src.matchAll(/function\s+(\w+)\s*\([^)]*\)[^{;]*onlyOwner/g)) {
    if (/black|fee|tax|paus/i.test(m[1])) hn.add(m[1]);
    else if (/mint|price|max|limit|sell|buy|swap|trad/i.test(m[1])) sn.add(m[1]);
  }
  if (hn.size) hard.push('owner 可拉黑/改税费/暂停：' + [...hn].slice(0, 5).join('/'));
  if (sn.size) soft.push('owner 可改规则：' + [...sn].slice(0, 5).join('/'));
  if (/function\s+mint\s*\([^)]*\)[^{;]*onlyOwner/.test(src)) soft.push('owner 可单独增发');
  return { hard, soft };
}
async function auditContract(c) {
  if (auditCache.has(c)) return auditCache.get(c);
  const res = { verdict: 'unverified', hard: [], soft: [], impl: '' };
  try {
    const target = await logicAddr(c);
    if (target !== LC(c)) res.impl = target;
    const src = await sourcifySrc(target);
    if (src) {
      const f = auditFlags(src);
      res.hard = f.hard; res.soft = f.soft;
      res.verdict = f.hard.length ? 'flag' : f.soft.length ? 'soft' : 'clean';
    }
  } catch {}
  auditCache.set(c, res);
  return res;
}
async function riskNote(c) {
  // 字节码层面的权限提醒（只提醒不拦截）：增发/暂停选择器 + owner 是否还在
  try {
    const code = await logicCode(c);
    const flags = [];
    if (code.includes('40c10f19')) flags.push('可增发');
    if (code.includes('8456cb59')) flags.push('可暂停');
    const o = await call(c, '0x8da5cb5b');
    const owner = o && o.length >= 66 ? wordAddr(o) : '';
    if (owner && owner !== ZERO) flags.push('owner 未放弃权限');
    return flags.length ? '\n合约权限提醒：' + flags.join('、') : '';
  } catch { return ''; }
}

// ---------- 创新性判断：≥2 项命中 = 创新候选，⭐ 重点提醒并单独圈出 ----------
const KECCAK_RC = [0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n];
const KECCAK_ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const KECCAK_PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const M64 = (1n << 64n) - 1n;
const rotl64 = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function keccakF(st) {
  for (let round = 0; round < 24; round++) {
    const bc = [];
    for (let i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    let t = st[1];
    for (let i = 0; i < 24; i++) {
      const j = KECCAK_PILN[i];
      const tmp = st[j];
      st[j] = rotl64(t, KECCAK_ROTC[i]);
      t = tmp;
    }
    for (let j = 0; j < 25; j += 5) {
      const row = st.slice(j, j + 5);
      for (let i = 0; i < 5; i++) st[j + i] = row[i] ^ ((~row[(i + 1) % 5]) & row[(i + 2) % 5]);
    }
    st[0] ^= KECCAK_RC[round];
  }
}
function keccak256(bytes) {
  const rate = 136;
  const st = new Array(25).fill(0n);
  const padLen = rate - (bytes.length % rate);
  const padded = Buffer.alloc(bytes.length + padLen);
  Buffer.from(bytes).copy(padded);
  padded[bytes.length] |= 0x01;
  padded[padded.length - 1] |= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      st[i] ^= lane;
    }
    keccakF(st);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    let lane = st[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out.toString('hex');
}
const sigSel = (sig) => keccak256(Buffer.from(sig, 'utf8')).slice(0, 8);
const KNOWN_SEL = new Set(['1249c58b', '5b70ea9f', '4e71d92d', 'a0712d68', '26092b83', '74d04cfc', '9f92d0dd', '7c928fe9', '379607f5', '8ab53447', 'f366afc9', '1be3587a', '70a08231', 'a9059cbb', '095ea7b3', '23b872dd', 'dd62ed3e', '18160ddd', '06fdde03', '95d89b41', '313ce567', '8da5cb5b', '715018a6', 'f2fde38b', '40c10f19', '8456cb59', '3f4ba83a', '6352211e', '081812fc', 'b88d4fde', 'a22cb465', 'e985e9c5', '01ffc9a7', '80ac58cd', '68bce8cd', '725c4058', '590e1ae3', 'b5545a3c', '278ecde1', '5b7baf64', '110f8874', '16bfe25c', '38e771ab', 'b2d5ae44', 'fa89401a', 'bffa55d5', '68ec0d99', '74c1b1c9', 'b30196e5', 'c033a490', '4c4a386f', 'd233e4eb']);
const MECH_FAMS = [['质押', /stake|staking/i], ['销毁', /\bburn\b|burnable/i], ['联合曲线', /bonding|\bcurve\b/i], ['纪元/赛季', /epoch|season/i], ['任务', /quest/i], ['投票治理', /voting|\bvote\b|governor/i], ['复投/收割', /compound|harvest/i], ['借贷', /lending|\bborrow\b/i]];
const mechFams = (src) => MECH_FAMS.filter(([, re]) => re.test(src)).map(([name]) => name);
const innoCache = new Map();
const gradeOf = (t) => (t >= 65 ? 'A' : t >= 40 ? 'B' : 'C'); // 总分 90：A ≥65、B ≥40
const innoTrig = (r) => !!r && r.grade === 'A';
const learnedSelN = (c) => new Set((S.learned?.[c] || []).map((d) => d.slice(0, 10).toLowerCase())).size;
const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); let inter = 0; for (const x of A) if (B.has(x)) inter++; const uni = A.size + B.size - inter; return uni ? inter / uni : 0; };
function compareHist(sels, fams, hist, selfAddr, srcHash) {
  // 与历史指纹库对比：最像的项目 + 历史首现的函数/机制
  let sim = 0, near = null, base = 0;
  const seenS = new Set(), seenF = new Set();
  for (const [addr, h] of Object.entries(hist || {})) {
    if (addr === selfAddr || !h.sels) continue;
    base++;
    for (const s of h.sels) seenS.add(s);
    for (const f of h.fams || []) seenF.add(f);
    const j = srcHash && h.srcHash === srcHash ? 1 : jaccard(sels, h.sels);
    if (j > sim) { sim = j; near = { addr, name: h.name || '', sim: j }; }
  }
  return { sim, near, base, firstSels: sels.filter((s) => !KNOWN_SEL.has(s) && !seenS.has(s)), firstFams: fams.filter((f) => !seenF.has(f)) };
}
async function innovation(c, P) {
  const ent = innoCache.get(c);
  if (ent && now() - ent.at < 1800e3 && ent.res.learnedN === learnedSelN(c)) return ent.res;
  const learnedN = learnedSelN(c);
  let sels = new Set(), fams = [], srcHash = '', regFns = 0, srcLen = 0;
  try {
    const src = await sourcifySrc(await logicAddr(c));
    if (src) {
      srcLen = src.length;
      srcHash = keccak256(Buffer.from(src, 'utf8')).slice(0, 16);
      for (const m of src.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g)) {
        const types = m[2].split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean).join(',');
        if (types.includes('(')) continue;
        try { sels.add(sigSel(`${m[1]}(${types})`)); } catch {}
      }
      fams = mechFams(src);
      const regLit = '60b9262456de011f7d15a54cdd8c48baaa8b022f';
      const segs = src.split(/function\s+/);
      for (let i = 1; i < segs.length; i++) if (segs[i].toLowerCase().includes(regLit)) regFns++;
      // 历史指纹库（落盘）：函数集合 + 机制族 + 源码哈希
      S.hist = S.hist || {};
      S.hist[c] = { name: P?.name || S.hist[c]?.name || '', at: S.hist[c]?.at || now(), sels: [...sels].slice(0, 200), fams, srcHash };
      save();
    }
  } catch {}
  const cmp = compareHist([...sels], fams, S.hist, c, srcHash);
  // 四维评分（满分 90；叙事维无数据源，不计）
  let origPts = srcLen ? Math.round(30 * (1 - cmp.sim)) : 5; // 原创性 /30
  if (cmp.base < 5) origPts = Math.min(origPts, 15); // 历史样本不足时不给满
  let mechPts = Math.min(15, cmp.firstSels.length * 3) + Math.min(10, cmp.firstFams.length * 5); // 机制新颖 /25
  if (cmp.base < 5) mechPts = Math.min(mechPts, 8);
  mechPts = Math.min(25, mechPts);
  const regPart = regFns >= 3 ? 12 : regFns === 2 ? 8 : regFns === 1 ? 4 : 0;
  const extraIx = Math.max(0, learnedN - 1);
  const identPts = Math.min(20, regPart + (extraIx >= 2 ? 8 : extraIx === 1 ? 4 : 0)); // 身份应用 /20
  const proofBase = learnedN >= 4 ? 15 : learnedN === 3 ? 11 : learnedN === 2 ? 7 : learnedN === 1 ? 3 : 0;
  const proofPts = Math.max(proofBase, P?.dualAsset ? 7 : 0); // 链上实证 /15
  const total = origPts + mechPts + identPts + proofPts;
  const grade = gradeOf(total);
  const hits = [];
  hits.push(cmp.near ? `原创性 ${origPts}/30：与历史项目「${cmp.near.name || (cmp.near.addr.slice(0, 10) + '·未命名')}」最像，函数相似度 ${Math.round(cmp.sim * 100)}%` : `原创性 ${origPts}/30：历史库可比项目 ${cmp.base} 个`);
  if (cmp.firstFams.length) hits.push('首现机制：' + cmp.firstFams.join('/'));
  if (cmp.firstSels.length) hits.push(`${cmp.firstSels.length} 个历史未见过的函数`);
  if (fams.length >= 2) hits.push('含机制：' + fams.join('/'));
  hits.push(`身份应用 ${identPts}/20：登记合约被 ${regFns} 个函数引用，链上 ${learnedN} 种交互`);
  hits.push(`链上实证 ${proofPts}/15`);
  if (P?.dualAsset) hits.push('铸造同时产出代币与 NFT');
  const res = { score: total, score100: total, grade, hard: (fams.length >= 2 ? 1 : 0) + (learnedN >= 2 ? 1 : 0) + (P?.dualAsset ? 1 : 0), hits, learnedN, clue: cmp.base >= 3 && (cmp.firstFams.length >= 1 || cmp.firstSels.length >= 3), parts: { origPts, mechPts, identPts, proofPts } };
  innoCache.set(c, { res, at: now() });
  if (P) {
    if (grade !== 'C') { if (P.innovative !== total) { P.innovative = total; save(); } }
    else if (P.innovative) { delete P.innovative; save(); }
  }
  return res;
}
const innoSending = new Set();
async function innoAlert(c, P, extra = '', withInfo = true) {
  if (innoSending.has(c)) return { score: 0, score100: P.inno100 || 0, grade: P.innoGrade || 'C', hard: 0, hits: [] }; // 在途锁：防巡检与分析并发同发两遍
  innoSending.add(c);
  try { return await innoAlertInner(c, P, extra, withInfo); } finally { innoSending.delete(c); }
}
async function innoAlertInner(c, P, extra = '', withInfo = true) {
  const inno = await innovation(c, P).catch(() => null);
  if (!inno) return { score: 0, score100: 0, grade: 'C', hard: 0, hits: [] };
  // 成长记录：分数变化 ≥5 或等级变化留一条（最多 10 条）
  const lastH = (P.innoHist || []).slice(-1)[0];
  if (!lastH || Math.abs(inno.score100 - lastH.score) >= 5 || lastH.grade !== inno.grade) P.innoHist = [...(P.innoHist || []), { at: now(), score: inno.score100, grade: inno.grade }].slice(-10);
  if (P.inno100 !== inno.score100 || P.innoGrade !== inno.grade) { P.inno100 = inno.score100; P.innoGrade = inno.grade; save(); }
  // 分级提醒：A 重点 / B 观察 / C 有首现证据时发早期线索；已报 A 后分数再涨 10 发进展
  let kind = '', stageTo = 0;
  if (inno.grade === 'A' && (P.innoStage || 0) < 2) { kind = 'A级·重点提醒'; stageTo = 2; }
  else if (inno.grade === 'B' && (P.innoStage || 0) < 1) { kind = 'B级·创新观察'; stageTo = 1; }
  else if (inno.grade === 'C' && inno.clue && (P.innoStage || 0) < 1) { kind = '早期创新线索'; stageTo = 1; }
  else if ((P.innoStage || 0) >= 2 && (P.innoStage || 0) < 3 && inno.score100 >= (P.innoAlertScore || 0) + 10) { kind = '创新进展'; stageTo = 3; }
  if (!kind) return inno;
  if ((P.innoTries || 0) >= 5 || now() < (P.innoTryAt || 0)) return inno;
  if (!(await projectPushAllowed(c, P))) return inno; // 官网/X/GitHub 三样全无：不推，分数与成长记录照常保留
  const star = kind.startsWith('A级') || kind === '创新进展' ? '⭐' : '🔍';
  const info = withInfo ? await infoBlock(c, P, false).catch(() => '') : '';
  const delivered = await tg(`${star} ${kind}：${P.name || ''}（创新评分 ${inno.score100}/90，${inno.grade} 级）\n合约：${c}\n${inno.hits.join('\n')}${info ? '\n' + info : ''}${extra}\nTG 发「创新」可看全部圈出项目`);
  P.innoTries = (P.innoTries || 0) + 1;
  if (delivered) { P.innoStage = stageTo; P.innoAlertScore = inno.score100; P.innoTries = 0; P.innoTryAt = 0; }
  else P.innoTryAt = now() + 1800e3; // 未送达：30 分钟后补发，最多 5 次
  save();
  return inno;
}

// ---------- 免费执行：时机门槛 -> 审核门 -> gas -> baw 预览 -> 执行 ----------
const mintQueues = new Map();
const mintQueued = new Set();
const mintClosed = (P, W) => { const d = P?.done?.[W.name]; return (d && d !== 'free') || (P?.count?.[W.name] || 0) >= 10; };
function setVerdict(P, s, why) {
  // 每项目一条裁决记录：通过 / 观察 / 拒绝 + 原因（TG 发「项目」可查）
  if (P.verdict?.s === s && P.verdict?.why === why) return;
  const changed = P.verdict?.s !== s;
  P.verdict = { s, why, at: now() };
  save();
  if (changed) log(`裁决 ${P.name || ''}：${s}——${why}`);
}
function effAgents(P) {
  // 有效参与数：同一区块涌入的参与钱包每块最多算 3 个（批量脚本同块进场打折）
  if (!P.agentBlocks) return P.agents || 0;
  let eff = 0;
  for (const n of Object.values(P.agentBlocks)) eff += Math.min(n, 3);
  return eff;
}
function noteFail(P, W, why) {
  // 临时失败：记次数，2 分钟后重试；连续 3 次才放弃（记 fail）
  P.failCnt = P.failCnt || {};
  P.failCnt[W.name] = (P.failCnt[W.name] || 0) + 1;
  if (P.failCnt[W.name] >= 3) { P.done[W.name] = 'fail'; setVerdict(P, '拒绝', '连续失败 3 次：' + why); save(); return '❌ 连续失败 3 次，放弃：' + why; }
  setVerdict(P, '观察', '临时失败，自动重试中：' + why);
  P.retryAt = P.retryAt || {};
  P.retryAt[W.name] = now() + 120e3;
  save();
  return `⏸ 临时失败（第 ${P.failCnt[W.name]} 次），2 分钟后重试：${why}`;
}
function queueMint(c, found, W) {
  const key = c + '|' + W.name;
  if (mintQueued.has(key)) return;
  const P = S.track[c];
  if (mintClosed(P, W)) return;
  if ((P?.retryAt?.[W.name] || 0) > now()) return;
  mintQueued.add(key);
  const prev = mintQueues.get(W.name) || Promise.resolve();
  const job = prev.then(() => autoMintMax(c, found, W)).catch((e) => log(`铸造异常 ${c} ${e.message}`)).finally(() => mintQueued.delete(key));
  mintQueues.set(W.name, job);
}
async function autoMintMax(c, found, W) {
  const P = S.track[c] || (S.track[c] = { at: now(), name: '', done: {}, agents: 0 });
  let n = 0;
  let first = '';
  while ((P.count?.[W.name] || 0) < 10) {
    if ((P.count?.[W.name] || 0) > 0) {
      // 连打前复探：同一 calldata 零金额还过才继续；revert = 额度/门禁没了，停；其他错误记 more，稍后重试
      try { await rpc('eth_call', [{ from: W.addr, to: c, data: found.data, value: '0x0' }, 'latest']); }
      catch (e) {
        if (!/revert/i.test(e.message || '')) { P.moreTries = (P.moreTries || 0) + 1; if (P.moreTries < 5) P.more = 1; else delete P.more; save(); }
        break;
      }
      await sleep(5000);
    }
    const m = await autoMint(c, found, W);
    if (!first) first = m;
    if (!m.startsWith('🤖')) break;
    n++;
    P.moreTries = 0;
    if (P.more) { delete P.more; save(); }
  }
  return n > 1 ? first + `\n（同一钱包共打了 ${n} 份）` : first;
}
function todayKey() { return new Date().toDateString(); }
async function autoMint(c, found, W) {
  const P = S.track[c] || (S.track[c] = { at: now(), name: '', done: {}, agents: 0 });
  if (P.done[W.name] && P.done[W.name] !== 'free') return '✅ 这个钱包已经打过';
  if ((P.count?.[W.name] || 0) >= 10) return '✅ 这个钱包已打满 10 份';
  // 部署者筛选：黑名单直接拦（黑名单由审核硬红旗自动入册，见审核门）
  const dep = P.deployer || '';
  if (dep && S.black[dep]) {
    if (P.verdict?.s !== '拒绝' && (await projectPushAllowed(c, P))) await tg(`⛔ 部署者在黑名单，免费未打：${P.name || ''}\n${c}\n部署者 ${dep}\n入册原因：${S.black[dep].why}`);
    setVerdict(P, '拒绝', '部署者黑名单：' + S.black[dep].why);
    return '⛔ 部署者在黑名单，没有打';
  }
  const serialN = dep ? (S.devProjects?.[dep] || []).length : 0;
  // 时机门槛
  const fp = await readProgress(c);
  if (fp != null && fp < OUR.goPct) { P.waitHot = 1; setVerdict(P, '观察', `进度 ${Math.floor(fp * 100)}%，未到 ${Math.round(OUR.goPct * 100)}%`); save(); return `⏸ 进度 ${Math.floor(fp * 100)}%，未到 ${Math.round(OUR.goPct * 100)}%，先追踪`; }
  if (fp == null) {
    const eff = effAgents(P);
    if (eff < OUR.crowdGo) { P.waitHot = 1; setVerdict(P, '观察', `读不到进度，Agent ID 钱包 ${P.agents || 0} 个、同块打折后有效 ${eff} 个，未到 ${OUR.crowdGo}`); save(); return `⏸ 读不到进度，目前 ${P.agents || 0} 个 Agent ID 钱包在打（有效 ${eff}），要 ${OUR.crowdGo} 个才打`; }
    const tk = await tokenOf(c).catch(() => c);
    if (await poolOpen(tk)) { setVerdict(P, '观察', '已开池，不铸造'); return '⏸ 已开池，不铸（铸价通常贵过市价）'; }
  }
  // 合约审核门
  let note = '';
  if (OUR.audit) {
    const au = await auditContract(c);
    if (au.verdict === 'flag') {
      if (dep && !S.black[dep]) { S.black[dep] = { why: `合约审核硬红旗（${P.name || c.slice(0, 10)}）：${au.hard.join('、')}`, at: now() }; save(); }
      setVerdict(P, '拒绝', '合约审核硬红旗：' + au.hard.join('、'));
      S.blockList = S.blockList || []; // 拦截只记名单进 6 小时汇总，不再逐个推送（用户 15:11 指令，与无退款同口径）
      if (!S.blockList.some((x) => x.c === c)) { S.blockList.push({ c, name: P.name || '', flags: au.hard.join('、'), at: now() }); if (S.blockList.length > 500) S.blockList = S.blockList.slice(-500); }
      save();
      return `🛡 合约审核拦截：${au.hard.join('、')}`;
    }
    if (au.verdict === 'soft') note = '\n（源码已验证，审核提示：' + au.soft.join('、') + '）';
    if (au.verdict === 'unverified') note = '\n（⚠ 源码未验证，按 A 档标注放行）';
    // gas 异常拦截
    try {
      const ge = await rpc('eth_estimateGas', [{ from: W.addr, to: c, data: found.data, value: '0x0' }]);
      if (ge && BigInt(ge) > OUR.gasCap) {
        S.auditNoted = S.auditNoted || {};
        const gk = c + '|gas';
        if (!S.auditNoted[gk]) { S.auditNoted[gk] = 1; save(); if (await projectPushAllowed(c, P)) await tg(`🛡 gas 估算异常拦截（免费未打）：${P.name || ''}\n${c}\n估算约 ${Number(BigInt(ge)).toLocaleString('en-US')}，超过拦截线 ${OUR.gasCap.toLocaleString('en-US')}\nhttps://bscscan.com/address/${c}`); }
        setVerdict(P, '拒绝', `gas 估算异常（约 ${Number(BigInt(ge)).toLocaleString('en-US')}）`);
        return `🛡 gas 估算异常（约 ${Number(BigInt(ge)).toLocaleString('en-US')}）`;
      }
    } catch {}
  }
  if (serialN >= 3) note += `\n（部署者已发 ${serialN} 个项目）`;
  const inno = await innoAlert(c, P);
  if (inno.grade === 'A') note += `\n（⭐ 创新候选 ${inno.score100}/90）`;
  else if (inno.grade === 'B') note += `\n（🔍 创新观察 ${inno.score100}/90）`;
  // 每日上限与 gas 余额
  const tk2 = todayKey();
  S.mintCnt = S.mintCnt || {};
  if (S.mintCnt.d !== tk2) S.mintCnt = { d: tk2 };
  if ((S.mintCnt[W.name] || 0) >= OUR.dailyMintCap) return `⏸ 今日自动打已达 ${OUR.dailyMintCap} 笔上限`;
  const bnb = big(await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x'));
  if (bnb < 5n * 10n ** 14n) return '⚠️ BNB 不够付 gas（<0.0005），没有打';
  // baw 预览：必须通过模拟且真能拿到东西、无授权变化、不多扣资产
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', c, '--value', '0', '--inputData', found.data]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) return noteFail(P, W, '预演请求失败：' + (p.j?.error?.message || '无响应').slice(0, 120));
  if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) { P.done[W.name] = 'fail'; setVerdict(P, '拒绝', '预演显示有授权变化'); save(); return '⚠️ 预演显示有授权变化，没有打'; }
  const mine = (sim?.balanceChanges || []).filter((b) => LC(b.owner) === W.addr);
  const losing = mine.filter((b) => Number(b.change) < 0);
  if (losing.length) { P.done[W.name] = 'fail'; setVerdict(P, '拒绝', '预演显示会扣资产'); save(); return '⚠️ 预演显示会扣你的资产，没有打'; }
  const gaining = mine.some((b) => Number(b.change) > 0 || /Erc721|Erc1155/i.test(b.tokenType || ''));
  if (!gaining) { P.done[W.name] = 'fail'; setVerdict(P, '拒绝', '预演显示拿不到东西'); save(); return '⚪ 预演显示拿不到东西，没有打'; }
  if (mine.some((b) => b.tokenType === 'Erc20' && Number(b.change) > 0) && mine.some((b) => /Erc721|Erc1155/i.test(b.tokenType || '')) && !P.dualAsset) { P.dualAsset = 1; innoCache.delete(c); save(); }
  const x = await W.baw(['contract-call', 'execute', '--requestId', rid]);
  if (!x.j && /timed? ?out|ETIMEDOUT|killed/i.test(x.t || '')) { P.done[W.name] = 'unknown'; save(); if (await projectPushAllowed(c, P)) await tg(`⚠️ 免费铸造送出结果不明（超时），先不重打：${P.name || ''}\n${c}`); return '⚠️ 送出结果不明'; }
  if (!x.j?.success) return noteFail(P, W, '送出失败：' + (x.j?.error?.message || x.t).slice(0, 120));
  P.done[W.name] = 'free';
  P.count = P.count || {};
  P.count[W.name] = (P.count[W.name] || 0) + 1;
  setVerdict(P, '通过', `免费铸造成功（共 ${P.count[W.name]} 份）`);
  if (P.dualAsset) await innoAlert(c, P);
  if (P.failCnt) delete P.failCnt[W.name];
  if (P.retryAt) delete P.retryAt[W.name];
  S.mintCnt[W.name] = (S.mintCnt[W.name] || 0) + 1;
  save();
  // 到账登记持仓（ERC20 成本 0 进信号监控；NFT 记系列）
  for (const b of mine) {
    if (b.tokenType === 'Erc20' && Number(b.change) > 0) {
      const ta = LC(b.contractAddress);
      if (!S.hold.some((t) => t.addr === ta && t.only === W.addr)) S.hold.push({ sym: tokStr(await call(ta, '0x95d89b41')) || ta.slice(0, 8), addr: ta, cost: 0, only: W.addr, at: now(), flags: {} });
    }
    if (/Erc721|Erc1155/i.test(b.tokenType || '')) { S.nftCols = S.nftCols || {}; S.nftCols[LC(b.contractAddress)] = 1; }
  }
  save();
  const got = mine.map((b) => (b.tokenType === 'Erc721' ? 'NFT ×1' : b.tokenType + ' +' + b.change)).join('、');
  const info = await infoBlock(c, P).catch(() => `合约：${c}`);
  const msg = `🆓 打了免费项目：${P.name || c.slice(0, 10)}（${W.name}）${got ? '\n到账：' + got : ''}\n${info}${note}\n交易 ${x.j.data?.txHash || x.j.data?.orderId || ''}`;
  if (await projectPushAllowed(c, P)) await tg(msg);
  return '🤖 已铸造 ' + (P.name || c.slice(0, 10));
}

// ---------- 收费线：分类、退款检查、到门槛出分析（永不自动执行） ----------
const REFUND_SELS = ['590e1ae3', 'b5545a3c', '278ecde1', '5b7baf64', '110f8874', '16bfe25c', '38e771ab', 'b2d5ae44', 'fa89401a', 'bffa55d5', '68ec0d99', '74c1b1c9', 'b30196e5', 'c033a490', '4c4a386f', 'd233e4eb']; // refund()/claimRefund() 等退款类函数的签名哈希
async function hasRefund(c) {
  const code = await logicCode(c);
  return REFUND_SELS.some((s) => code.includes(s));
}
async function classifyPaid(c) {
  // bnb=BNB 报价型（quote 选择器 0x68bce8cd），usdt=USDT 份额型（0x725c4058），gen=其他单价型
  const q1 = await call(c, '0x68bce8cd' + w(1));
  if (q1 && q1.length >= 66 && BigInt(q1.slice(0, 66)) > 0n) return 'bnb';
  const q2 = await call(c, '0x725c4058' + w(1));
  if (q2 && q2.length >= 66 && BigInt(q2.slice(0, 66)) > 0n) return 'usdt';
  return 'gen';
}
function surgeText(P) {
  // 参与钱包增长：与约 30 分钟前的快照比（快照由 paidSweep 每 5 分钟记一次）
  const effN = effAgents(P);
  const g = P.growth || [];
  if (g.length < 2) return effN > 0 ? `现 ${effN} 个` : '';
  const target = now() - 1800e3;
  let base = g[0];
  for (const s of g) if (s.at <= target) base = s;
  const mins = Math.max(1, Math.round((now() - base.at) / 60000));
  const d = effN - base.n;
  return `近 ${mins} 分钟 ${d >= 0 ? '+' : ''}${d} 个（现 ${effN} 个）`;
}
async function infoBlock(c, P, withContract = true) {
  // 提醒统一信息块：合约、官网、推特、叙事、参与增长
  const links = await discoverLinks(c, P).catch(() => P.links || {});
  const lines = [];
  if (withContract) lines.push(`合约：${c}（https://bscscan.com/address/${c}）`);
  lines.push(`官网：${links.site || '未找到'}`);
  lines.push(`X：${links.x || '未找到'}`);
  if (links.github) lines.push(`GitHub：${links.github}`);
  if (P.narr) lines.push(`叙事：${P.narr.total}/100 ${P.narr.grade} 级｜${P.narr.story || ''}｜概念：${(P.narr.tags || []).join('、') || '—'}`);
  else lines.push(`叙事：${P.narrState || '待评'}`);
  const sg = surgeText(P);
  lines.push(`参与：Agent ID 钱包约 ${P.agents || 0} 个${effAgents(P) !== (P.agents || 0) ? `（有效约 ${effAgents(P)} 个）` : ''}${sg ? '｜增长：' + sg : ''}`);
  return lines.join('\n');
}
async function analyzePaid(c, P) {
  const price = await bnbUsd().catch(() => 0);
  const kind = P.kind || 'gen';
  let unitTxt = '单价读不到，以执行预览为准', maxShares = -1, costTxt = '', unitRaw = 0;
  try {
    if (kind === 'bnb') {
      const q = await call(c, '0x68bce8cd' + w(1));
      const u = q && q.length >= 66 ? Number(BigInt(q.slice(0, 66))) / 1e18 : 0;
      if (u > 0) unitRaw = u;
      if (u > 0 && price > 0) { const per = u * 1.005 * price; maxShares = Math.max(0, Math.min(10, Math.floor(OUR.paidMaxUsd / per))); unitTxt = `约 ${u.toFixed(5)} BNB/份（约 ${per.toFixed(2)}U/份）`; costTxt = maxShares > 0 ? `按 ${OUR.paidMaxUsd}U 上限最多 ${maxShares} 份，总成本约 ${(per * maxShares).toFixed(2)}U` : '1 份就超过付费上限'; }
    } else if (kind === 'usdt') {
      const q = await call(c, '0x725c4058' + w(1));
      const u = q && q.length >= 66 ? Number(BigInt(q.slice(0, 66))) / 1e18 : 0;
      if (u > 0) { unitRaw = u; maxShares = Math.max(0, Math.min(10, Math.floor(OUR.paidMaxUsd / u))); unitTxt = `约 ${u.toFixed(2)} USDT/份`; costTxt = maxShares > 0 ? `按 ${OUR.paidMaxUsd}U 上限最多 ${maxShares} 份，总成本约 ${(u * maxShares).toFixed(2)}U` : '1 份就超过付费上限'; }
    }
  } catch {}
  const { sold, cap } = await readSoldCap(c).catch(() => ({ sold: null, cap: null }));
  let paidTxt = '';
  if (sold != null && unitRaw > 0) {
    if (kind === 'bnb') paidTxt = `已付约 ${(sold * unitRaw).toFixed(4)} BNB${price > 0 ? `（约 ${(sold * unitRaw * price).toFixed(1)}U）` : ''}（已售 ${sold} 份 × 单价）`;
    else if (kind === 'usdt') paidTxt = `已付约 ${(sold * unitRaw).toFixed(1)} USDT（已售 ${sold} 份 × 单价）`;
  }
  const progress = await readProgress(c);
  const dep = P.deployer || '';
  const black = dep && S.black[dep] ? S.black[dep].why : '';
  const serial = dep && (S.devProjects?.[dep] || []).length >= 3 ? `（该部署者已发 ${(S.devProjects[dep]).length} 个项目）` : '';
  const rn = await riskNote(c).catch(() => '');
  const au = OUR.audit ? await auditContract(c).catch(() => ({ verdict: 'unverified', hard: [], soft: [] })) : { verdict: 'unverified', hard: [], soft: [] };
  const tk = await tokenOf(c).catch(() => c);
  const pool = await poolOpen(tk).catch(() => false);
  const agents = P.agents || 0;
  const eff = effAgents(P);
  let verdict, reason;
  if (black) { verdict = '不打'; reason = `部署者在黑名单（${black}）`; }
  else if (maxShares === 0) { verdict = '不打'; reason = '单价超过付费上限'; }
  else if (au.verdict === 'flag') { verdict = '不打'; reason = '合约审核有红旗：' + au.hard.join('、'); }
  else if (agents > 0 && agents < 20) { verdict = '观望'; reason = `参与的 Agent ID 钱包只有 ${agents} 个，进度可信度低`; }
  else if (au.verdict === 'soft') { verdict = '观望'; reason = '合约审核有提示：' + au.soft.join('、'); }
  else if (rn) { verdict = '观望'; reason = '合约留有开发者权限，见下方提醒'; }
  else if (pool) { verdict = '观望'; reason = '已经开池，铸造价可能不如市价，要先比价'; }
  else { verdict = '可以打'; reason = '有退款保本、进度过门槛、参与人数够、未见合约风险'; }
  setVerdict(P, verdict === '可以打' ? '通过' : verdict === '观望' ? '观察' : '拒绝', reason);
  if (NARR() && !P.narr) await narrativeEval(c, P).catch(() => {});
  const info = await infoBlock(c, P, false).catch(() => '');
  const inno = await innovation(c, P).catch(() => ({ score: 0, hits: [] }));
  if (!(await projectPushAllowed(c, P))) { log(`付费分析 ${P.name || c}：${verdict}——${reason}（无官网/X/GitHub，不推送）`); return; }
  log(`付费分析 ${P.name || c}：${verdict}——${reason}`);
  await tg(`🔔 付费项目分析：${P.name || c.slice(0, 10)}（进度 ${progress != null ? Math.round(progress * 100) + '%' : '读不到'}${sold != null && cap ? `，已售 ${sold}/${cap}` : ''}）
合约：${c}
类型：${{ bnb: 'BNB 报价型', usdt: 'USDT 份额型', gen: 'NFT 单价型' }[kind] || kind}
单价：${unitTxt}${costTxt ? `\n成本：${costTxt}` : ''}${paidTxt ? `\n付费：${paidTxt}` : ''}
${info}${dep ? `\n部署者：${dep}${black ? '（黑名单）' : ''}${serial}` : ''}
创新：${inno.grade} 级 ${inno.score100}/90${inno.hits.length ? '（' + inno.hits.slice(0, 3).join('；') + '）' : ''}
保本：合约有退款函数 ✓${pool ? '\n状态：已开池' : ''}${rn}
合约审核：${au.verdict === 'clean' ? '源码已验证、未见红旗' : au.verdict === 'flag' ? '源码已验证但有红旗：' + au.hard.join('、') : au.verdict === 'soft' ? '源码已验证，审核提示：' + au.soft.join('、') : '源码未验证'}
结论：${verdict}——${reason}
要打回主聊天告诉我打哪个、多少份，我先预览报总成本和每份到账，你确认了才执行；不回就不打`);
  await innoAlert(c, P, `\n付费结论：${verdict}——${reason}`, false);
}
async function paidSweep() {
  for (const [c, P] of Object.entries(S.track)) {
    try {
      if (now() - (P.at || 0) > 3 * 86400e3) continue;
      // 参与增长快照：每 5 分钟记一次有效参与数，留最近 1 小时（供 surgeText 算激增）
      P.growth = P.growth || [];
      const lastG = P.growth[P.growth.length - 1];
      if (!lastG || now() - lastG.at >= 300e3) { P.growth.push({ at: now(), n: effAgents(P) }); if (P.growth.length > 12) P.growth = P.growth.slice(-12); }
      if (WALLETS.every((W) => mintClosed(P, W))) continue;
      const fp = await readProgress(c);
      if (fp != null) P.progress = fp;
      // 免费的随时捡漏：能免费打就排队（执行链自带门槛）
      let freeFound = null;
      for (const W of WALLETS) {
        if (mintClosed(P, W)) continue;
        if (P.done?.[W.name] === 'free' && !P.more) continue;
        if ((P.retryAt?.[W.name] || 0) > now()) continue;
        const ff = await findFree(W, c).catch(() => null);
        if (ff) { freeFound = true; queueMint(c, ff, W); }
      }
      if (freeFound) continue;
      // 收费线
      if (!P.kind) P.kind = await classifyPaid(c).catch(() => 'gen');
      if (P.refundOk == null) { P.refundOk = (await hasRefund(c).catch(() => false)) ? 1 : 0; save(); }
      const gate = (fp != null && fp >= OUR.goPct) || (fp == null && effAgents(P) >= OUR.crowdGo);
      if (!gate) continue;
      if (!P.refundOk) {
        if (!P.noRefundLog) {
          // 无退款不打：不逐个推送（量太大、没信息量），只记名单进 6 小时汇总；裁决照常记录可查
          P.noRefundLog = 1; setVerdict(P, '拒绝', '付费项目无退款（保本）机制');
          S.noRefList = S.noRefList || [];
          S.noRefList.push({ c, name: P.name || '', fp, agents: P.agents || 0, at: now() });
          if (S.noRefList.length > 500) S.noRefList = S.noRefList.slice(-500);
          save();
        }
        continue;
      }
      if (!P.reported) { P.reported = 1; save(); await analyzePaid(c, P).catch((e) => log('analyzePaid ' + e.message)); }
    } catch (e) { log(`paidSweep ${c} ${e.message}`); }
  }
}
async function noRefDigest() {
  const since = S.noRefDigestAt || 0;
  const fresh = (S.noRefList || []).filter((x) => x.at > since);
  const freshB = (S.blockList || []).filter((x) => x.at > since);
  if (!fresh.length && !freshB.length) return;
  S.noRefDigestAt = now(); save();
  let msg = '🔕 不符合汇总（只记名单不逐个推；其中有官网/X/GitHub 任一且创新/叙事达标的仍会单独提醒，发「项目」可查全部裁决）';
  if (fresh.length) msg += `\n— 无退款不打 ${fresh.length} 个 —\n` + fresh.slice(0, 60).map((x) => `✖ ${x.name || x.c.slice(0, 10)}｜进度 ${x.fp != null ? Math.round(x.fp * 100) + '%' : '—'}｜参与 ${x.agents}｜${x.c}`).join('\n') + (fresh.length > 60 ? `\n……还有 ${fresh.length - 60} 个未列` : '');
  if (freshB.length) msg += `\n— 审核拦截 ${freshB.length} 个 —\n` + freshB.slice(0, 40).map((x) => `🛡 ${x.name || x.c.slice(0, 10)}｜${x.flags}｜${x.c}`).join('\n') + (freshB.length > 40 ? `\n……还有 ${freshB.length - 40} 个未列` : '');
  await tg(msg);
}
async function fastLane() {
  // 临近门槛的追踪项加快检查（15 秒一轮）：进度跨过门槛就立刻排队打
  for (const [c, P] of Object.entries(S.track)) {
    try {
      if (!P.waitHot || WALLETS.every((W) => mintClosed(P, W))) continue;
      const fp = await readProgress(c);
      if (fp != null) P.progress = fp;
      if (fp != null && fp >= 0.45) {
        for (const W of WALLETS) {
          if (mintClosed(P, W)) continue;
          if (P.done?.[W.name] === 'free' && !P.more) continue;
          if ((P.retryAt?.[W.name] || 0) > now()) continue;
          const ff = await findFree(W, c).catch(() => null);
          if (ff) queueMint(c, ff, W);
        }
      }
    } catch {}
  }
}

async function innoSweep() {
  // 创新评估挂全项目巡检：不依赖收费分析/铸造流程，无退款、未到门槛的项目同样评
  for (const [c, P] of Object.entries(S.track)) {
    try {
      if (now() - (P.at || 0) > 3 * 86400e3) continue;
      await innoAlert(c, P);
    } catch {}
  }
}

// ---------- 叙事轨：链接发现 -> 官网抓取 -> AI 五维评分 -> 分级提醒（与技术轨、铸造完全独立） ----------
const NARR = () => (CONFIG.narrative?.apiKey ? CONFIG.narrative : null);
const narrGradeOf = (t) => (t >= 70 ? 'A' : t >= 45 ? 'B' : 'C');
const linkCache = new Map();
const URL_DENY = /(eips\.ethereum\.org|ethereum\.org|soliditylang\.org|openzeppelin\.com|wikipedia\.org|readthedocs|github\.com\/(ethereum|OpenZeppelin|foundry-rs|smartcontractkit)\b|gnu\.org|apache\.org\/licenses|creativecommons|w3\.org)/i; // w3.org 是 SVG/XML 命名空间地址，不是官网（MOD 项目实测踩过）
function extractUrls(text) {
  const out = { site: '', x: '', github: '' };
  if (!text) return out;
  const urls = text.match(/https?:\/\/[^\s"'<>\(\)\[\]]+/g) || [];
  for (const u of urls) {
    const s = u.replace(/[.,;]+$/, '');
    if (URL_DENY.test(s)) continue;
    const gm = !out.github ? s.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/i) : null;
    if (!out.x && /^https?:\/\/(twitter\.com|x\.com)\/[\w]+\/?$/i.test(s)) out.x = s; // 只认账号主页，不认单条推文链接
    else if (gm && !/^(base64|solidity|forge-std|openzeppelin-contracts|solmate|solady|contracts|hardhat|foundry)$/i.test(gm[2])) out.github = s.replace(/\/$/, ''); // 只认仓库根目录，库文件 blob 链接是代码引用不是项目仓库
    else if (!out.site && !/(twitter\.com|x\.com|github\.com|t\.me|discord|bscscan|dexscreener|pancakeswap|four\.meme|flap\.sh|ipfs)/i.test(s)) out.site = s;
  }
  return out;
}
const xHandle = (url) => (String(url).match(/(?:twitter\.com|x\.com)\/([\w]+)/i)?.[1] || '').toLowerCase();
const deadLink = (st) => st === 404 || st === 410;
const hasPublicLinks = (links) => !!(links?.site || links?.x || links?.github);
async function projectPushAllowed(c, P) {
  // 用户 15:39 指令：官网、X、GitHub 三样全无的项目不主动推送，只后台记录
  const links = await discoverLinks(c, P).catch(() => P.links || {});
  if (hasPublicLinks(links)) return true;
  if (P && !P.noPublicLinksAt) { P.noPublicLinksAt = now(); save(); log(`项目无官网/X/GitHub，跳过推送 ${P.name || c}`); }
  return false;
}
function httpStatus(url, hops = 3) { return new Promise((resolve) => { try { const req = httpsRequest(url, { family: 4, timeout: 9000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => { res.resume(); if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) resolve(httpStatus(new URL(res.headers.location, url).href, hops - 1)); else resolve(res.statusCode || 0); }); req.on('timeout', () => { req.destroy(); resolve(0); }); req.on('error', () => resolve(0)); req.end(); } catch { resolve(0); } }); }
async function discoverLinks(c, P) {
  const ent = linkCache.get(c);
  if (ent && now() - ent.at < 6 * 3600e3) return ent.links;
  let links = P.links?.v === 3 ? { ...P.links } : { site: '', x: '', github: '', src: '', v: 3 };
  if (!links.site && !links.x) {
    try { const u = extractUrls(await sourcifyMainSrc(await logicAddr(c))); if (u.site || u.x || u.github) links = { ...u, src: '源码', v: 3 }; } catch {}
  }
  if (!links.site || !links.x) {
    try {
      const tk = await tokenOf(c).catch(() => c);
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tk}`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => null);
      const info = j?.pairs?.[0]?.info;
      if (info) {
        const soc = {};
        for (const s of info.socials || []) soc[s.type] = s.url;
        links = { site: links.site || info.websites?.[0]?.url || '', x: links.x || soc.twitter || '', github: links.github || soc.github || '', src: links.src ? links.src + '+Dex' : 'Dex', v: 3 };
      }
    } catch {}
  }
  // 官网归属验证：从源码提取的官网必须能抓开且页面里有项目名或合约地址，否则作废（防库文件链接冒充官网）
  if (links.site && (links.src || '').includes('源码') && !links.siteOk) {
    const got = await fetchSiteText(links.site).catch(() => null);
    const nm = (P.name || '').toLowerCase();
    if (got && ((nm.length >= 3 && got.html.includes(nm)) || got.html.includes(c.slice(2, 20)))) links.siteOk = 1;
    else links.site = '';
  }
  // 链接验活：官网/X/GitHub 返回 404/410 判失效丢弃并记死名单防复活；网络错误不丢（防误杀）；按 URL 只验一次
  links.val = links.val || {}; links.dead = links.dead || {};
  for (const f of ['site', 'x', 'github']) {
    const u = links[f];
    if (!u) continue;
    if (links.dead[f] === u) { links[f] = ''; continue; }
    if (links.val[f] !== u) { const st = await httpStatus(u).catch(() => 0); links.val[f] = u; if (deadLink(st)) { log(`链接验活失效丢弃 ${f} ${u}（HTTP ${st}）`); links[f] = ''; links.dead[f] = u; } }
  }
  const stale = !!(P.links && P.links.v !== 3); // 旧版提取的链接（含库文件垃圾链接）一律覆盖作废
  if (stale || ((links.site || links.x || links.github) && JSON.stringify(links) !== JSON.stringify(P.links || {}))) { P.links = links; save(); }
  linkCache.set(c, { links, at: now() });
  return links;
}
async function fetchSiteText(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }, redirect: 'follow' });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 400000);
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { text: text.slice(0, 6000), html: html.toLowerCase() };
  } catch { return null; }
}
async function aiNarrative(P, links, siteText) {
  const prompt = `给一个区块链项目做叙事评分。只能依据下面官网文本里的证据打分，文本没提到的维度给低分并注明未提及，不许编造。五维：新颖度0-30（新概念还是旧题材换包装）、应用价值0-25（能否说清解决什么问题）、可信度0-20（有无真实产品/文档/路线图等可验证资料）、社区真实性0-15（只有官网文本时按呈现保守给分）、传播潜力0-10（是否容易被理解和讨论）。另给1-3个概念标签（中文短词，如"Agent协作经济"）、一句话说清项目讲什么、每个维度一句证据。只输出JSON，不要其他文字：{"novelty":0,"value":0,"cred":0,"community":0,"spread":0,"tags":[],"story":"","evidence":[]}\n项目名：${P.name || ''}\n官网：${links.site}\nX：${links.x || '未找到'}（官网互链确认：${links.xVerified ? '是' : '否'}）\nGitHub：${links.github || '未找到'}\n官网文本：${siteText}`;
  const NC = NARR();
  const r = await fetch(`${NC.baseUrl || 'https://api.siliconflow.cn/v1'}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${NC.apiKey}` }, body: JSON.stringify({ model: NC.model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 700 }), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => null);
  const m = (j?.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  const o = JSON.parse(m[0]);
  const cl = (v, mx) => Math.max(0, Math.min(mx, Math.round(Number(v) || 0)));
  const parts = { novelty: cl(o.novelty, 30), value: cl(o.value, 25), cred: cl(o.cred, 20), community: cl(o.community, 15), spread: cl(o.spread, 10) };
  const total = parts.novelty + parts.value + parts.cred + parts.community + parts.spread;
  return { total, grade: narrGradeOf(total), parts, tags: (o.tags || []).slice(0, 3).map(String), story: String(o.story || '').slice(0, 200), evidence: (o.evidence || []).slice(0, 5).map(String), at: now() };
}
async function narrativeAlert(c, P, links) {
  const n = P.narr;
  if (!n) return;
  let kind = '', stageTo = 0;
  if (n.grade === 'A' && (P.narrStage || 0) < 2) { kind = '叙事A级·重点提醒'; stageTo = 2; }
  else if (n.grade === 'B' && (P.narrStage || 0) < 1) { kind = '叙事B级·观察'; stageTo = 1; }
  else if ((P.narrStage || 0) >= 2 && (P.narrStage || 0) < 3 && n.total >= (P.narrAlertScore || 0) + 10) { kind = '叙事进展'; stageTo = 3; }
  if (!kind) return;
  if ((P.narrTries || 0) >= 5 || now() < (P.narrTryAt || 0)) return;
  const star = kind.includes('A级') || kind === '叙事进展' ? '🌐⭐' : '🌐';
  const delivered = await tg(`${star} ${kind}：${P.name || ''}（叙事评分 ${n.total}/100，${n.grade} 级）\n合约：${c}（https://bscscan.com/address/${c}）\n参与增长：${surgeText(P) || '—'}\n项目讲什么：${n.story || '官网未说清'}\n五维：新颖 ${n.parts.novelty}/30｜价值 ${n.parts.value}/25｜可信 ${n.parts.cred}/20｜社区 ${n.parts.community}/15｜传播 ${n.parts.spread}/10\n证据：${n.evidence.join('；')}\n概念：${n.tags.join('、') || '—'}\n官网：${links.site}${links.x ? '\nX：' + links.x + (links.xVerified ? '（官网互链已确认）' : '（归属未确认）') : ''}${links.github ? '\nGitHub：' + links.github : ''}\n注：叙事分只代表故事与证据，不代表合约安全或投资价值，铸造仍走原审核`);
  P.narrTries = (P.narrTries || 0) + 1;
  if (delivered) { P.narrStage = stageTo; P.narrAlertScore = n.total; P.narrTries = 0; P.narrTryAt = 0; }
  else P.narrTryAt = now() + 1800e3;
  save();
}
const narrSending = new Set();
async function narrativeEval(c, P) {
  if (narrSending.has(c)) return;
  narrSending.add(c);
  try { await narrativeEvalInner(c, P); } finally { narrSending.delete(c); }
}
async function narrativeEvalInner(c, P) {
  if (!NARR()) return;
  if (P.narrAt && now() - P.narrAt < 6 * 3600e3) return;
  const links = await discoverLinks(c, P).catch(() => null);
  if (!links?.site) { P.narrState = '待验证（未找到官网）'; P.narrAt = now(); save(); return; }
  const got = await fetchSiteText(links.site);
  if (!got?.text || got.text.length < 80) { P.narrState = '待验证（官网抓不到正文）'; P.narrAt = now(); save(); return; }
  links.xVerified = !!(links.x && got.html.includes(xHandle(links.x)));
  const res = await aiNarrative(P, links, got.text).catch(() => null);
  if (!res) return; // AI 失败不落状态，下轮重试
  P.narr = res; P.narrState = ''; P.narrAt = now(); save();
  await narrativeAlert(c, P, links);
}
function tagCounts(track, sinceMs) {
  const out = {};
  for (const P of Object.values(track || {})) {
    if (!P.narr || now() - (P.narr.at || 0) > sinceMs) continue;
    for (const t of P.narr.tags || []) { out[t] = out[t] || { n: 0, proven: 0 }; out[t].n++; if (P.innoGrade === 'A' || P.innoGrade === 'B') out[t].proven++; }
  }
  return out;
}
async function narrativeSweep() {
  if (!NARR()) return;
  let done = 0;
  for (const [c, P] of Object.entries(S.track)) {
    if (done >= 3) break; // 每轮最多评 3 个，控成本与抓取礼貌
    try {
      if (now() - (P.at || 0) > 3 * 86400e3) continue;
      if (P.narrAt && now() - P.narrAt < 6 * 3600e3) continue;
      await narrativeEval(c, P);
      done++;
    } catch {}
  }
  // 叙事方向聚类：24h 内同概念 ≥3 个项目且未报过
  S.narrClusters = S.narrClusters || {};
  const counts = tagCounts(S.track, 86400e3);
  for (const [tag, v] of Object.entries(counts)) {
    if (v.n >= 3 && now() - (S.narrClusters[tag] || 0) > 86400e3) {
      S.narrClusters[tag] = now(); save();
      await tg(`🌐 新叙事方向：「${tag}」\n过去 24 小时发现 ${v.n} 个项目在讲这个概念，其中 ${v.proven} 个有独立技术实现证据（技术创新 B 级以上）。发「叙事」看各项目评分`);
    }
  }
}

const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
const tpFrac = (x, cost) => (cost > 0 ? Math.min(1, (1 + OUR.tpProfit) / x) : 0.5);

// ---------- 持仓：自动止盈 + 倍数/流动性信号 ----------
async function dexPrice(addr) {
  try {
    const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + addr, { signal: AbortSignal.timeout(8000) })).json();
    const ps = (j.pairs || []).filter((p) => p.chainId === 'bsc' && LC(p.baseToken?.address) === LC(addr) && (p.liquidity?.usd || 0) > 50);
    if (!ps.length) return null;
    ps.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return { px: Number(ps[0].priceUsd) || 0, liq: ps[0].liquidity?.usd || 0, pair: LC(ps[0].pairAddress) };
  } catch { return null; }
}
async function holdWatch() {
  for (const t of S.hold) {
    try {
      const bal = big(await call(t.addr, '0x70a08231' + wa(t.only)));
      if (bal === 0n) continue;
      const d = await dexPrice(t.addr);
      if (!d || !d.px) continue;
      t.flags = t.flags || {};
      // 免费币基准价：头 3 次读价取中位数锁定，避开开池头几分钟的乱价；锁定前不算倍数、不触发止盈
      if (!(t.cost > 0) && !t.baseLocked) {
        t.pxHist = t.pxHist || [];
        t.pxHist.push(d.px);
        if (t.pxHist.length >= 3) { t.openPx = median(t.pxHist.slice(0, 3)); t.baseLocked = 1; }
        save();
      }
      const base = t.cost > 0 ? t.cost : (t.baseLocked ? t.openPx : 0);
      const x = base ? d.px / base : 0;
      if (x > 0) t.peak = Math.max(t.peak || 0, x);
      const dec = Number(big(await call(t.addr, '0x313ce567')) || 18n);
      const value = (Number(bal) / 10 ** dec) * d.px; // 持仓市值（U）
      // 自动止盈：3 倍卖出回本+50% 利润；高点（≥2 倍）回落 40% 全卖，连续 2 次确认防假摔
      if (value >= 0.3 && now() >= (t.tpRetryAt || 0)) {
        if (!t.flags.tp3 && x >= OUR.tpX) {
          const frac = tpFrac(x, t.cost);
          const ok = await autoSellFrac(t, frac, `到 ${x.toFixed(1)} 倍，卖出回本+${Math.round(OUR.tpProfit * 100)}% 利润`);
          if (ok) { t.flags.tp3 = 1; save(); } else { t.tpRetryAt = now() + 300e3; save(); }
        } else if (t.peak >= 2 && x <= t.peak * (1 - OUR.tpCrash)) {
          t.crashHit = (t.crashHit || 0) + 1; save();
          if (t.crashHit >= 2) {
            const ok = await autoSellFrac(t, 1, `从高点回落 ${Math.round(OUR.tpCrash * 100)}%（高点 ${t.peak.toFixed(1)} 倍，现 ${x.toFixed(1)} 倍），全部卖出`);
            if (!ok) { t.tpRetryAt = now() + 300e3; t.crashHit = 0; save(); }
          }
        } else t.crashHit = 0;
      }
      if (!S.hold.includes(t)) continue; // 已全卖出并移出追踪
      for (const m of [5, 10, 20]) {
        if (x >= m && !t.flags['x' + m]) { t.flags['x' + m] = 1; save(); await tg(`🚀 ${t.sym} 已涨到 ${m} 倍（现价约 $${d.px}，池子 $${Math.round(d.liq)}）\n${t.addr}\n剩余仓位由自动止盈盯着；想提前卖在 TG 回「卖 ${t.sym}」或主聊天找我`); }
      }
      if (d.liq < 200 && !t.flags.drain) { t.flags.drain = 1; save(); await tg(`⚠️ ${t.sym} 池子流动性只剩 $${Math.round(d.liq)}，可能快抽干\n${t.addr}`); }
    } catch {}
  }
}

// ---------- TG 指令：查余额/持仓；卖出两步确认 ----------
async function tgPoll() {
  if (!TG) return;
  try {
    const j = await tgApi('getUpdates', { timeout: 0, offset: S.tgOffset || 0 }, 8000);
    for (const u of j?.result || []) {
      S.tgOffset = u.update_id + 1;
      const m = u.message;
      if (!m?.text || String(m.chat?.id) !== String(TG.chat)) continue;
      if (now() - m.date * 1000 > 120e3) continue; // 只认 2 分钟内的新消息
      handleTgCmd(m.text.trim()).catch(() => {});
    }
    save();
  } catch {}
}
async function handleTgCmd(text) {
  if (text === '余额') {
    const out = [];
    for (const W of WALLETS) {
      const b = Number(big(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
      const u = Number(big(await call(USDT, '0x70a08231' + wa(W.addr)))) / 1e18;
      out.push(`[${W.name}] ${W.addr}\nBNB ${b.toFixed(5)}，USDT ${u.toFixed(2)}`);
    }
    await tg(out.join('\n'));
    return;
  }
  if (text === '持仓') {
    if (!S.hold.length) { await tg('目前没有追踪中的持仓'); return; }
    const lines = [];
    for (const t of S.hold.slice(0, 20)) {
      const bal = big(await call(t.addr, '0x70a08231' + wa(t.only)));
      if (bal === 0n) continue;
      const d = await dexPrice(t.addr);
      lines.push(`${t.sym} ${t.addr}${d?.px ? ` 现价 $${d.px}` : ''}`);
    }
    await tg(lines.length ? lines.join('\n') : '追踪中的持仓都已清零');
    return;
  }
  if (text === '创新') {
    const list = Object.entries(S.track).filter(([, P]) => P.innovative && now() - (P.at || 0) < 7 * 86400e3);
    if (!list.length) { await tg('近 7 天还没有圈出的创新项目'); return; }
    const lines = list.map(([c, P]) => `⭐ ${P.name || c.slice(0, 10)}｜${P.innoGrade || ''} 级 ${P.innovative}/90｜裁决：${P.verdict?.s || '未定'}${P.verdict?.why ? '（' + P.verdict.why + '）' : ''}\n${c}`);
    await tg('圈出的创新项目：\n' + lines.join('\n'));
    return;
  }
  if (text === '叙事') {
    const list = Object.entries(S.track).filter(([, P]) => P.narr && now() - (P.at || 0) < 7 * 86400e3).sort((a, b) => (b[1].narr.total || 0) - (a[1].narr.total || 0));
    const pending = Object.values(S.track).filter((P) => P.narrState && now() - (P.at || 0) < 3 * 86400e3).length;
    if (!list.length) { await tg('近 7 天还没有叙事评分' + (pending ? `（${pending} 个项目待验证）` : '')); return; }
    const lines = list.slice(0, 15).map(([c, P]) => `🌐 ${P.name || c.slice(0, 10)}｜叙事 ${P.narr.total}/100 ${P.narr.grade} 级｜概念：${(P.narr.tags || []).join('、') || '—'}｜技术 ${P.innoGrade || '—'} 级\n${P.links?.site || c}`);
    await tg('叙事评分（近 7 天）：\n' + lines.join('\n') + (pending ? `\n另有 ${pending} 个项目待验证（无官网/抓不到）` : ''));
    return;
  }
  if (text === '项目') {
    const list = Object.entries(S.track).filter(([, P]) => now() - (P.at || 0) < 3 * 86400e3);
    if (!list.length) { await tg('近 3 天没有追踪中的项目'); return; }
    list.sort((a, b) => (b[1].innovative || 0) - (a[1].innovative || 0) || (b[1].at || 0) - (a[1].at || 0));
    const lines = list.slice(0, 15).map(([c, P]) => `${P.innovative ? '⭐ ' : ''}${P.verdict?.s || '未定'}｜${P.name || c.slice(0, 10)}｜${P.verdict?.why || '还没出裁决'}\n${c}`);
    await tg('近 3 天项目裁决（⭐ = 创新候选）：\n' + lines.join('\n'));
    return;
  }
  const sellM = text.match(/^卖\s+(\S+)(?:\s+(一半|全部))?$/);
  const confM = text.match(/^确认卖\s+(\S+)(?:\s+(一半|全部))?$/);
  if (sellM && !confM) {
    const key = sellM[1];
    const tok = resolveSell(key);
    if (tok.err) { await tg(tok.err); return; }
    S.tgSellPend = { addr: tok.t.addr, sym: tok.t.sym, half: sellM[2] === '一半', at: now() };
    save();
    await tg(`将卖出 ${tok.t.sym}（${tok.t.addr}）${sellM[2] === '一半' ? ' 一半' : ' 全部'}，市价单、实际到账以执行为准。\n120 秒内回「确认卖 ${key}${sellM[2] === '一半' ? ' 一半' : ''}」才执行，超时作废`);
    return;
  }
  if (confM) {
    const pend = S.tgSellPend;
    if (!pend || now() - pend.at > 120e3) { await tg('没有待确认的卖出（或已超时），请重新发「卖 …」'); return; }
    const tok = resolveSell(confM[1]);
    if (tok.err) { await tg(tok.err); return; }
    if (tok.t.addr !== pend.addr) { await tg('待确认的项目对不上，已作废'); S.tgSellPend = null; save(); return; }
    S.tgSellPend = null; save();
    await execSell(tok.t, confM[2] === '一半' || pend.half);
    return;
  }
}
function resolveSell(key) {
  const k = LC(key);
  const byAddr = S.hold.find((t) => t.addr === k);
  if (byAddr) return { t: byAddr };
  if (/^0x[0-9a-f]{40}$/.test(k)) return { err: '这个合约不在持仓追踪里：' + key };
  const same = S.hold.filter((t) => LC(t.sym) === k);
  if (same.length > 1) return { err: `有 ${same.length} 个同名币 ${key}，按名卖会卖错，请改发合约地址` };
  if (same.length === 1) return { t: same[0] };
  return { err: '持仓里找不到：' + key };
}
async function execSell(t, half) {
  const W = WALLETS.find((x) => x.addr === t.only) || WALLETS[0];
  const bal = big(await call(t.addr, '0x70a08231' + wa(W.addr)));
  if (bal === 0n) { await tg(`${t.sym} 余额为 0，没卖`); return; }
  const dec = Number(big(await call(t.addr, '0x313ce567')) || 18n);
  const amt = half ? bal / 2n : bal;
  const qty = (Number(amt) / 10 ** dec).toFixed(Math.min(dec, 8));
  const b0 = big(await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x'));
  const r = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty, '--fromToken', t.addr, '--toToken', NATIVE]);
  if (!r.j?.success) { await tg(`卖 ${t.sym} 失败：` + (r.j?.error?.message || r.t).slice(0, 120)); return; }
  await sleep(4000);
  const balAfter = big(await call(t.addr, '0x70a08231' + wa(W.addr)));
  if (bal - balAfter < (amt * 95n) / 100n) { await tg(`⚠️ 卖 ${t.sym}：baw 报成功，但链上代币余额没有减少（可能未成交），未登记卖出，请人工核对\n订单 ${r.j.data?.orderId || r.j.data?.txHash || ''}`); return; }
  const b1 = big(await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x'));
  const got = Number(b1 - b0) / 1e18;
  await tg(`💰 已卖出 ${t.sym} ${qty}${half ? '（一半）' : ''}，换回约 ${got > 0 ? got.toFixed(5) : '?'} BNB（链上余额已核对）\n订单 ${r.j.data?.orderId || r.j.data?.txHash || ''}`);
  if (!half) { S.hold = S.hold.filter((x) => !(x.addr === t.addr && x.only === t.only)); save(); }
}
async function autoSellFrac(t, frac, why) {
  const W = WALLETS.find((x) => x.addr === t.only) || WALLETS[0];
  const bal = big(await call(t.addr, '0x70a08231' + wa(W.addr)));
  if (bal === 0n) { S.hold = S.hold.filter((x) => !(x.addr === t.addr && x.only === t.only)); save(); return true; }
  const dec = Number(big(await call(t.addr, '0x313ce567')) || 18n);
  const amt = frac >= 1 ? bal : (bal * BigInt(Math.round(frac * 10000))) / 10000n;
  if (amt === 0n) return false;
  const qty = (Number(amt) / 10 ** dec).toFixed(Math.min(dec, 8));
  const b0 = big(await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x'));
  const r = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty, '--fromToken', t.addr, '--toToken', NATIVE]);
  if (!r.j?.success) { await tg(`自动止盈卖 ${t.sym} 失败（${why}）：` + (r.j?.error?.message || r.t).slice(0, 120) + '\n5 分钟后重试'); return false; }
  await sleep(4000);
  const balAfter = big(await call(t.addr, '0x70a08231' + wa(W.addr)));
  if (bal - balAfter < (amt * 95n) / 100n) { await tg(`⚠️ 自动止盈卖 ${t.sym}：baw 报成功，但链上代币余额没有减少，未登记卖出，稍后重试\n订单 ${r.j.data?.orderId || r.j.data?.txHash || ''}`); return false; }
  const b1 = big(await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x'));
  const got = Number(b1 - b0) / 1e18;
  await tg(`💰 自动止盈：${t.sym} ${why}\n卖出 ${qty}，换回约 ${got > 0 ? got.toFixed(5) : '?'} BNB（链上余额已核对）\n订单 ${r.j.data?.orderId || r.j.data?.txHash || ''}`);
  if (frac >= 1) { S.hold = S.hold.filter((x) => !(x.addr === t.addr && x.only === t.only)); save(); }
  return true;
}

// ---------- 登录状态巡检（baw 会话过期提醒） ----------
let loginWarnAt = 0;
async function loginCheck() {
  try {
    const r = await ME.baw(['wallet', 'status'], 30000);
    const okLogin = /CONNECTED|Logged in/i.test(r.t || '') || r.j?.data?.status === 'CONNECTED';
    if (!okLogin && now() - loginWarnAt > 6 * 3600e3) {
      loginWarnAt = now();
      if (TG) await tg('⚠️ 服务器上 baw 登录已失效，自动打暂停。需要重新跑 login 并用币安 App 确认');
      log('baw 登录失效');
    }
  } catch {}
}

// ---------- 主循环 ----------
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e?.message || e)));
async function tickBlocks() {
  try {
    const head = Number(BigInt((await rpc('eth_blockNumber', [])) || '0x0'));
    if (!S.lastBlock) { S.lastBlock = head; save(); return; }
    if (head > S.lastBlock) {
      const to = Math.min(head, S.lastBlock + 60);
      const failed = await scanBlocks(S.lastBlock + 1, to);
      S.lastBlock = to;
      if (failed.length) S.gaps = [...new Set([...(S.gaps || []), ...failed])].slice(-500);
      save();
    }
  } catch (e) { if (now() - (tickBlocks.lastLog || 0) > 30000) { tickBlocks.lastLog = now(); log('tickBlocks ' + e.message); } }
}
async function gapRetry() {
  // 补扫之前失败的区块（取块/取回执失败记下的缺口），扫过一块删一块
  if (!S.gaps?.length) return;
  for (const b of S.gaps.slice(0, 20)) {
    const failed = await scanBlocks(b, b).catch(() => [b]);
    if (!failed.length) { S.gaps = S.gaps.filter((x) => x !== b); save(); }
  }
}
function runSelfTest() {
  const eq = (a, b, name) => { if (a !== b) { console.error(`SELFTEST FAIL ${name}: ${a} !== ${b}`); process.exitCode = 1; } else console.log('ok ' + name); };
  const ok = (v, name) => eq(!!v, true, name);
  const toxic = auditFlags('contract X { function kill() public { selfdestruct(payable(msg.sender)); } function setBlack(address a) external onlyOwner {} }');
  ok(toxic.hard.length >= 2, 'audit toxic -> hard');
  const benign = auditFlags('contract Y { function mint(uint n) external onlyOwner {} }');
  eq(benign.hard.length, 0, 'audit owner-mint -> no hard');
  ok(benign.soft.length >= 1, 'audit owner-mint -> soft');
  eq(tpFrac(3, 10), 0.5, 'tpFrac 3x paid = 0.5');
  eq(tpFrac(4, 10), 0.375, 'tpFrac 4x paid = 0.375');
  eq(tpFrac(3, 0), 0.5, 'tpFrac free = 0.5');
  eq(tpFrac(1.5, 10), 1, 'tpFrac caps at 1');
  eq(median([1, 3, 2]), 2, 'median');
  eq(median([0.5, 9, 0.7]), 0.7, 'median spike-resistant');
  eq(parseState('not json'), null, 'parseState garbage -> null');
  eq(parseState('{"a":1}').a, 1, 'parseState ok');
  ok(/revert/i.test('execution reverted: quota'), 'revert detect');
  eq(/revert/i.test('network timeout'), false, 'timeout is not revert');
  eq(mintClosed({ done: { w: 'free' }, count: { w: 3 } }, { name: 'w' }), false, 'mintClosed free+3 open');
  eq(mintClosed({ done: { w: 'free' }, count: { w: 10 } }, { name: 'w' }), true, 'mintClosed 10 closed');
  eq(mintClosed({ done: { w: 'fail' }, count: { w: 1 } }, { name: 'w' }), true, 'mintClosed fail closed');
  eq(effAgents({ agents: 100, agentBlocks: { 100: 60, 101: 40 } }), 6, 'effAgents bunched discount');
  eq(effAgents({ agents: 6, agentBlocks: { 1: 2, 2: 2, 3: 2 } }), 6, 'effAgents spread full');
  eq(effAgents({ agents: 42 }), 42, 'effAgents no-blocks fallback');
  eq(keccak256(Buffer.alloc(0)), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'keccak256 empty');
  eq(sigSel('transfer(address,uint256)'), 'a9059cbb', 'sigSel transfer');
  eq(sigSel('balanceOf(address)'), '70a08231', 'sigSel balanceOf');
  ok(KNOWN_SEL.has(sigSel('mint()')), 'mint() is a known selector');
  eq(mechFams('function stake(uint n) public {} function burn(uint n) public {}').length, 2, 'mechFams two families');
  eq(mechFams('function mint() public {}').length, 0, 'mechFams plain template none');
  eq(innoTrig({ grade: 'A' }), true, 'innoTrig grade A');
  eq(innoTrig({ grade: 'B' }), false, 'innoTrig grade B blocked');
  eq(gradeOf(65), 'A', 'gradeOf 65 = A');
  eq(gradeOf(64), 'B', 'gradeOf 64 = B');
  eq(gradeOf(40), 'B', 'gradeOf 40 = B');
  eq(gradeOf(39), 'C', 'gradeOf 39 = C');
  eq(Math.round(jaccard(['a', 'b'], ['b', 'c']) * 100), 33, 'jaccard 1/3');
  const histT = { '0xaaa': { name: 'Old', sels: ['aaaaaaaa', 'bbbbbbbb'], fams: ['质押'], srcHash: 'hx' } };
  const rc = compareHist(['aaaaaaaa', 'bbbbbbbb'], ['质押'], histT, '0xbbb', 'different');
  eq(Math.round(rc.sim * 100), 100, 'compareHist clone sim 100');
  eq(rc.firstSels.length, 0, 'compareHist clone no first-seen');
  const rn = compareHist(['cccccccc'], ['任务'], histT, '0xbbb', 'hz');
  eq(rn.firstSels.length, 1, 'compareHist new first-seen sel');
  eq(rn.firstFams[0], '任务', 'compareHist new first-seen fam');
  eq(Math.round(rn.sim * 100), 0, 'compareHist disjoint sim 0');
  const lu = extractUrls('site https://foo-protocol.xyz/ and x https://x.com/foo_protocol gh https://github.com/foo/bar end');
  eq(lu.site, 'https://foo-protocol.xyz/', 'extractUrls site');
  eq(lu.x, 'https://x.com/foo_protocol', 'extractUrls x');
  eq(lu.github, 'https://github.com/foo/bar', 'extractUrls github');
  eq(narrGradeOf(70), 'A', 'narrGradeOf 70 = A');
  eq(narrGradeOf(45), 'B', 'narrGradeOf 45 = B');
  eq(narrGradeOf(44), 'C', 'narrGradeOf 44 = C');
  const tc = tagCounts({ a: { narr: { at: now(), tags: ['Agent协作'] }, innoGrade: 'B' }, b: { narr: { at: now(), tags: ['Agent协作'] } } }, 86400e3);
  eq(tc['Agent协作'].n, 2, 'tagCounts n=2');
  eq(tc['Agent协作'].proven, 1, 'tagCounts proven=1');
  const sgP = { agents: 10, growth: [{ at: Date.now() - 1800e3, n: 4 }, { at: Date.now() - 300e3, n: 9 }] };
  eq(surgeText(sgP), '近 30 分钟 +6 个（现 10 个）', 'surgeText 30min delta');
  const lu2 = extractUrls('ref https://eips.ethereum.org/EIPS/eip-6093 and https://github.com/ethereum/solidity/blob/x and real https://agentlings.fun/ x https://x.com/agentlings');
  eq(lu2.site, 'https://agentlings.fun/', 'extractUrls denies eip/solidity links');
  eq(lu2.github, '', 'extractUrls denies ethereum github');
  eq(lu2.x, 'https://x.com/agentlings', 'extractUrls keeps real x');
  const lu3 = extractUrls('lib https://github.com/Brechtpd/base64/blob/e78/base64.sol and repo https://github.com/agentlings/protocol and post https://x.com/agentlings/status/12345');
  eq(lu3.github, 'https://github.com/agentlings/protocol', 'extractUrls github repo root only');
  eq(lu3.x, '', 'extractUrls x status link rejected');
  ok(deadLink(404) && deadLink(410) && !deadLink(200) && !deadLink(0) && !deadLink(403), 'deadLink only 404/410');
  ok(!hasPublicLinks({ site: '', x: '', github: '' }) && hasPublicLinks({ site: 'https://a.fun' }) && hasPublicLinks({ x: 'https://x.com/a' }) && hasPublicLinks({ github: 'https://github.com/a/b' }), 'hasPublicLinks any one is enough');
  eq(cuWeight('eth_call'), 26, 'cuWeight eth_call');
  eq(cuWeight('eth_getLogs'), 75, 'cuWeight eth_getLogs');
  eq(cuWeight('eth_somethingElse'), 20, 'cuWeight default');
  ok(CU_CAP === 9_000_000 && !rpcExhausted('https://example.invalid/nope'), 'rpc CU cap 90% of 10M');
  ok(rpcPools()[0] === PUBLIC_RPCS, 'rpc pools public first');
  console.log(process.exitCode ? 'SELFTEST FAILED' : 'SELFTEST ALL OK');
}
if (SELFTEST) runSelfTest();
else {
  log(`启动：钱包 ${WALLETS.map((x) => x.name).join('/')}，付费上限 ${OUR.paidMaxUsd}U，审核门 ${OUR.audit ? '开' : '关'}，止盈 ${OUR.tpX} 倍/回落 ${Math.round(OUR.tpCrash * 100)}%，推送 ${TG ? 'TG' : '未配置'}`);
  tickBlocks();
  setInterval(tickBlocks, 1000);
  setInterval(() => { gapRetry().catch(() => {}); }, 30000);
  setInterval(() => { paidSweep().catch(() => {}); }, 60000);
  setInterval(() => { innoSweep().catch(() => {}); }, 60000);
  setInterval(() => { narrativeSweep().catch(() => {}); }, 300000);
  setInterval(() => { noRefDigest().catch(() => {}); }, 6 * 3600e3);
  setInterval(() => { fastLane().catch(() => {}); }, 15000);
  setInterval(() => { holdWatch().catch(() => {}); }, 60000);
  setInterval(() => { tgPoll().catch(() => {}); }, 3000);
  setInterval(() => { loginCheck().catch(() => {}); }, 1800e3);
  setTimeout(() => { paidSweep().catch(() => {}); }, 8000);
  setTimeout(() => { innoSweep().catch(() => {}); }, 20000);
  setTimeout(() => { narrativeSweep().catch(() => {}); }, 60000);
}
