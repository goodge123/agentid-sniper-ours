// 登录 config.json 里第 N 个钱包（默认第 1 个）：node login.mjs 1
// 会打印登录链接，用该钱包的币安 App 打开确认（约 5 分钟内有效），脚本自己等确认结果。
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
const wc = CONFIG.wallets[(Number(process.argv[2]) || 1) - 1];
if (!wc) { console.error('找不到这个钱包'); process.exit(1); }
const run = (args, timeout = 60000) => new Promise((res) => {
  execFile('baw', [...args, '--json'], { timeout }, (e, so, se) => {
    const t = String(so || se || e?.message || '');
    let j = null;
    try { j = JSON.parse(t.slice(t.indexOf('{'))); } catch {}
    res({ t, j });
  });
});
const si = await run(['auth', 'signin']);
const d = si.j?.data;
if (!d?.qrCodeId) { console.log(si.t); process.exit(1); }
console.log(`\n[${wc.name}] 用手机打开这个链接确认登录：\n${d.urlForWeb}\n配对码：${d.pairingCode}\n等待确认中…`);
const v = await run(['auth', 'verify', '--qrCodeId', d.qrCodeId], 330000);
console.log(v.j?.data?.status === 'SUCCESS' ? '✅ 登录成功' : '❌ ' + v.t.slice(0, 300));
const st = await run(['wallet', 'status']);
console.log(st.t.slice(0, 400));
