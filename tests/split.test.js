// 拆词逻辑的测试：node tests/split.test.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const textSection = src.slice(src.indexOf('const CJK'), src.indexOf('// ---------- 语音'));
const { splitWords, wordsFromOcr, splitLineByGaps, wordsFromPaddle, readingOrder } = new Function(
  `${textSection}; return { splitWords, wordsFromOcr, splitLineByGaps, wordsFromPaddle, readingOrder };`
)();

// 模拟识字结果：每行是 [词, 和前一个词的距离(px), 识字文字里前面有没有空格]
// 汉字宽 48px，英文字母宽 24px，同一个词里字和字之间隔 4px
function fakeOcr(lines) {
  let text = '';
  const ocrLines = lines.map((words) => {
    let x = 0;
    const ocrWords = words.map(([word, gap, space]) => {
      x += gap;
      if (space) text += ' ';
      text += word;
      const symbols = [...word].map((ch) => {
        const w = /[a-z]/i.test(ch) ? 24 : 48;
        const s = { text: ch, bbox: { x0: x, x1: x + w, y0: 0, y1: 48 } };
        x += w + 4;
        return s;
      });
      return { symbols };
    });
    text += '\n';
    return { words: ocrWords };
  });
  return { text, lines: ocrLines };
}

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    得到 ${JSON.stringify(actual)}\n    应为 ${JSON.stringify(expected)}`}`);
  if (!ok) failed++;
}

check('手动输入按空格和标点拆', splitWords('春天 花朵，四面八方\napple, banana 12'), ['春天', '花朵', '四面八方', 'apple', 'banana']);
check('去掉重复的词', splitWords('春天\n春天\n花朵'), ['春天', '花朵']);
check('识字文字里有空格就分开', wordsFromOcr(fakeOcr([[['小草', 0, 0], ['柳树', 30, 1]]])), ['小草', '柳树']);
check('词里的字挨得近就不拆', wordsFromOcr(fakeOcr([[['春', 0, 0], ['夏', 60, 1], ['秋冬', 60, 1]]])), ['春', '夏', '秋冬']);
check('文字连在一起但隔得远的两个字要拆开', wordsFromOcr(fakeOcr([[['秋', 0, 0], ['冬', 60, 0]]])), ['秋', '冬']);
check('换行就是新词', wordsFromOcr(fakeOcr([[['春天', 0, 0]], [['花朵', 0, 0]]])), ['春天', '花朵']);
check('英文单词', wordsFromOcr(fakeOcr([[['apple', 0, 0], ['banana', 30, 1]]])), ['apple', 'banana']);
check('中英文连在一起要拆开', wordsFromOcr(fakeOcr([[['苹果', 0, 0], ['apple', 4, 0]]])), ['苹果', 'apple']);
check('没有位置信息时只看文字', wordsFromOcr({ text: '春天 花朵', lines: [] }), ['春天', '花朵']);

check('拼音（带声调）不要', splitWords('huā 花 yǔ 雨 niăo'), ['花', '雨']);
check('中英文连写拆开', splitWords('苹果apple学校school'), ['苹果', 'apple', '学校', 'school']);
check('拼音和汉字连写，只去掉拼音', splitWords('dà大 xiǎo小 爱ài'), ['大', '小', '爱']);

// ---- 按照片上的空隙分词（PaddleOCR 一行字是连在一起给出的）----
// 白底图片；“字”用黑色方块代替：每个字 36px 宽，字与字相距 40px
function blankImage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  return { width, height, data };
}
function rect(img, x, y, w, h, [r, g, b] = [20, 20, 20]) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * img.width + xx) * 4;
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
  }
}
// 画一个字：左右两个部件，中间留一点空（像“川”“林”这种字内有空隙的字）
function glyph(img, x, y, w = 36, h = 36) {
  rect(img, x, y, Math.round(w * 0.45), h);
  rect(img, x + Math.round(w * 0.55), y, w - Math.round(w * 0.55), h);
}
// 按词画一行：words 是每个词的字数，gap 是词与词之间多空出来的距离
function drawLine(img, words, gap, { y = 20, x = 20, widths = {}, pitch = 40 } = {}) {
  let k = 0;
  for (const n of words) {
    for (let i = 0; i < n; i++, k++) { glyph(img, x, y, widths[k] || 36); x += pitch; }
    x += gap;
  }
  return [[10, y - 8], [x + 10, y - 8], [x + 10, y + 44], [10, y + 44]];
}

{
  const img = blankImage(600, 80);
  const poly = drawLine(img, [2, 2, 2], 40);
  check('词语表：词与词空开就拆', splitLineByGaps(img, poly, '燕子桃花春雨'), '燕子\n桃花\n春雨');
}
{
  const img = blankImage(600, 80);
  const poly = drawLine(img, [1, 1, 1, 1, 1], 30, { widths: { 2: 14 } }); // 第 3 个字很窄，比如“卜”
  check('生字表：一个一个拆开，窄字也算一个', splitLineByGaps(img, poly, '春夏卜冬风'), '春\n夏\n卜\n冬\n风');
}
{
  const img = blankImage(600, 80);
  const poly = drawLine(img, [1, 3, 4], 40);
  check('长短不一的词', splitLineByGaps(img, poly, '山向日葵五颜六色'), '山\n向日葵\n五颜六色');
}
{
  const img = blankImage(600, 80);
  const poly = drawLine(img, [4], 0);
  check('一个词自己一行就不拆', splitLineByGaps(img, poly, '自言自语'), '自言自语');
}
{
  const img = blankImage(900, 80);
  const poly = drawLine(img, [12], 0);
  check('课文（字距均匀）不拆', splitLineByGaps(img, poly, '春天来了小草从地下探出头'), '春天来了小草从地下探出头');
}
{
  const img = blankImage(600, 80);
  const poly = drawLine(img, [2, 2], 40);
  check('识别出的字数和照片对不上就不拆', splitLineByGaps(img, poly, '燕子桃花春'), '燕子桃花春');
  check('有英文的行不拆', splitLineByGaps(img, poly, '苹果apple'), '苹果apple');
}
{
  // 田字格：格子挨着，绿色格线把字隔开，中间还有横的虚线
  const img = blankImage(400, 90);
  for (let i = 0; i < 5; i++) {
    const x = 20 + i * 60;
    rect(img, x, 10, 2, 60, [42, 138, 58]);
    for (let d = x; d < x + 60; d += 10) rect(img, d, 40, 5, 1, [42, 138, 58]);
    glyph(img, x + 12, 22, 36, 36);
  }
  rect(img, 320, 10, 2, 60, [42, 138, 58]);
  rect(img, 20, 10, 302, 2, [42, 138, 58]);
  rect(img, 20, 68, 302, 2, [42, 138, 58]);
  const poly = [[15, 8], [326, 8], [326, 72], [15, 72]];
  check('田字格里的字一个一个拆开', splitLineByGaps(img, poly, '山水田火木'), '山\n水\n田\n火\n木');
}
{
  // 识别结果顺序乱了，拼音在字的正上方而且比字小
  const img = blankImage(600, 200);
  drawLine(img, [1, 1], 40, { y: 100 });
  const items = [
    { text: '雨', poly: [[140, 92], [180, 92], [180, 140], [140, 140]] },
    { text: 'huā', poly: [[20, 60], [60, 60], [60, 80], [20, 80]] },
    { text: '花', poly: [[16, 92], [60, 92], [60, 140], [16, 140]] },
    { text: 'yu', poly: [[140, 60], [180, 60], [180, 80], [140, 80]] },
    { text: 'apple', poly: [[300, 92], [420, 92], [420, 140], [300, 140]] },
  ];
  check('按阅读顺序排，去掉字上面的拼音，旁边的英文保留', wordsFromPaddle(items, img), ['花', '雨', 'apple']);
}

{
  // 楷体：同一个词里的字也会空出小半个字（这里 12px，字高 36px）
  const img = blankImage(400, 80);
  const poly = drawLine(img, [2], 0, { pitch: 48 });
  check('楷体字距宽一点的词也不拆', splitLineByGaps(img, poly, '明天'), '明天');
  const img2 = blankImage(600, 80);
  const poly2 = drawLine(img2, [4], 0, { pitch: 48 });
  check('楷体成语不拆', splitLineByGaps(img2, poly2, '五颜六色'), '五颜六色');
  const img3 = blankImage(800, 80);
  const poly3 = drawLine(img3, [2, 2, 2], 40, { pitch: 48 });
  check('楷体词语表照样按词拆', splitLineByGaps(img3, poly3, '燕子桃花春雨'), '燕子\n桃花\n春雨');
}
{
  // “引”：左边“弓”，右边一根细竖，竖两边都有空
  const img = blankImage(300, 80);
  rect(img, 20, 20, 20, 36);
  rect(img, 46, 20, 4, 36);
  rect(img, 58, 20, 36, 36);
  check('细竖笔画不能当成空隙', splitLineByGaps(img, [[10, 12], [104, 12], [104, 64], [10, 64]], '引号'), '引号');
}
{
  // 大图片（字高 72px）：不能因为图片大就把词拆成单字
  const img = blankImage(1400, 140);
  const big = (x) => glyph(img, x, 20, 72, 72);
  let x = 20;
  for (let w = 0; w < 3; w++) { big(x); x += 105; big(x); x += 80 + 130; }
  const poly = [[10, 8], [x, 8], [x, 104], [10, 104]];
  check('大照片里的词语表', splitLineByGaps(img, poly, '燕子桃花春雨'), '燕子\n桃花\n春雨');
}
{
  // 英文单词表：识别结果把单词连在了一起
  const img = blankImage(800, 80);
  let x = 20;
  const letters = (word) => { for (const ch of word) { const w = /[il]/.test(ch) ? 6 : 20; rect(img, x, 24, w, 28); x += w + 4; } x += 36; };
  ['cat', 'dog', 'duck', 'bird'].forEach(letters);
  check('连在一起的英文单词按空隙拆开', splitLineByGaps(img, [[10, 12], [x, 12], [x, 64], [10, 64]], 'catdogduckbird'), 'cat dog duck bird');
}
{
  // 照片右边高左边低（拍歪了），每行 4 个词
  const tilt = (x, y) => [[x, y - 0.05 * x], [x + 80, y - 0.05 * (x + 80)], [x + 80, y + 40 - 0.05 * (x + 80)], [x, y + 40 - 0.05 * x]];
  const items = ['桃花', '春雨', '柳树', '燕子'].map((t, i) => ({ text: t, poly: tilt(20 + i * 200, 100) }))
    .concat(['荷叶', '池塘', '蜻蜓', '青蛙'].map((t, i) => ({ text: t, poly: tilt(20 + i * 200, 180) })));
  check('拍歪的照片也按行从左到右', readingOrder(items.slice().reverse()).map((it) => it.text).join(' '), '桃花 春雨 柳树 燕子 荷叶 池塘 蜻蜓 青蛙');
}
{
  // 轻声拼音（jie）带着 j 往下伸，拼音框差不多和汉字一样高
  const img = blankImage(400, 200);
  const items = [
    { text: 'jiě jie', poly: [[36, 36], [130, 36], [130, 83], [36, 83]] },
    { text: '姐姐', poly: [[44, 88], [142, 88], [142, 139], [44, 139]] },
  ];
  check('带声调的拼音行整行去掉（包括轻声）', wordsFromPaddle(items, img), ['姐姐']);
}

if (typeof Intl.Segmenter === 'function') {
  const words = splitWords('小草从地下探出头来。');
  check('长句子拆成词，不留单个字', words.every((w) => w.length >= 2) && words.includes('小草'), true);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
