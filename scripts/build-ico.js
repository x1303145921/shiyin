#!/usr/bin/env node
/**
 * 拾音图标 ICO 打包脚本（v4，2026-09-01）
 * 手写 ICO：ICONDIR + N×ICONDIRENTRY + 直接内嵌 PNG 字节（Vista+ 支持 PNG 压缩条目，256 尺寸宽高字段写 0）。
 * 零依赖。背景：ffmpeg ico muxer 多流 map 报错、png-to-ico 在 Node 22 有兼容问题 → 手写最稳。
 *
 * 用法：node scripts/build-ico.js <png目录> <输出.ico> [尺寸列表]
 *   例：node scripts/build-ico.js work-ico public/app-icon.ico 16,32,48,64,128,256
 *   约定：png 文件名为 <尺寸>.png（如 16.png、256.png）
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const outFile = process.argv[3];
const sizes = (process.argv[4] || '16,32,48,64,128,256').split(',').map(Number);
if (!dir || !outFile) { console.error('用法: node scripts/build-ico.js <png目录> <输出.ico> [尺寸列表]'); process.exit(1); }

// 读取每个尺寸的 PNG
const entries = [];
let offset = 6 + sizes.length * 16;
for (const size of sizes) {
  const p = path.join(dir, `${size}.png`);
  if (!fs.existsSync(p)) { console.error(`缺少 ${p}`); process.exit(1); }
  const buf = fs.readFileSync(p);
  entries.push({ size, buf, offset });
  offset += buf.length;
}

// ICONDIR: reserved(2) + type(2) + count(2)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);       // reserved
header.writeUInt16LE(1, 2);       // type = icon
header.writeUInt16LE(entries.length, 4);

// ICONDIRENTRY × N: width(1) height(1) colors(1) reserved(1) planes(2) bitcount(2) bytes(4) offset(4)
const chunks = [header];
for (const e of entries) {
  const ent = Buffer.alloc(16);
  ent.writeUInt8(e.size === 256 ? 0 : e.size, 0);   // width（256 写 0）
  ent.writeUInt8(e.size === 256 ? 0 : e.size, 1);   // height（256 写 0）
  ent.writeUInt8(0, 2);                             // palette
  ent.writeUInt8(0, 3);                             // reserved
  ent.writeUInt16LE(1, 4);                          // planes
  ent.writeUInt16LE(32, 6);                         // bitcount
  ent.writeUInt32LE(e.buf.length, 8);               // bytes in resource
  ent.writeUInt32LE(e.offset, 12);                  // offset
  chunks.push(ent);
}
for (const e of entries) chunks.push(e.buf);

const ico = Buffer.concat(chunks);
fs.writeFileSync(outFile, ico);
console.log(`ICO 已生成: ${outFile} (${ico.length} bytes, ${entries.length} 尺寸: ${sizes.join('/')})`);
