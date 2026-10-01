'use strict';

// 版本号写在 index.html 引用 app.js 的地址里（?v=…），首页底部会显示，用来确认手机上是不是最新版
const APP_VERSION = new URL(document.currentScript.src).searchParams.get('v') || '';

// ---------- 数据存储 ----------
const STORE_KEY = 'dictation.lists';

function loadLists() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}
function saveLists(lists) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(lists)); } catch {}
}

// ---------- 文本处理 ----------
const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';
const hasCJK = (s) => new RegExp(`[${CJK}]`).test(s);

const SEPARATORS = /[\s,，.。;；:：!！?？、"“”'‘’()（）\[\]【】《》<>\-—…·|_~`]+/;
const MAX_WORD_LEN = 4; // 超过 4 个字的一串汉字多半是句子，再细分成词

const zhSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null;

// 一句话拆成两个字以上的词，比如“小草从地下探出头来”→ 小草、地下、探出…
function segmentSentence(s) {
  if (!zhSegmenter) return [s];
  const words = [...zhSegmenter.segment(s)]
    .filter((x) => x.isWordLike && x.segment.length >= 2)
    .map((x) => x.segment);
  return words.length ? words : [s];
}

const PINYIN_TONE = /[\u00c0-\u024f\u1e00-\u1eff]/; // 带声调的字母：课本生字上面的拼音，不要
const LATIN = 'a-zA-Z\\u00c0-\\u024f\\u1e00-\\u1eff';
const SCRIPT_CHANGE = new RegExp(`([${CJK}])(?=[${LATIN}])|([${LATIN}])(?=[${CJK}])`, 'g');

// 按空白和标点拆成词，去重，保留顺序
function splitWords(text) {
  const parts = text
    .replace(SCRIPT_CHANGE, '$1$2 ') // “苹果apple”“dà大” → “苹果 apple”“dà 大”
    .split(SEPARATORS)
    .flatMap((w) => (hasCJK(w) && w.length > MAX_WORD_LEN ? segmentSentence(w) : [w]))
    .filter((w) => w && (hasCJK(w) || /[a-zA-Z]{2,}/.test(w)))
    .filter((w) => !/^\d+$/.test(w) && !PINYIN_TONE.test(w));
  return [...new Set(parts)];
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// 识字结果的文字里，空格基本代表词和词之间的空隙（需要打开 preserve_interword_spaces）。
// 但隔得很远的两个字偶尔会被连在一起（比如生字表里的“秋  冬”），
// 所以再看每个字的位置：两个汉字之间空出大半个字，也拆开
function wordsFromOcr(data) {
  const text = data.text || '';
  const syms = [];
  (data.lines || []).forEach((line, li) => {
    const lineSyms = line.words.flatMap((w) => w.symbols);
    const charH = median(lineSyms.filter((s) => hasCJK(s.text)).map((s) => s.bbox.y1 - s.bbox.y0));
    lineSyms.forEach((s) => syms.push({ t: s.text, x0: s.bbox.x0, x1: s.bbox.x1, line: li, charH }));
  });
  if (!syms.length) return splitWords(text);

  let out = '';
  let i = 0;
  let prev = null;
  for (const s of syms) {
    let space = false;
    while (i < text.length && /\s/.test(text[i])) { space = true; i++; }
    if (!text.startsWith(s.t, i)) return splitWords(text); // 对不上就只用文字
    i += s.t.length;
    if (prev) {
      const a = hasCJK(prev.t);
      const b = hasCJK(s.t);
      const farApart = a && b && s.x0 - prev.x1 > 0.8 * s.charH;
      const scriptChange = (a && /[a-z]/i.test(s.t)) || (b && /[a-z]/i.test(prev.t));
      if (space || prev.line !== s.line || farApart || scriptChange) out += '\n';
    }
    out += s.t;
    prev = s;
  }
  return splitWords(out);
}

// PaddleOCR 认字很准，但一整行字是连在一起给出来的（“燕子桃花春雨柳树”）。
// 课本的生字表、词语表里，词和词之间会空出一段，所以回到照片上看这一行：
// 找出字与字之间的大空隙，按每段的宽度算出各有几个字，再把识别出的字分开

// 量一行：字有多高（inkH），以及从左到右每一段连续墨迹的起止位置和最高的那一列有多少墨（runs）
function measureLine(img, poly) {
  // 沿着检测框的上下边取每一列，照片拍歪了也能对齐
  const [p0, p1, p2, p3] = poly;
  const xStart = Math.max(0, Math.floor(Math.min(p0[0], p3[0])));
  const xEnd = Math.min(img.width - 1, Math.ceil(Math.max(p1[0], p2[0])));
  const lerp = (a, b, x) => (b[0] === a[0] ? a[1] : a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]));
  const bandH = Math.round(Math.max(p3[1] - p0[1], p2[1] - p1[1]));
  const w = xEnd - xStart + 1;
  if (w < 8 || bandH < 6) return null;

  const gray = new Uint8Array(w * bandH);
  const colored = new Uint8Array(w * bandH);
  const hist = new Array(256).fill(0);
  for (let c = 0; c < w; c++) {
    const top = Math.round(lerp(p0, p1, xStart + c));
    for (let k = 0; k < bandH; k++) {
      const y = Math.min(img.height - 1, Math.max(0, top + k));
      const i = (y * img.width + xStart + c) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray[k * w + c] = v;
      colored[k * w + c] = Math.max(r, g, b) - Math.min(r, g, b) > 70 ? 1 : 0;
      hist[v]++;
    }
  }

  // Otsu 自动找黑白分界
  const total = w * bandH;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB || wB === total) continue;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / (total - wB);
    const between = wB * (total - wB) * (mB - mF) ** 2;
    if (between > best) { best = between; thr = v; }
  }

  // 彩色的田字格线、红线不算字；但如果字本身就是彩色的（比如红色描红字），就不排除彩色
  let dark = 0, darkColored = 0;
  for (let j = 0; j < total; j++) if (gray[j] <= thr) { dark++; darkColored += colored[j]; }
  const skipColored = darkColored < dark * 0.5;
  const ink = new Uint8Array(total);
  for (let j = 0; j < total; j++) ink[j] = gray[j] <= thr && !(skipColored && colored[j]) ? 1 : 0;

  // 去掉格子线、下划线：很长的横线段和贯穿上下的竖线段（一个字里的笔画没有这么长）
  for (let k = 0; k < bandH; k++) {
    let runStart = -1;
    for (let c = 0; c <= w; c++) {
      const on = c < w && ink[k * w + c];
      if (on && runStart < 0) runStart = c;
      if (!on && runStart >= 0) {
        if (c - runStart > bandH * 1.2) for (let x = runStart; x < c; x++) ink[k * w + x] = 0;
        runStart = -1;
      }
    }
  }
  for (let c = 0; c < w; c++) {
    let runStart = -1;
    for (let k = 0; k <= bandH; k++) {
      const on = k < bandH && ink[k * w + c];
      if (on && runStart < 0) runStart = k;
      if (!on && runStart >= 0) {
        if (k - runStart > bandH * 0.9) for (let y = runStart; y < k; y++) ink[y * w + c] = 0;
        runStart = -1;
      }
    }
  }

  // 墨迹横跨大半行的是格子的横线（模糊时断断续续，上面没去干净），不算
  const lineRow = new Uint8Array(bandH);
  for (let k = 0; k < bandH; k++) {
    let n = 0;
    for (let c = 0; c < w; c++) n += ink[k * w + c];
    lineRow[k] = n > w * 0.6 ? 1 : 0;
  }

  // 一列一列数墨迹，连起来的列是一段；记下每段墨迹的上下范围和最浓的一列
  const colInk = new Array(w).fill(0);
  for (let k = 0; k < bandH; k++) if (!lineRow[k]) for (let c = 0; c < w; c++) colInk[c] += ink[k * w + c];
  const findRuns = (minInk) => {
    const runs = [];
    let start = -1;
    for (let c = 0; c <= w; c++) {
      const on = c < w && colInk[c] > minInk;
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        let top = bandH, bottom = -1;
        for (let k = 0; k < bandH; k++) {
          if (lineRow[k]) continue;
          for (let x = start; x < c; x++) if (ink[k * w + x]) { top = Math.min(top, k); bottom = Math.max(bottom, k); break; }
        }
        runs.push({ start, end: c - 1, height: bottom - top + 1, peak: Math.max(...colInk.slice(start, c)) });
        start = -1;
      }
    }
    return runs;
  };

  // 字有多高：取宽一点的墨迹段（整字或整词）高度的中位数，格子线、拼音的影响就小了
  const wide = findRuns(Math.max(1, bandH * 0.03)).filter((r) => r.end - r.start + 1 >= bandH * 0.25);
  const inkH = median(wide.map((r) => r.height));
  if (!inkH) return null;

  const runs = findRuns(Math.max(1, inkH * 0.04));
  return { inkH, runs };
}

// 把墨迹分成几个词，并算出每个词有几个字；对不上就返回 null。
// 试不同的“多大的空隙算词与词之间”，选字数刚好对上、词间空隙和词内空隙差得最开、
// 而且词间空隙大小差不多（课本里词与词的间隔是一样的）的那种分法
function allocateChars(allRuns, inkH, n) {
  const em = inkH / 0.9; // 一个汉字占的宽度，大约比字的高度宽一点
  // 又矮又细的是污点，不算；又细又高的是笔画（“引”的竖、“川”），要留着；
  // 但比字还高的细线是格子线，不算
  const runs = allRuns.filter((r) => r.end - r.start + 1 >= inkH * 0.15 || (r.peak >= inkH * 0.5 && r.height <= inkH * 1.15));
  if (runs.length < 2) return null;
  const gaps = runs.slice(1).map((r, i) => r.start - runs[i].end - 1);
  const thresholds = [...new Set(gaps)].filter((g) => g >= inkH * 0.3).sort((a, b) => a - b);
  let best = null;
  for (const t of thresholds) {
    // 小于 t 的空隙并成一段（字内部或同一个词里字与字之间）
    const segs = [{ ...runs[0] }];
    let maxInside = 0;
    let minBetween = Infinity;
    let maxBetween = 0;
    gaps.forEach((g, i) => {
      if (g < t) { segs[segs.length - 1].end = runs[i + 1].end; maxInside = Math.max(maxInside, g); }
      else { segs.push({ ...runs[i + 1] }); minBetween = Math.min(minBetween, g); maxBetween = Math.max(maxBetween, g); }
    });
    if (segs.length < 2 || minBetween < 1.6 * maxInside) continue; // 词间空隙要明显比词内的大

    // 词与词之间一般空出一个字左右；同一个词里的字，楷体也会空出小半个字，不能当成两个词。
    // 例外：一个字一格（田字格）时字距比课文宽，格子之间的空隙可以小一些
    const centers = segs.map((g) => (g.start + g.end) / 2);
    const pitch = median(centers.slice(1).map((x, i) => x - centers[i]));
    const sparseChars = maxInside === 0 && pitch >= 1.25 * em;
    if (minBetween < 0.6 * em && !sparseChars) continue;

    // 两种算法：按字高推算每段几个字；或按平均宽度分（窄的字如“卜”“川”也算一个）
    const widths = segs.map((g) => g.end - g.start + 1);
    const byEm = widths.map((x) => Math.max(1, Math.round((x + 0.1 * em) / em)));
    const unit = widths.reduce((a, b) => a + b, 0) / n;
    const byUnit = widths.map((x) => Math.max(1, Math.round(x / unit)));
    const unitOk = byUnit.every((c, i) => (c === 1 ? widths[i] / unit < 1.45 : Math.abs(widths[i] / unit - c) < 0.25));
    const counts = [byEm, unitOk ? byUnit : null].find(
      (cs) => cs && cs.every((c) => c <= MAX_WORD_LEN) && cs.reduce((a, b) => a + b, 0) === n
    );
    if (!counts) continue;
    const score = (minBetween / Math.max(maxInside, 0.1 * em)) * (minBetween / maxBetween);
    if (!best || score > best.score) best = { counts, score };
  }
  return best ? best.counts : null;
}

function splitLineByGaps(img, poly, text) {
  const chars = [...text].filter((ch) => !/\s/.test(ch));
  if (chars.length < 2) return text;
  if (chars.every((ch) => /[a-zA-Z]/.test(ch))) return splitLatinByGaps(img, poly, text);
  if (!chars.every((ch) => hasCJK(ch))) return text; // 中英混在一行的不拆
  const m = measureLine(img, poly);
  const counts = m && allocateChars(m.runs, m.inkH, chars.length);
  if (!counts) return text;
  const words = [];
  let at = 0;
  for (const c of counts) { words.push(chars.slice(at, at + c).join('')); at += c; }
  return words.join('\n');
}

// 英文单词表：识别结果偶尔会把隔开的几个单词连成一串（“catdogduckbird”）。
// 照片上单词之间的空隙比字母之间大得多，按每段的宽度估计在哪个字母后面断开
const LETTER_WIDTH = (ch) => {
  if (/[ijl'.]/.test(ch)) return 0.25;
  if (/[ftrI]/.test(ch)) return 0.35;
  if (/[mwMW]/.test(ch)) return 0.85;
  return /[A-Z]/.test(ch) ? 0.7 : 0.55;
};
function splitLatinByGaps(img, poly, text) {
  const m = measureLine(img, poly);
  if (!m || m.runs.length < 2) return text;
  const gaps = m.runs.slice(1).map((r, i) => r.start - m.runs[i].end - 1);
  const typical = median(gaps);
  const bigAt = gaps.map((g, i) => (g >= m.inkH * 0.35 && g >= 3 * Math.max(typical, 1) ? i : -1)).filter((i) => i >= 0);
  const words = text.trim().split(/\s+/);
  if (words.length >= bigAt.length + 1) return text; // 识别结果里的空格已经够了

  // 每段墨迹的宽度占比 → 字母累计宽度占比最接近的位置断开
  const segWidths = [];
  let from = 0;
  for (const i of [...bigAt, m.runs.length - 1]) {
    segWidths.push(m.runs[i].end - m.runs[from].start + 1);
    from = i + 1;
  }
  const letters = [...words.join('')];
  const cum = [];
  letters.reduce((acc, ch, i) => (cum[i] = acc + LETTER_WIDTH(ch)), 0);
  const totalLetters = cum[cum.length - 1];
  const totalInk = segWidths.reduce((a, b) => a + b, 0);
  const cuts = [];
  let inkSoFar = 0;
  let prev = 0;
  for (let k = 0; k < segWidths.length - 1; k++) {
    inkSoFar += segWidths[k];
    const target = (inkSoFar / totalInk) * totalLetters;
    let bestI = prev + 1;
    for (let i = prev + 1; i < letters.length - (segWidths.length - 1 - k); i++) {
      if (Math.abs(cum[i - 1] - target) < Math.abs(cum[bestI - 1] - target)) bestI = i;
    }
    cuts.push(bestI);
    prev = bestI;
  }
  const parts = [];
  let at = 0;
  for (const c of [...cuts, letters.length]) { parts.push(letters.slice(at, c).join('')); at = c; }
  return parts.join(' ');
}

// 识别结果按阅读顺序排：先分行（上下位置相近的算一行），每行从左到右。
// 照片拍歪时整行是斜的，先按检测框上边的平均斜率把位置“扶正”再分行
function readingOrder(items) {
  const slopes = items
    .map((it) => { const [p0, p1] = it.poly; return p1[0] - p0[0] > 0 ? (p1[1] - p0[1]) / (p1[0] - p0[0]) : null; })
    .filter((v) => v !== null && Math.abs(v) < 0.5);
  const slope = median(slopes);
  const boxes = items.map((it) => {
    const xs = it.poly.map((p) => p[0]), ys = it.poly.map((p) => p[1]);
    const top = Math.min(...ys), bottom = Math.max(...ys);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    return { it, y: (top + bottom) / 2 - slope * cx, h: bottom - top, x: Math.min(...xs) };
  });
  boxes.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const b of boxes) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(b.y - row.y) < 0.5 * Math.min(b.h, row.h)) {
      row.boxes.push(b);
      row.y += (b.y - row.y) / row.boxes.length; // 这一行的平均位置
    } else rows.push({ y: b.y, h: b.h, boxes: [b] });
  }
  return rows.flatMap((r) => r.boxes.sort((a, b) => a.x - b.x).map((b) => b.it));
}

// 拼音：一小行字母，正好在汉字的正上方。带声调的拼音框可能和汉字差不多高（g、j、y 往下伸），
// 没声调的要比汉字明显小，免得把汉字上方的英文单词当成拼音
function isPinyinAbove(box, all) {
  if (hasCJK(box.it.text) || !/^[a-z\sÀ-ɏḀ-ỿ]+$/.test(box.it.text)) return false;
  const maxRatio = PINYIN_TONE.test(box.it.text) ? 1.0 : 0.75;
  return all.some((o) => hasCJK(o.it.text) && box.h < maxRatio * o.h
    && o.top >= box.top && o.top - box.bottom < 1.5 * box.h
    && Math.min(box.right, o.right) - Math.max(box.x, o.x) > 0);
}

function wordsFromPaddle(items, img) {
  const boxes = items.map((it) => {
    const xs = it.poly.map((p) => p[0]), ys = it.poly.map((p) => p[1]);
    return { it, x: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), h: Math.max(...ys) - Math.min(...ys) };
  });
  const kept = boxes.filter((b) => !isPinyinAbove(b, boxes)).map((b) => b.it);
  return splitWords(readingOrder(kept).map((it) => splitLineByGaps(img, it.poly, it.text.trim())).join('\n'));
}

// ---------- 语音 ----------
let voices = [];
function refreshVoices() { voices = speechSynthesis.getVoices(); }
if ('speechSynthesis' in window) {
  refreshVoices();
  speechSynthesis.onvoiceschanged = refreshVoices;
}

function pickVoice(lang) {
  const prefix = lang.slice(0, 2);
  return voices.find((v) => v.lang === lang) || voices.find((v) => v.lang.startsWith(prefix));
}

function speak(text, rate) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { alert('这个浏览器不支持朗读'); resolve(); return; }
    const lang = hasCJK(text) ? 'zh-CN' : 'en-US';
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 视图切换 ----------
const $ = (id) => document.getElementById(id);
const views = ['home', 'ocr', 'edit', 'dictate', 'check'];
const titles = { home: '小听写', ocr: '识别文字', edit: '编辑词表', dictate: '听写', check: '对答案' };
let current = 'home';

function show(name) {
  current = name;
  views.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== name));
  $('title').textContent = titles[name];
  $('backBtn').classList.toggle('hidden', name === 'home');
  if (name === 'home') renderHome();
  window.scrollTo(0, 0);
}

$('backBtn').onclick = () => { stopDictation(); show('home'); };

// ---------- 首页 ----------
let editingId = null;

function renderHome() {
  const lists = loadLists();
  $('emptyHint').classList.toggle('hidden', lists.length > 0);
  const ul = $('listList');
  ul.innerHTML = '';
  lists.forEach((l) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name"></span><span class="meta">${l.words.length} 个</span>
      <button class="btn">改</button><button class="btn primary">听写</button>`;
    li.querySelector('.name').textContent = l.name;
    li.querySelector('.name').onclick = () => openEditor(l);
    li.querySelectorAll('button')[0].onclick = () => openEditor(l);
    li.querySelectorAll('button')[1].onclick = () => openDictation(l.words);
    ul.appendChild(li);
  });
}

function openEditor(list) {
  editingId = list ? list.id : null;
  $('listName').value = list ? list.name : defaultName();
  $('wordsText').value = list ? list.words.join('\n') : '';
  $('deleteBtn').classList.toggle('hidden', !list);
  updateCount();
  show('edit');
}

function defaultName() {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日 听写`;
}

$('manualBtn').onclick = () => openEditor(null);

// ---------- 拍照识别 ----------
// 先用 PaddleOCR（中文准很多），手机不支持或加载失败时退回 Tesseract
const PADDLE_URL = 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/dist/index.mjs';
let paddleLoading = null; // 正在加载或已加载好的 PaddleOCR（同一时间只加载一份）
let paddleOcr = null;
let paddleErrors = 0;
let paddleFailed = false; // 这个手机用不了 PaddleOCR，本次打开 App 不再尝试

// PaddleOCR 需要 import map 和带 SIMD 的 WebAssembly（iOS 16.4 以上）
function paddleSupported() {
  try {
    const simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
    return typeof WebAssembly === 'object' && WebAssembly.validate(simd)
      && typeof HTMLScriptElement.supports === 'function' && HTMLScriptElement.supports('importmap');
  } catch { return false; }
}

function getPaddle() {
  if (!paddleLoading) {
    paddleLoading = import(PADDLE_URL)
      .then(({ PaddleOCR }) => PaddleOCR.create({
        textDetectionModelName: 'PP-OCRv6_tiny_det',
        textRecognitionModelName: 'PP-OCRv6_tiny_rec',
        ortOptions: { backend: 'wasm', numThreads: 1 },
      }))
      .then((ocr) => (paddleOcr = ocr))
      .catch((e) => { paddleLoading = null; throw e; }); // 失败了下次拍照再试
  }
  return paddleLoading;
}

// 有的手机上加载会一直卡住不报错，超时就当失败处理
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), ms))]);
}

// 让“正在识别”的提示先显示出来，再开始占用手机的计算
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));

async function recognize(canvas) {
  if (!paddleFailed && !paddleSupported()) paddleFailed = true;
  if (!paddleFailed) {
    try {
      $('ocrProgress').removeAttribute('value'); // 没有进度可报，显示来回滚动的进度条
      const ocr = await withTimeout(getPaddle(), 120000);
      $('ocrStatus').textContent = '正在识别文字…';
      await nextFrame();
      const [result] = await withTimeout(ocr.predict(canvas), 60000);
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      return wordsFromPaddle(result.items, img);
    } catch (e) {
      // 这一张先用 Tesseract；连着失败两次就不再试 PaddleOCR
      console.warn('PaddleOCR 这次没成功，改用 Tesseract', e);
      if (++paddleErrors >= 2) {
        paddleFailed = true;
        if (paddleOcr) paddleOcr.dispose().catch(() => {}); // 释放内存给 Tesseract
        paddleOcr = null;
      }
      $('ocrStatus').textContent = '正在准备识字工具…';
      $('ocrProgress').value = 0;
    }
  }
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  return wordsFromOcr(data);
}

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let ocrWorker = null;
let tesseractLoading = null;

// 识字工具比较大，等第一次拍照时才下载，不拖慢打开速度
function loadTesseract() {
  if (typeof Tesseract !== 'undefined') return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.onload = resolve;
      s.onerror = () => {
        s.remove();
        tesseractLoading = null; // 下次拍照再试
        reject(new Error('识字工具没有加载成功，请检查网络'));
      };
      document.head.appendChild(s);
    });
  }
  return tesseractLoading;
}

let workerLoading = null;
function getWorker() {
  if (!workerLoading) workerLoading = createWorker().catch((e) => { workerLoading = null; throw e; });
  return workerLoading;
}

async function createWorker() {
  await loadTesseract();
  const worker = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        $('ocrStatus').textContent = '正在识别文字…';
        $('ocrProgress').value = m.progress;
      } else if (m.status) {
        $('ocrStatus').textContent = '正在准备识字工具（第一次会慢一点）…';
      }
    },
  });
  // 让识字结果里的空格对应真实的空隙，汉字词之间才分得开
  await worker.setParameters({ preserve_interword_spaces: '1' });
  ocrWorker = worker;
  return ocrWorker;
}

// 缩小大照片，识别更快
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const max = 2000;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

let ocrSeq = 0; // 识别中途返回再拍一张时，丢掉上一张的结果

async function handleImage(file) {
  if (!file) return;
  const seq = ++ocrSeq;
  show('ocr');
  $('ocrProgress').value = 0;
  $('ocrStatus').textContent = '正在准备识字工具（第一次要下载十几 MB，会慢一点）…';
  try {
    const canvas = await loadImage(file);
    $('preview').src = canvas.toDataURL('image/jpeg', 0.8);
    const words = await recognize(canvas);
    if (seq !== ocrSeq || current !== 'ocr') return;
    openEditor(null);
    $('wordsText').value = words.join('\n');
    updateCount();
    if (!words.length) alert('没有识别到文字，可以换个角度再拍，或者手动输入');
  } catch (e) {
    console.error(e);
    if (seq !== ocrSeq || current !== 'ocr') return;
    alert('识别失败：' + e.message);
    show('home');
  }
}

$('cameraInput').onchange = (e) => { handleImage(e.target.files[0]); e.target.value = ''; };
$('galleryInput').onchange = (e) => { handleImage(e.target.files[0]); e.target.value = ''; };

// ---------- 编辑词表 ----------
function currentWords() {
  return $('wordsText').value.split('\n').map((w) => w.trim()).filter(Boolean);
}
function updateCount() { $('wordCount').textContent = `共 ${currentWords().length} 个词`; }
$('wordsText').oninput = updateCount;

$('resplitBtn').onclick = () => {
  $('wordsText').value = splitWords($('wordsText').value).join('\n');
  updateCount();
};

$('saveBtn').onclick = () => {
  const words = currentWords();
  if (!words.length) { alert('词表是空的'); return; }
  const lists = loadLists();
  const name = $('listName').value.trim() || defaultName();
  if (editingId) {
    const l = lists.find((x) => x.id === editingId);
    if (l) { l.name = name; l.words = words; }
  } else {
    editingId = String(Date.now());
    lists.unshift({ id: editingId, name, words, createdAt: Date.now() });
  }
  saveLists(lists);
  openDictation(words);
};

$('deleteBtn').onclick = () => {
  if (!confirm('确定删除这个词表吗？')) return;
  saveLists(loadLists().filter((l) => l.id !== editingId));
  show('home');
};

// ---------- 听写 ----------
let queue = [];
let idx = 0;
let runToken = 0; // 每次跳转/暂停都换一个，用来打断正在进行的自动播放
let paused = false;

function openDictation(words) {
  queue = words.slice();
  $('setup').classList.remove('hidden');
  $('running').classList.add('hidden');
  show('dictate');
}

function settings() {
  return {
    repeat: Number($('repeatSel').value),
    gap: Number($('gapSel').value) * 1000,
    rate: Number($('rateSel').value),
  };
}

$('startBtn').onclick = () => {
  if ($('shuffleChk').checked) {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
  }
  idx = 0;
  paused = false;
  $('pauseBtn').textContent = '暂停';
  $('total').textContent = queue.length;
  $('setup').classList.add('hidden');
  $('running').classList.remove('hidden');
  playFrom(idx);
};

async function playFrom(i) {
  const token = ++runToken;
  speechSynthesis.cancel();
  idx = i;
  $('curIdx').textContent = idx + 1;
  const { repeat, gap, rate } = settings();
  const bubble = $('bubble');

  for (let r = 0; r < repeat; r++) {
    bubble.classList.add('speaking');
    await speak(queue[idx], rate);
    bubble.classList.remove('speaking');
    if (token !== runToken) return;
    if (r < repeat - 1) await sleep(1500);
    if (token !== runToken) return;
  }

  if (!gap) return; // 手动模式
  await sleep(gap);
  if (token !== runToken || paused) return;
  if (idx < queue.length - 1) playFrom(idx + 1);
  else $('runHint').textContent = '全部读完啦！点“结束，去对答案”';
}

function stopDictation() {
  runToken++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $('bubble').classList.remove('speaking');
}

$('nextBtn').onclick = () => { if (idx < queue.length - 1) { paused = false; playFrom(idx + 1); } };
$('prevBtn').onclick = () => { if (idx > 0) { paused = false; playFrom(idx - 1); } };
$('repeatBtn').onclick = async () => {
  const token = ++runToken;
  speechSynthesis.cancel();
  $('bubble').classList.add('speaking');
  await speak(queue[idx], settings().rate);
  if (token === runToken) $('bubble').classList.remove('speaking');
};
$('pauseBtn').onclick = () => {
  paused = !paused;
  $('pauseBtn').textContent = paused ? '继续' : '暂停';
  if (paused) stopDictation();
  else playFrom(idx);
};
$('finishBtn').onclick = () => { stopDictation(); openCheck(); };

// ---------- 对答案 ----------
let checkWords = [];

function openCheck() {
  checkWords = queue.map((w) => ({ w, wrong: false }));
  const ul = $('checkList');
  ul.innerHTML = '';
  checkWords.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item.w;
    li.onclick = () => {
      item.wrong = !item.wrong;
      li.classList.toggle('wrong', item.wrong);
      updateScore();
    };
    ul.appendChild(li);
  });
  updateScore();
  show('check');
}

function updateScore() {
  const right = checkWords.filter((x) => !x.wrong).length;
  const total = checkWords.length;
  const stars = right === total ? ' 🌟 全对！' : '';
  $('score').textContent = `${right} / ${total}${stars}`;
  $('retryWrongBtn').classList.toggle('hidden', right === total);
}

$('retryWrongBtn').onclick = () => openDictation(checkWords.filter((x) => x.wrong).map((x) => x.w));
$('homeBtn').onclick = () => show('home');

// ---------- 启动 ----------
// 启动画面至少停留一会儿，点一下可以跳过
function hideSplash() {
  const s = $('splash');
  if (!s || s.classList.contains('hide')) return;
  s.classList.add('hide');
  setTimeout(() => s.remove(), 500);
}
$('splash').onclick = hideSplash;
setTimeout(hideSplash, 1200);

$('version').textContent = `版本 ${APP_VERSION}`;
show('home');
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
