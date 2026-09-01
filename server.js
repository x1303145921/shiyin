/**
 * 拾音 (Shiyin) — 纯本地音频/视频转文字工具
 * 基于 whisper.cpp，文件全程不出电脑。
 * v0.2：批量队列 + 模型管理（下载/切换）+ 反幻觉参数 + txt/srt/vtt 输出
 * v0.3：字幕↔音频联动（保留媒体供播放、字幕点击跳转）+ VAD 静音跳过
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { sify } = require('chinese-conv');

const ROOT = __dirname;

// whisper.cpp 在 Windows 上无法处理含非 ASCII 字符的路径（UTF-8 argv + CRT 代码页限制），
// 实测：exe 在中文路径可运行，但模型/输入/输出文件路径必须是纯 ASCII。
// 因此在项目同盘符根目录建 ASCII 缓存目录，模型/工作文件全部放里面。
const VOL_ROOT = path.parse(ROOT).root; // 如 D:\
const RUNTIME = path.join(VOL_ROOT, 'shiyin-cache');
const MODEL_DIR = path.join(RUNTIME, 'models');
const WORK = path.join(RUNTIME, 'work');
const MEDIA_DIR = path.join(WORK, 'media'); // 转写完成后保留的原始媒体（供前端播放/字幕跳转）
const VAD_MODEL = 'ggml-silero-v6.2.0.bin'; // Silero VAD（跳过静音段）
const WHISPER = path.join(ROOT, 'bin', 'Release', 'whisper-cli.exe');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const PORT = parseInt(process.env.PORT || '18900', 10);
const HOST = process.env.BIND || '127.0.0.1';
const HF_MIRROR = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main';

// ---------- 模型注册表 ----------
const MODELS = {
  'ggml-base.bin': { sizeMB: 141, desc: '极速 · 低要求' },
  'ggml-small.bin': { sizeMB: 465, desc: '快速 · 日常够用' },
  'ggml-large-v3-turbo-q5_0.bin': { sizeMB: 547, desc: '高精度 · 性价比最优' },
};
let activeModel = 'ggml-small.bin';
const ACTIVE_FILE = path.join(MODEL_DIR, '.active');

// 恢复上次使用的模型（持久化，重启不丢）
try {
  if (fs.existsSync(ACTIVE_FILE)) {
    const saved = fs.readFileSync(ACTIVE_FILE, 'utf8').trim();
    if (MODELS[saved]) activeModel = saved;
  }
} catch {}

fs.mkdirSync(MODEL_DIR, { recursive: true });
fs.mkdirSync(path.join(WORK, 'uploads'), { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// 项目 models/ 里已有模型 hardlink 进缓存目录（同卷零拷贝）
for (const name of Object.keys(MODELS)) {
  const src = path.join(ROOT, 'models', name);
  const dst = path.join(MODEL_DIR, name);
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    try { fs.linkSync(src, dst); } catch { try { fs.copyFileSync(src, dst); } catch {} }
  }
}

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
app.use(express.json());

const upload = multer({
  dest: path.join(WORK, 'uploads'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB 上限
  // 粗筛：只收常见音视频扩展名（避免 txt/zip 等排进队后 ffmpeg 报模糊错误）
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp3|wav|m4a|flac|aac|ogg|opus|wma|mp4|mkv|mov|avi|webm|flv|ts|m4v|wmv|3gp|ogv|mpg|mpeg|aiff|ape|amr)$/i.test(file.originalname);
    if (!ok) return cb(new Error('不支持的格式：' + (file.originalname || '未命名') + '（支持常见音视频：mp3/wav/m4a/flac/mp4/mkv/mov…）'));
    cb(null, true);
  },
});

// ---------- 任务队列（并发 2，批量排队） ----------
const tasks = new Map(); // id -> task
const queue = [];        // id 数组
const running = [];      // 正在执行的任务 id（最多 CONCURRENCY 个）
const CONCURRENCY = 2;   // 18 核 CPU，2 任务 × 8 线程

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (out += d.toString('utf8')));
    p.on('error', (e) => reject(new Error(`无法启动 ${cmd}: ${e.message}`)));
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${out.slice(-500)}`))
    );
  });
}

function runWhisper(inputWav, task) {
  return new Promise((resolve, reject) => {
    const model = path.join(MODEL_DIR, activeModel);
    const base = inputWav.replace(/\.wav$/, '');
    // 反幻觉参数（借鉴 WhisprRT）：temperature=0.0（默认）、禁用温度回退（-tpi 0）、no_speech 阈值 0.6
    // 加速：不开 -pp（词级时间戳用不上，省 15%+ 时间）；-t 8 线程（18 核 CPU，并发 2 时峰值 16 线程）
    const args = [
      '-m', model, '-l', 'zh', '-f', inputWav,
      '-otxt', '-osrt', '-ovtt', '-of', base,
      '-t', '8', '-nth', '0.60', '-tpi', '0.0',
    ];
    // v0.3：VAD 静音跳过（长音频/播客显著加速 + 减少环境声幻觉）；需 ggml-silero-v6.2.0.bin 已下载
    if (task.useVad) {
      const vadPath = path.join(MODEL_DIR, VAD_MODEL);
      if (!fs.existsSync(vadPath)) {
        return reject(new Error('VAD 模型未下载，请先在右侧面板下载「静音检测模型」'));
      }
      args.push('--vad', '-vm', vadPath);
    }
    const p = spawn(WHISPER, args, { cwd: ROOT });
    let err = '';
    const parseProgress = (d) => {
      const m = d.toString('utf8').match(/progress\s*=\s*(\d+)%/);
      if (m) task.progress = Math.max(task.progress || 0, parseInt(m[1], 10));
    };
    p.stdout.on('data', parseProgress);
    p.stderr.on('data', (d) => { parseProgress(d); err += d.toString('utf8'); });
    p.on('error', (e) => reject(new Error(`无法启动 whisper: ${e.message}`)));
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`识别失败（退出码 ${code}）：${err.slice(-500)}`))
    );
  });
}

async function executeTask(task) {
  const uploadPath = task.uploadPath;
  let wavPath = path.join(WORK, task.id + '.wav');
  const base = path.join(WORK, task.id);
  try {
    // 0. 已是 whisper 输入格式（16kHz 单声道 WAV）？直接跳过转码（音频上传最省时的场景）
    //    ffprobe 秒级探测；仅 .wav 值得探测（mp3/flac/视频一律走 ffmpeg）
    let skipConvert = false;
    if (path.extname(task.fileName).toLowerCase() === '.wav') {
      try {
        const probe = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', uploadPath]);
        const m = probe.trim().match(/^(\d+),(\d+)$/);
        if (m && m[1] === '16000' && m[2] === '1') {
          wavPath = uploadPath; // 直接用原文件喂 whisper（输出文件写在 uploadPath 旁）
          skipConvert = true;
        }
      } catch { /* 探测失败走正常转码 */ }
    }
    // 1. 预处理：16kHz 单声道 WAV（whisper 硬性要求），视频自动抽音轨
    task.status = 'preprocess';
    if (!skipConvert) {
      await run(FFMPEG, ['-y', '-v', 'error', '-i', uploadPath, '-vn', '-ac', '1', '-ar', '16000', wavPath]);
    }
    // 2. 识别
    task.status = 'transcribing';
    task.progress = 0;
    await runWhisper(wavPath, task);
    // 3. 读取结果 + 繁转简（whisper 中文输出偏繁体）
    //    跳过转码时 whisper 输出写在 uploadPath 旁（base=uploadPath，无 .wav 后缀）
    const resBase = skipConvert ? uploadPath : base;
    const read = (ext) => (fs.existsSync(resBase + ext) ? sify(fs.readFileSync(resBase + ext, 'utf8')) : '');
    let txt = read('.txt');
    let srt = read('.srt');
    let vtt = read('.vtt');
    // 3.5 重复幻觉后处理：whisper 在长音频/模糊音频上偶尔会把一句话重复输出多次（"说一遍变十遍"），
    //     这里合并时间上相邻、文本完全相同的段落（txt 按行去重；srt/vtt 解析 cue 去重后重新编号）
    const norm = (s) => String(s).replace(/[\s，。！？、,.!?;；：:…"'“”‘’()（）\[\]【】-]/g, '').toLowerCase();
    // 「A - A - A - A」或「A A A」整段同一词重复（whisper 对无语音段/模糊音频的典型幻觉）→ 收缩为单个
    const shrinkRepeatWords = (text) => {
      // 剥星号标记 + 只保留中日韩/字母数字（清掉 whisper 输出的 � 等噪音字节）
      const cleaned = String(text).replace(/^\s*\*+\s*/, '');
      const body = cleaned.replace(/[^\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]/g, '');
      // 整段为同一词（≥2 字符）重复 3 次以上 → 收缩为单个；1 字单元（哈哈哈/嗯嗯嗯）不动
      const m = body.length >= 6 ? body.match(/^(.{2,}?)\1{2,}$/) : null;
      if (m) return m[1];
      return text;
    };
    const dedupe = (() => {
      // srt/vtt 通用：解析 cue → 合并相邻相同 → 重新序列化
      // text 形如: "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n内容\n\n..." 或 srt 带序号
      function parseCues(text, isSrt) {
        const cues = [];
        const lines = String(text).split(/\r?\n/);
        let i = 0;
        while (i < lines.length) {
          const l = lines[i].trim();
          if (isSrt && /^\d+$/.test(l)) { i++; continue; } // srt 序号行
          if (/-->/.test(l)) {
            const time = l;
            const buf = [];
            i++;
            while (i < lines.length && lines[i].trim() !== '') { buf.push(lines[i]); i++; }
            cues.push({ time, text: buf.join('\n').trim() });
          } else i++;
        }
        return cues;
      }
      function norm(s) { return String(s).replace(/[\s，。！？、,.!?;；：:…"'“”‘’()（）\[\]【】-]/g, '').toLowerCase(); }
      function dedupeCues(cues, isSrt) {
        const out = [];
        let removed = 0;
        let shrunk = false;
        for (const c of cues) {
          // 先收缩 cue 内重复词，再判相邻重复
          const text = shrinkRepeatWords(c.text);
          if (text !== c.text) shrunk = true;
          const prev = out[out.length - 1];
          if (prev && norm(prev.text) !== '' && norm(prev.text) === norm(text)) {
            // 合并：保留前一条的起点 + 当前条的终点（时间轴连续），文本不变
            const mergedTime = mergeTime(prev.time, c.time);
            out[out.length - 1] = { time: mergedTime, text: prev.text };
            removed++;
          } else out.push({ time: c.time, text });
        }
        return { out, removed, shrunk };
      }
      function mergeTime(a, b) {
        // a/b 均形如 "HH:MM:SS,mmm --> HH:MM:SS,mmm"（srt）或 ".mmm"（vtt），分隔符同为 " --> "
        const start = String(a).split(' --> ')[0].trim();
        const end = String(b).split(' --> ')[1].trim();
        return start + ' --> ' + end;
      }
      function serialize(cues, isSrt, withHeader) {
        let out = withHeader ? 'WEBVTT\n\n' : '';
        cues.forEach((c, idx) => {
          if (isSrt) out += idx + 1 + '\n';
          out += c.time + '\n' + c.text + '\n\n';
        });
        return out;
      }
      return { parseCues, dedupeCues, serialize };
    })();
    if (srt) {
      const r = dedupe.dedupeCues(dedupe.parseCues(srt, true), true);
      // 有相邻去重或 cue 内收缩都重新序列化
      srt = r.removed || r.shrunk ? dedupe.serialize(r.out, true, false) : srt;
    }
    if (vtt) {
      const r = dedupe.dedupeCues(dedupe.parseCues(vtt, false), false);
      vtt = r.removed || r.shrunk ? dedupe.serialize(r.out, false, true) : vtt;
    }
    if (txt) {
      const tl = txt.split(/\r?\n/);
      const out = [];
      let changed = false;
      for (const l of tl) {
        const line = shrinkRepeatWords(l); // 收缩行内重复词幻觉（如「屁股 - 屁股 - 屁股」）
        if (line !== l) changed = true;
        const prev = out[out.length - 1];
        if (prev && norm(prev) !== '' && norm(prev) === norm(line)) { changed = true; continue; }
        out.push(line);
      }
      if (changed) txt = out.join('\n');
    }
    // 4. 保留原始媒体供前端播放（字幕点击跳转）：移到 media/<taskId>/<taskId><ext>
    //    文件名用纯 ASCII（taskId 前缀），避免中文 URL 问题；原名已存在 task.fileName
    try {
      const ext = path.extname(task.fileName).toLowerCase() || '';
      const mediaDir = path.join(MEDIA_DIR, task.id);
      fs.mkdirSync(mediaDir, { recursive: true });
      const mediaPath = path.join(mediaDir, task.id + ext);
      await fs.promises.rename(uploadPath, mediaPath);
      task.mediaUrl = '/media/' + task.id + '/' + task.id + ext;
      task.mediaType = /^(mp4|mkv|mov|avi|webm|flv|ts|m4v|wmv|3gp|ogv|mpg|mpeg)$/i.test(ext.slice(1)) ? 'video' : 'audio';
    } catch (e) {
      // 媒体保留失败不影响转写结果（仅失去播放联动）
      task.mediaUrl = null;
    }
    // 无语音判定：空文本，或全是 (小声)/(音乐)/(笑声) 类括号标记
    const bracketOnly = /^\s*[\[\(（][^\]\)）]*[\]\)）]\s*$/;
    // 重复词幻觉判定：whisper 对纯环境声常输出「屁股 - 屁股 - 屁股 …」这类一个词反复
    function isRepeatHallucination(text) {
      const cleaned = text.replace(/[\s\-–—,，。.、:：;；!！?？()（）\[\]【】*]/g, ' ').trim();
      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length < 3) return false;
      return new Set(words).size === 1;
    }
    const lines = txt.trim().split(/\r?\n/).filter(Boolean);
    const noSpeech = !txt.trim() || (lines.length > 0 && lines.every((l) => bracketOnly.test(l))) || isRepeatHallucination(txt);
    task.status = 'done';
    task.result = { text: txt, srt, vtt, file: task.fileName, noSpeech, model: activeModel, vad: !!task.useVad };
  } catch (e) {
    task.status = 'failed';
    task.error = e.message;
  } finally {
    // 成功时 upload 已 rename 进媒体目录（任务清理时一并删）；失败才清理 upload
    if (task.status !== 'done') fs.promises.unlink(uploadPath).catch(() => {});
    for (const f of [wavPath, base + '.txt', base + '.srt', base + '.vtt']) {
      fs.promises.unlink(f).catch(() => {});
    }
  }
}

function pump() {
  while (running.length < CONCURRENCY && queue.length > 0) {
    const id = queue.shift();
    running.push(id);
    executeTask(tasks.get(id))
      .catch(() => {})
      .finally(() => {
        const i = running.indexOf(id);
        if (i >= 0) running.splice(i, 1);
        pump();
      });
  }
}

// full=true：详情接口返回完整 srt/vtt；列表接口默认裁剪大字段（30 任务 × 数百 KB 的 srt/vtt 会让 /api/tasks 变慢）
function publicTask(t, full) {
  const base = {
    id: t.id, status: t.status, progress: t.progress,
    error: t.error, result: null, file: t.fileName, baseName: t.baseName,
    sizeMB: t.sizeMB, model: t.model, createdAt: t.createdAt,
    mediaUrl: t.mediaUrl, mediaType: t.mediaType, useVad: !!t.useVad,
  };
  if (t.result) {
    const r = t.result;
    base.result = {
      file: r.file, noSpeech: r.noSpeech, model: r.model, vad: r.vad,
      text: r.text,
    };
    if (full) {
      base.result.srt = r.srt;
      base.result.vtt = r.vtt;
    } else {
      base.result._trimmed = true; // 前端展开时按需拉详情
    }
  }
  return base;
}

// ---------- 模型下载器（断点续传 + SHA256 尽力校验 + 单下载锁） ----------
let downloadJob = null; // { name, status, progress, speedMBs, error }
let downloadPromise = null;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function fetchSha256(name) {
  return new Promise((resolve) => {
    https.get(`${HF_MIRROR}/${name}.sha256`, (res) => {
      if (res.statusCode !== 200) return resolve(null);
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => { const m = data.match(/[0-9a-fA-F]{64}/); resolve(m ? m[0] : null); });
    }).on('error', () => resolve(null));
  });
}

function downloadToPart(name) {
  return new Promise((resolve, reject) => {
    const dest = path.join(MODEL_DIR, name);
    const part = dest + '.part';
    const url = `${HF_MIRROR}/${name}`;
    // hf-mirror 链接是 302 重定向（Node https.get 不跟随），改用 curl：
    // -L 跟随重定向，-C - 断点续传（自动 Range），-f HTTP 错误时不写 body
    const p = spawn('curl', ['-L', '-C', '-', '-f', '-s', '-o', part, url], { cwd: ROOT });
    p.on('error', (e) => reject(new Error('无法启动 curl: ' + e.message)));
    p.on('close', (code) => (code === 0 ? resolve(part) : reject(new Error('下载失败，curl 退出码 ' + code))));
  });
}

function startDownload(name) {
  if (downloadPromise) return { started: false, reason: '已有模型正在下载' };
  if (!MODELS[name]) return { started: false, reason: '未知模型' };
  downloadJob = { name, status: 'downloading', progress: 0, speedMBs: 0, error: null };
  // 进度轮询：以 .part 文件大小估算（curl 静默下载，无内建进度回调）
  const totalBytes = MODELS[name].sizeMB * 1048576;
  const progTimer = setInterval(() => {
    if (!downloadJob || downloadJob.status !== 'downloading') return;
    try {
      const p = path.join(MODEL_DIR, name) + '.part';
      if (!fs.existsSync(p)) return;
      const size = fs.statSync(p).size;
      const now = Date.now();
      if (downloadJob._last) {
        const dt = (now - downloadJob._last.t) / 1000;
        if (dt > 0) downloadJob.speedMBs = (size - downloadJob._last.s) / dt / 1048576;
      }
      downloadJob._last = { t: now, s: size };
      downloadJob.progress = Math.min(99, Math.round((size / totalBytes) * 100));
    } catch {}
  }, 1000);
  downloadPromise = (async () => {
    try {
      const part = await downloadToPart(name);
      clearInterval(progTimer);
      const sha = await fetchSha256(name);
      if (sha) {
        const actual = await sha256File(part);
        if (actual.toLowerCase() !== sha.toLowerCase()) {
          fs.unlinkSync(part);
          throw new Error('SHA256 校验失败（已删除不完整文件），请重试');
        }
      }
      fs.renameSync(part, path.join(MODEL_DIR, name));
      downloadJob.status = 'done';
      downloadJob.progress = 100;
    } catch (e) {
      clearInterval(progTimer);
      if (downloadJob) { downloadJob.status = 'failed'; downloadJob.error = e.message; }
    } finally {
      downloadPromise = null;
    }
  })();
  return { started: true };
}

// ---------- API ----------
// multer/busboy 对非 ASCII 文件名按 latin1 解码导致中文名乱码，这里修复为 UTF-8
function fixOriginalName(name) {
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    // 修复后含中文（或常见 CJK 范围）才采用，避免破坏本就正确的名字
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(fixed)) return fixed;
  } catch {}
  return name;
}

// 清洗 Windows 非法文件名字符，并保留扩展名
function safeBaseName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_');
  return cleaned.replace(/\.[^.]+$/, '');
}

app.post('/api/transcribe', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      // multer 错误（格式拒绝 / 超 2GB）→ 4xx 友好提示
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件超过 2GB 上限' : (err.message || '上传失败');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: '没有收到文件' });
  const envMissing = [];
  if (!fs.existsSync(WHISPER)) envMissing.push('引擎缺失');
  if (!fs.existsSync(path.join(MODEL_DIR, activeModel))) envMissing.push(`模型未下载：${activeModel}`);
  if (envMissing.length) {
    fs.unlink(req.file.path, () => {});
    return res.status(500).json({ error: envMissing.join('；') });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const origName = fixOriginalName(req.file.originalname || '未命名文件');
  const task = {
    id,
    status: 'queued',
    progress: 0,
    error: null,
    result: null,
    fileName: origName,
    baseName: safeBaseName(origName), // 供前端默认保存文件名（无扩展名）
    sizeMB: Math.round((req.file.size / 1048576) * 10) / 10,
    model: activeModel,
    uploadPath: req.file.path,
    useVad: !!(req.body && req.body.useVad),
    createdAt: Date.now(),
  };
  tasks.set(id, task);
  queue.push(id);
  pump();
  res.json({ taskId: id });
  }); // upload.single 回调结束
}); // app.post 结束

app.get('/api/tasks', (req, res) => {
  const list = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map((t) => publicTask(t, false));
  res.json({ list, running: running.length, queueLen: queue.length });
});

app.get('/api/task/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json(publicTask(t, true));
});

app.get('/api/models', (req, res) => {
  const list = Object.keys(MODELS).map((name) => {
    const p = path.join(MODEL_DIR, name);
    const downloaded = fs.existsSync(p);
    return {
      name, sizeMB: MODELS[name].sizeMB, desc: MODELS[name].desc,
      downloaded, active: name === activeModel,
      size: downloaded ? fs.statSync(p).size : 0,
    };
  });
  const vadPath = path.join(MODEL_DIR, VAD_MODEL);
  const vadDownloaded = fs.existsSync(vadPath);
  res.json({
    list, active: activeModel, download: downloadJob,
    vad: { name: VAD_MODEL, downloaded: vadDownloaded, size: vadDownloaded ? fs.statSync(vadPath).size : 0 },
  });
});

// ---------- VAD 模型下载（885KB，curl 单文件） ----------
let vadDownloadPromise = null;
app.post('/api/vad/download', (req, res) => {
  const vadPath = path.join(MODEL_DIR, VAD_MODEL);
  if (fs.existsSync(vadPath)) return res.json({ ok: true, already: true });
  if (vadDownloadPromise) return res.status(409).json({ error: 'VAD 模型正在下载' });
  const part = vadPath + '.part';
  const url = 'https://hf-mirror.com/ggml-org/whisper-vad/resolve/main/' + VAD_MODEL;
  vadDownloadPromise = new Promise((resolve, reject) => {
    const p = spawn('curl', ['-L', '-f', '-s', '-o', part, url], { cwd: ROOT });
    p.on('error', (e) => reject(new Error('无法启动 curl: ' + e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('下载失败，curl 退出码 ' + code))));
  })
    .then(() => fs.promises.rename(part, vadPath))
    .catch((e) => { try { fs.unlinkSync(part); } catch {} throw e; })
    .finally(() => { vadDownloadPromise = null; });
  vadDownloadPromise.catch(() => {}); // 防未处理 rejection
  res.json({ ok: true });
});

// 媒体文件静态服务（express.static 自带 Range 支持，播放器 seek 可用）
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1h', fallthrough: true }));

app.post('/api/models/use', (req, res) => {
  const name = req.body && req.body.name;
  if (!MODELS[name]) return res.status(400).json({ error: '未知模型' });
  if (!fs.existsSync(path.join(MODEL_DIR, name))) return res.status(400).json({ error: '该模型未下载' });
  activeModel = name;
  try { fs.writeFileSync(ACTIVE_FILE, name, 'utf8'); } catch {}
  res.json({ ok: true, active: activeModel });
});

app.post('/api/models/download', (req, res) => {
  const name = req.body && req.body.name;
  if (!MODELS[name]) return res.status(400).json({ error: '未知模型' });
  if (fs.existsSync(path.join(MODEL_DIR, name))) return res.json({ ok: true, already: true });
  const r = startDownload(name);
  if (!r.started) return res.status(409).json({ error: r.reason });
  res.json({ ok: true });
});

// 定期清理超过 2 小时的旧任务记录（连带删除保留的媒体文件）
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if ((t.status === 'done' || t.status === 'failed') && now - t.createdAt > 2 * 3600_000) {
      tasks.delete(id);
      fs.rm(path.join(MEDIA_DIR, id), { recursive: true, force: true }).catch(() => {});
    }
  }
}, 600_000).unref();

app.listen(PORT, HOST, () => {
  console.log(`🐋 拾音 v0.3 已启动: http://${HOST}:${PORT}`);
  const vadPath = path.join(MODEL_DIR, VAD_MODEL);
  console.log(`  VAD 静音检测: ${fs.existsSync(vadPath) ? '✅ 已就绪' : '❌ 未下载（面板可一键下载）'}`);
  for (const name of Object.keys(MODELS)) {
    const p = path.join(MODEL_DIR, name);
    console.log(`  模型 ${name}: ${fs.existsSync(p) ? '✅ 已就绪' : '❌ 未下载'}${name === activeModel ? '（当前）' : ''}`);
  }
  if (!fs.existsSync(WHISPER)) console.log('  ⚠️ 引擎缺失: ' + WHISPER);
});
