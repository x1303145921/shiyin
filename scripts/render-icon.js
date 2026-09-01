#!/usr/bin/env node
/**
 * 拾音图标渲染脚本（v4，2026-09-01）
 * 用 Edge headless + CDP 渲染 SVG 源稿为透明背景 PNG（RGB+Alpha）。
 * 零依赖：Node >= 21（全局 fetch / WebSocket）。
 *
 * 用法：
 *   node scripts/render-icon.js <源html路径> <输出png路径> [尺寸]
 *   例：node scripts/render-icon.js public/icon-source.html work-ico/full-512.png 512
 *
 * 背景：Edge CLI --screenshot 输出 rgb24（丢 alpha），透明背景会被实色化；
 * 必须走 CDP Emulation.setDefaultBackgroundColorOverride + Page.captureScreenshot。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = process.env.EDGE_PATH ||
  (fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe');
const PORT = 9333 + (process.pid % 500); // 多进程互不冲突

const src = process.argv[2];
const out = process.argv[3];
const size = parseInt(process.argv[4] || '512', 10);
if (!src || !out) {
  console.error('用法: node scripts/render-icon.js <源html> <输出png> [尺寸]');
  process.exit(1);
}
const srcAbs = path.resolve(src);
const outAbs = path.resolve(out);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitPort(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch (_) { /* not ready */ }
    await sleep(250);
  }
  throw new Error('Edge CDP 端口未就绪');
}

async function main() {
  const userData = path.join(os.tmpdir(), `shiyin-ico-${Date.now()}`);
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--window-size=512,512',
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    await waitPort();
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到页面 target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    const events = [];

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    // 强制 viewport 为正方形（headless 窗口会被系统最小尺寸钳制，导致截图非方、SVG 被裁）
    await send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false
    });
    await send('Page.navigate', { url: 'file:///' + srcAbs.replace(/\\/g, '/') });
    // 等 load 事件
    for (let i = 0; i < 40; i++) {
      if (events.some((e) => e.method === 'Page.loadEventFired')) break;
      await sleep(200);
    }
    await sleep(300); // 等 SVG 绘制完成
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (!shot || !shot.data) throw new Error('截图返回空');
    fs.writeFileSync(outAbs, Buffer.from(shot.data, 'base64'));
    console.log(`已渲染: ${outAbs} (${size}x${size}, ${fs.statSync(outAbs).size} bytes)`);
    ws.close();
  } finally {
    edge.kill();
    await sleep(300);
  }
}

main().catch((e) => { console.error('渲染失败:', e.message); process.exit(1); });
