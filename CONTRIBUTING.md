# 贡献指南 · Contributing

欢迎为拾音（shiyin）贡献代码、文档或建议！

## 开发环境

- Node.js 18+（运行时）
- 现代浏览器（Edge / Chrome / Firefox）
- ffmpeg（可选，仅图标渲染/媒体处理链路需要）

## 本地开发

```bash
npm install          # 安装依赖
npm start            # 启动服务 → http://127.0.0.1:18900

# 语法检查
node --check server.js
node --check scripts/render-icon.js
node --check scripts/build-ico.js

# 重新渲染图标（修改 public/icon-source*.html 后）
node scripts/render-icon.js public/icon-source.html work-ico/full-512.png 512
node scripts/render-icon.js public/icon-source-mini.html work-ico/mini-512.png 512
# 缩放各尺寸（ffmpeg）→ 打包 ICO
node scripts/build-ico.js work-ico public/app-icon.ico 16,32,48,64,128,256
```

## 提 PR 之前

1. **保持简洁**：小步提交，一个 PR 解决一个问题
2. **不破坏零依赖定位**：服务端依赖保持精简（express / multer / chinese-conv）；新依赖需在 PR 说明理由
3. **自检**：`node --check server.js` 通过；功能改动需实际启动服务实测（curl 或浏览器）
4. **中文优先**：界面文案与文档使用简体中文，代码注释中文或英文皆可
5. **更新 CHANGELOG.md**：新增功能、修复、变更都要记录
6. **图标与视觉改动需附截图说明**（assets/ 或 PR 内）

## 代码风格

- 服务端：Node.js + Express，路由与转写队列逻辑清晰分区
- 前端：原生 HTML/CSS/JS，保持"零构建、双击即用"的哲学（不引入打包器）
- 转写后处理（去重/收缩/清洗）改动必须附真实音频验证说明

## 行为准则

- 友好、尊重、就事论事
- 不接受任何形式的歧视、骚扰或人身攻击
- 本工具处理用户音频数据，任何涉及上传/存储的改动必须默认"不出电脑"为底线

感谢每一位贡献者，拾音因你而更好 🌙
