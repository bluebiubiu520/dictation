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

// 按空白和标点拆成词，去重，保留顺序
function splitWords(text) {
  const parts = text
    .split(SEPARATORS)
    .flatMap((w) => (hasCJK(w) && w.length > MAX_WORD_LEN ? segmentSentence(w) : [w]))
    .filter((w) => w && (hasCJK(w) || /[a-zA-Z]{2,}/.test(w)))
    .filter((w) => !/^\d+$/.test(w));
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

async function getWorker() {
  if (ocrWorker) return ocrWorker;
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

async function handleImage(file) {
  if (!file) return;
  show('ocr');
  $('ocrProgress').value = 0;
  $('ocrStatus').textContent = '正在准备识字工具（第一次会慢一点）…';
  try {
    const canvas = await loadImage(file);
    $('preview').src = canvas.toDataURL('image/jpeg', 0.8);
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    const words = wordsFromOcr(data);
    openEditor(null);
    $('wordsText').value = words.join('\n');
    updateCount();
    if (!words.length) alert('没有识别到文字，可以换个角度再拍，或者手动输入');
  } catch (e) {
    console.error(e);
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
