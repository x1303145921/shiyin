#!/usr/bin/env node
/**
 * 拾音 HTML 内联 JS 语法检查
 * 提取 public/index.html 中 <script> 块（非 src 引用），用 vm 编译验证语法。
 * 用法：node scripts/check-html.js [文件...]，默认检查 public/index.html
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = process.argv.slice(2);
if (files.length === 0) files.push('public/index.html');

let failed = 0;
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`❌ 文件不存在: ${file}`);
    failed++;
    continue;
  }
  const html = fs.readFileSync(file, 'utf8');
  // 匹配内联 <script>（排除带 src 的）
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, count = 0;
  while ((m = re.exec(html)) !== null) {
    const code = m[1];
    try {
      new vm.Script(code, { filename: `${file}#inline-${++count}` });
    } catch (e) {
      console.error(`❌ ${file} 内联脚本 #${count} 语法错误: ${e.message}`);
      failed++;
    }
  }
  console.log(`✅ ${file}: ${count} 个内联脚本语法检查通过`);
}
process.exit(failed ? 1 : 0);
