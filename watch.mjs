// AgentID Sniper
// Agent ID 专属铸造监控/自动铸造工具：
// 逐块扫 BSC 发现项目 -> 免费实测可打才自动打（合约审核门把关）-> 收费只出分析等确认。
// 持仓自动止盈：3 倍卖出回本+50% 利润，从高点回落 40% 全卖（用户 2026-11-01 定）。
// 执行统一走币安 Agentic Wallet（baw），本程序不碰私钥。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
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
let S = {};
try { S = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}
S.track = S.track || {};       // 追踪中的合约： addr -> {name, at, agents, progress, done:{wallet:status}, kind, ...}
S.hold = S.hold || [];         // 持仓： {sym, addr, cost(USD), only, openPx, flags:{}}
S.black = S.black || {};       // 部署者黑名单： addr -> {why, at}
S.mintCnt = S.mintCnt || {};   // 每日免费打计数
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { const t = STATE_FILE + '.tmp'; writeFileSync(t, JSON.stringify(S)); renameSync(t, STATE_FILE); } catch {}
  }, 800);
}
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { timeZone: CONFIG.timeZone || 'Asia/Shanghai', hour12: false })}] ${msg}`;
  console.log(line);
}

// 单实例锁：已有同目录实例在跑就退出（防双开重复打）
const LOCK_FILE = join(DIR, 'data', 'lock');
try {
  if (existsSync(LOCK_FILE)) {
    const pid = Number(readFileSync(LOCK_FILE, 'utf8'));
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); console.error('已有实例在跑 pid=' + pid); process.exit(1); } catch {} }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
} catch {}

// ---------- RPC：多节点轮替，第一个成功答复为准；坏节点短暂冷却 ----------
const RPCS = Array.isArray(CONFIG.rpcs) && CONFIG.rpcs.length ? CONFIG.rpcs : [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc.publicnode.com',
  'https://bsc.drpc.org',
];
let ri = 0;
const rpcBad = new Map();
const rpcFailN = new Map();
async function rpc(method, params) {
  let last = null;
  const order = RPCS.map((_, i) => RPCS[(ri + i) % RPCS.length]);
  const avail = order.filter((u) => (rpcBad.get(u) || 0) <= now());
  // 全在冷却时也至少试最早解禁的一个，绝不整批放弃（否则一波限流就永久假死）
  const tryList = avail.length ? avail : [order.reduce((a, b) => ((rpcBad.get(a) || 0) <= (rpcBad.get(b) || 0) ? a : b))];
  for (const u of tryList) {
    try {
      const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      rpcBad.delete(u); rpcFailN.delete(u);
      ri = RPCS.indexOf(u);
      return j.result;
    } catch (e) {
      last = e;
      const n = (rpcFailN.get(u) || 0) + 1;
      if (n >= 2) { rpcBad.set(u, now() + 10000); rpcFailN.set(u, 0); } else rpcFailN.set(u, n);
    }
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
if (!WALLETS.length) { console.error('config.json 里没有 wallets'); process.exit(1); }
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
async function tg(text, toGroup = false) {
  log('TG: ' + text.replace(/\n/g, ' | '));
  qqBridge(text);
  if (!TG) return;
  const chat = toGroup && TG.group ? TG.group : TG.chat;
  try {
    await fetch(`https://api.telegram.org/bot${TG.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) });
  } catch {}
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
  for (let b = from; b <= to; b++) {
    const blk = await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), true]).catch(() => null);
    if (!blk) continue;
    for (const tx of blk.transactions || []) {
      try {
        const to = tx.to ? LC(tx.to) : '';
        const fromA = LC(tx.from);
        if (!to) {
          const rc = await rpc('eth_getTransactionReceipt', [tx.hash]).catch(() => null);
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
            if (!P.agentSet[fromA]) { P.agentSet[fromA] = 1; P.agents = Object.keys(P.agentSet).length; save(); }
          });
        }
      } catch {}
    }
  }
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

// ---------- 免费执行：时机门槛 -> 审核门 -> gas -> baw 预览 -> 执行 ----------
const mintQueues = new Map();
const mintQueued = new Set();
function queueMint(c, found, W) {
  const key = c + '|' + W.name;
  if (mintQueued.has(key)) return;
  const P = S.track[c];
  if (P?.done?.[W.name]) return;
  mintQueued.add(key);
  const prev = mintQueues.get(W.name) || Promise.resolve();
  const job = prev.then(() => autoMintMax(c, found, W)).catch((e) => log(`铸造异常 ${c} ${e.message}`)).finally(() => mintQueued.delete(key));
  mintQueues.set(W.name, job);
}
async function autoMintMax(c, found, W) {
  let n = 0;
  let first = '';
  while (n < 10) {
    const m = await autoMint(c, found, W);
    if (!first) first = m;
    if (!m.startsWith('🤖')) break;
    n++;
    if (n >= 10) break;
    // 连打条件：同一 calldata 零金额再试还过才继续（付费/限额自然会失败停下）
    await sleep(5000);
    try { await rpc('eth_call', [{ from: W.addr, to: c, data: found.data, value: '0x0' }, 'latest']); } catch { break; }
  }
  return n > 1 ? first + `\n（同一钱包共打了 ${n} 份）` : first;
}
function todayKey() { return new Date().toDateString(); }
async function autoMint(c, found, W) {
  const P = S.track[c] || (S.track[c] = { at: now(), name: '', done: {}, agents: 0 });
  if (P.done[W.name]) return '✅ 这个钱包已经打过';
  // 时机门槛
  const fp = await readProgress(c);
  if (fp != null && fp < OUR.goPct) { P.waitHot = 1; save(); return `⏸ 进度 ${Math.floor(fp * 100)}%，未到 ${Math.round(OUR.goPct * 100)}%，先追踪`; }
  if (fp == null) {
    if ((P.agents || 0) < OUR.crowdGo) { P.waitHot = 1; save(); return `⏸ 读不到进度，目前 ${P.agents || 0} 个 Agent ID 钱包在打，要 ${OUR.crowdGo} 个才打`; }
    const tk = await tokenOf(c).catch(() => c);
    if (await poolOpen(tk)) return '⏸ 已开池，不铸（铸价通常贵过市价）';
  }
  // 合约审核门
  let note = '';
  if (OUR.audit) {
    const au = await auditContract(c);
    if (au.verdict === 'flag') {
      S.auditNoted = S.auditNoted || {};
      if (!S.auditNoted[c]) { S.auditNoted[c] = 1; save(); await tg(`🛡 合约审核拦截（免费未打）：${P.name || ''}\n${c}\n红旗：${au.hard.join('、')}${au.impl ? `\n代理实现合约：${au.impl}` : ''}\n源码已验证但有以上风险，按 A 档规矩没有打；你说打才打\nhttps://bscscan.com/address/${c}`); }
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
        if (!S.auditNoted[gk]) { S.auditNoted[gk] = 1; save(); await tg(`🛡 gas 估算异常拦截（免费未打）：${P.name || ''}\n${c}\n估算约 ${Number(BigInt(ge)).toLocaleString('en-US')}，超过拦截线 ${OUR.gasCap.toLocaleString('en-US')}\nhttps://bscscan.com/address/${c}`); }
        return `🛡 gas 估算异常（约 ${Number(BigInt(ge)).toLocaleString('en-US')}）`;
      }
    } catch {}
  }
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
  if (!p.j?.success || !rid) { P.done[W.name] = 'fail'; save(); return '❌ 预演失败，没有打：' + (p.j?.error?.message || '').slice(0, 120); }
  if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) { P.done[W.name] = 'fail'; save(); return '⚠️ 预演显示有授权变化，没有打'; }
  const mine = (sim?.balanceChanges || []).filter((b) => LC(b.owner) === W.addr);
  const losing = mine.filter((b) => Number(b.change) < 0);
  if (losing.length) { P.done[W.name] = 'fail'; save(); return '⚠️ 预演显示会扣你的资产，没有打'; }
  const gaining = mine.some((b) => Number(b.change) > 0 || /Erc721|Erc1155/i.test(b.tokenType || ''));
  if (!gaining) { P.done[W.name] = 'fail'; save(); return '⚪ 预演显示拿不到东西，没有打'; }
  const x = await W.baw(['contract-call', 'execute', '--requestId', rid]);
  if (!x.j && /timed? ?out|ETIMEDOUT|killed/i.test(x.t || '')) { P.done[W.name] = 'unknown'; save(); await tg(`⚠️ 免费铸造送出结果不明（超时），先不重打：${P.name || ''}\n${c}`); return '⚠️ 送出结果不明'; }
  if (!x.j?.success) { P.done[W.name] = 'fail'; save(); return '❌ 送出失败：' + (x.j?.error?.message || x.t).slice(0, 120); }
  P.done[W.name] = 'free';
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
  const msg = `🆓 打了免费项目：${P.name || c.slice(0, 10)}（${W.name}）${got ? '\n到账：' + got : ''}\n${c}${note}\n交易 ${x.j.data?.txHash || x.j.data?.orderId || ''}`;
  await tg(msg);
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
async function analyzePaid(c, P) {
  const price = await bnbUsd().catch(() => 0);
  const kind = P.kind || 'gen';
  let unitTxt = '单价读不到，以执行预览为准', maxShares = -1, costTxt = '';
  try {
    if (kind === 'bnb') {
      const q = await call(c, '0x68bce8cd' + w(1));
      const u = q && q.length >= 66 ? Number(BigInt(q.slice(0, 66))) / 1e18 : 0;
      if (u > 0 && price > 0) { const per = u * 1.005 * price; maxShares = Math.max(0, Math.min(10, Math.floor(OUR.paidMaxUsd / per))); unitTxt = `约 ${u.toFixed(5)} BNB/份（约 ${per.toFixed(2)}U/份）`; costTxt = maxShares > 0 ? `按 ${OUR.paidMaxUsd}U 上限最多 ${maxShares} 份，总成本约 ${(per * maxShares).toFixed(2)}U` : '1 份就超过付费上限'; }
    } else if (kind === 'usdt') {
      const q = await call(c, '0x725c4058' + w(1));
      const u = q && q.length >= 66 ? Number(BigInt(q.slice(0, 66))) / 1e18 : 0;
      if (u > 0) { maxShares = Math.max(0, Math.min(10, Math.floor(OUR.paidMaxUsd / u))); unitTxt = `约 ${u.toFixed(2)} USDT/份`; costTxt = maxShares > 0 ? `按 ${OUR.paidMaxUsd}U 上限最多 ${maxShares} 份，总成本约 ${(u * maxShares).toFixed(2)}U` : '1 份就超过付费上限'; }
    }
  } catch {}
  const { sold, cap } = await readSoldCap(c).catch(() => ({ sold: null, cap: null }));
  const progress = await readProgress(c);
  const dep = P.deployer || '';
  const black = dep && S.black[dep] ? S.black[dep].why : '';
  const serial = dep && (S.devProjects?.[dep] || []).length >= 3 ? `（该部署者已发 ${(S.devProjects[dep]).length} 个项目）` : '';
  const rn = await riskNote(c).catch(() => '');
  const au = OUR.audit ? await auditContract(c).catch(() => ({ verdict: 'unverified', hard: [], soft: [] })) : { verdict: 'unverified', hard: [], soft: [] };
  const tk = await tokenOf(c).catch(() => c);
  const pool = await poolOpen(tk).catch(() => false);
  const agents = P.agents || 0;
  let verdict, reason;
  if (black) { verdict = '不打'; reason = `部署者在黑名单（${black}）`; }
  else if (maxShares === 0) { verdict = '不打'; reason = '单价超过付费上限'; }
  else if (au.verdict === 'flag') { verdict = '不打'; reason = '合约审核有红旗：' + au.hard.join('、'); }
  else if (agents > 0 && agents < 20) { verdict = '观望'; reason = `参与的 Agent ID 钱包只有 ${agents} 个，进度可信度低`; }
  else if (au.verdict === 'soft') { verdict = '观望'; reason = '合约审核有提示：' + au.soft.join('、'); }
  else if (rn) { verdict = '观望'; reason = '合约留有开发者权限，见下方提醒'; }
  else if (pool) { verdict = '观望'; reason = '已经开池，铸造价可能不如市价，要先比价'; }
  else { verdict = '可以打'; reason = '有退款保本、进度过门槛、参与人数够、未见合约风险'; }
  log(`付费分析 ${P.name || c}：${verdict}——${reason}`);
  await tg(`🔔 付费项目分析：${P.name || c.slice(0, 10)}（进度 ${progress != null ? Math.round(progress * 100) + '%' : '读不到'}${sold != null && cap ? `，已售 ${sold}/${cap}` : ''}）
合约：${c}
类型：${{ bnb: 'BNB 报价型', usdt: 'USDT 份额型', gen: 'NFT 单价型' }[kind] || kind}
单价：${unitTxt}${costTxt ? `\n成本：${costTxt}` : ''}
参与：Agent ID 钱包约 ${agents} 个${dep ? `\n部署者：${dep}${black ? '（黑名单）' : ''}${serial}` : ''}
保本：合约有退款函数 ✓${pool ? '\n状态：已开池' : ''}${rn}
合约审核：${au.verdict === 'clean' ? '源码已验证、未见红旗' : au.verdict === 'flag' ? '源码已验证但有红旗：' + au.hard.join('、') : au.verdict === 'soft' ? '源码已验证，审核提示：' + au.soft.join('、') : '源码未验证'}
结论：${verdict}——${reason}
要打回主聊天告诉我打哪个、多少份，我先预览报总成本和每份到账，你确认了才执行；不回就不打`);
}
async function paidSweep() {
  for (const [c, P] of Object.entries(S.track)) {
    try {
      if (now() - (P.at || 0) > 3 * 86400e3) continue;
      if (WALLETS.every((W) => P.done?.[W.name])) continue;
      const fp = await readProgress(c);
      if (fp != null) P.progress = fp;
      // 免费的随时捡漏：能免费打就排队（执行链自带门槛）
      let freeFound = null;
      for (const W of WALLETS) {
        if (P.done?.[W.name]) continue;
        const ff = await findFree(W, c).catch(() => null);
        if (ff) { freeFound = true; queueMint(c, ff, W); }
      }
      if (freeFound) continue;
      // 收费线
      if (!P.kind) P.kind = await classifyPaid(c).catch(() => 'gen');
      if (P.refundOk == null) { P.refundOk = (await hasRefund(c).catch(() => false)) ? 1 : 0; save(); }
      const gate = (fp != null && fp >= OUR.goPct) || (fp == null && (P.agents || 0) >= OUR.crowdGo);
      if (!gate) continue;
      if (!P.refundOk) {
        if (!P.noRefundLog) {
          P.noRefundLog = 1; save();
          await tg(`🔔 付费项目分析：${P.name || c.slice(0, 10)}（进度 ${fp != null ? Math.round(fp * 100) + '%' : '读不到'}）\n合约：${c}\n结论：不打——付费项目但合约没有退款（保本）机制\n要破例打，回主聊天告诉我，我先预览报数你再确认`);
        }
        continue;
      }
      if (!P.reported) { P.reported = 1; save(); await analyzePaid(c, P).catch((e) => log('analyzePaid ' + e.message)); }
    } catch (e) { log(`paidSweep ${c} ${e.message}`); }
  }
}
async function fastLane() {
  // 临近门槛的追踪项加快检查（15 秒一轮）：进度跨过门槛就立刻排队打
  for (const [c, P] of Object.entries(S.track)) {
    try {
      if (!P.waitHot || WALLETS.every((W) => P.done?.[W.name])) continue;
      const fp = await readProgress(c);
      if (fp != null) P.progress = fp;
      if (fp != null && fp >= 0.45) {
        for (const W of WALLETS) {
          if (P.done?.[W.name]) continue;
          const ff = await findFree(W, c).catch(() => null);
          if (ff) queueMint(c, ff, W);
        }
      }
    } catch {}
  }
}

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
      if (!t.openPx) { t.openPx = d.px; save(); }
      const base = t.cost > 0 ? t.cost : t.openPx;
      if (!base) continue;
      const x = d.px / base;
      t.peak = Math.max(t.peak || 0, x);
      const dec = Number(big(await call(t.addr, '0x313ce567')) || 18n);
      const value = (Number(bal) / 10 ** dec) * d.px; // 持仓市值（U）
      // 自动止盈：3 倍卖出回本+50% 利润；高点（≥2 倍）回落 40% 全卖，连续 2 次确认防假摔
      if (value >= 0.3 && now() >= (t.tpRetryAt || 0)) {
        if (!t.flags.tp3 && x >= OUR.tpX) {
          const frac = t.cost > 0 ? Math.min(1, (1 + OUR.tpProfit) / x) : 0.5;
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
    const j = await (await fetch(`https://api.telegram.org/bot${TG.token}/getUpdates?timeout=0&offset=${S.tgOffset || 0}`, { signal: AbortSignal.timeout(8000) })).json();
    for (const u of j.result || []) {
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
  const b1 = big(await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x'));
  const got = Number(b1 - b0) / 1e18;
  await tg(`💰 已卖出 ${t.sym} ${qty}${half ? '（一半）' : ''}，换回约 ${got > 0 ? got.toFixed(5) : '?'} BNB\n订单 ${r.j.data?.orderId || r.j.data?.txHash || ''}`);
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
  const b1 = big(await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x'));
  const got = Number(b1 - b0) / 1e18;
  await tg(`💰 自动止盈：${t.sym} ${why}\n卖出 ${qty}，换回约 ${got > 0 ? got.toFixed(5) : '?'} BNB\n订单 ${r.j.data?.orderId || r.j.data?.txHash || ''}`);
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
      await scanBlocks(S.lastBlock + 1, to);
      S.lastBlock = to;
      save();
    }
  } catch (e) { if (now() - (tickBlocks.lastLog || 0) > 30000) { tickBlocks.lastLog = now(); log('tickBlocks ' + e.message); } }
}
log(`启动：钱包 ${WALLETS.map((x) => x.name).join('/')}，付费上限 ${OUR.paidMaxUsd}U，审核门 ${OUR.audit ? '开' : '关'}，止盈 ${OUR.tpX} 倍/回落 ${Math.round(OUR.tpCrash * 100)}%，推送 ${TG ? 'TG' : '未配置'}`);
tickBlocks();
setInterval(tickBlocks, 1000);
setInterval(() => { paidSweep().catch(() => {}); }, 60000);
setInterval(() => { fastLane().catch(() => {}); }, 15000);
setInterval(() => { holdWatch().catch(() => {}); }, 60000);
setInterval(() => { tgPoll().catch(() => {}); }, 3000);
setInterval(() => { loginCheck().catch(() => {}); }, 1800e3);
setTimeout(() => { paidSweep().catch(() => {}); }, 8000);
