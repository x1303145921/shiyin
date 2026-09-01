# 发布指南 · Release

发布新版本的完整流程（维护者用）。

## 版本号

遵循语义化版本：`vMAJOR.MINOR.PATCH`

- MAJOR：不兼容的重大变更
- MINOR：新增功能（向后兼容）
- PATCH：Bug 修复

## 发布步骤

1. **更新文档**
   - `CHANGELOG.md` 增加 `[x.y.z] - 日期` 条目
   - 同步 `README.md` / `README.en.md` / `README.txt` 中的版本号与功能描述
   - 如涉及模型/API 变化，同步 `package.json` 版本号

2. **运行全量自检**
   ```bash
   node --check server.js
   node --check scripts/render-icon.js
   node --check scripts/build-ico.js
   ```

3. **功能实测**
   - 启动服务（`npm start`），浏览器访问 `http://127.0.0.1:18900`
   - 上传一段测试音频，确认转写全流程（上传 → 识别 → 三格式输出 → 编辑保存）通过
   - 确认图标与 PWA 缓存版本号（`service-worker.js` 的 `CACHE` 与 `index.html` 的 `favicon ?v=N`）已同步

4. **提交并打标签**
   ```bash
   git add -A
   git commit -m "release: vX.X.X"
   git tag vX.X.X
   git push origin main --tags
   ```

5. **发布 GitHub Release**
   - 标题：`vX.X.X`
   - 内容：摘要本次变更（可引用 CHANGELOG）
   - 附件：源码 zip（或便携包，如已构建）

## 图标发布检查清单（重要）

图标变更后，以下五处必须同步，否则用户端仍显示旧图标：

| 位置 | 说明 |
|---|---|
| `public/app-icon*.png/ico` | 实际图标文件 |
| `public/service-worker.js` | `CACHE` 版本号 bump（如 `shiyin-v5`） |
| `public/index.html` | `favicon link ?v=N` 版本号 bump |
| `public/manifest.json` | 图标路径与主题色核对 |
| `安装到桌面.bat` | 已含 `ie4uinit.exe -show` 刷新 Windows 图标缓存 |

PWA 已固定的图标需**取消固定再重新固定**才会换新。
