// 拆词逻辑的测试：node tests/split.test.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const textSection = src.slice(src.indexOf('const CJK'), src.indexOf('// ---------- 语音'));
const { splitWords, wordsFromOcr } = new Function(`${textSection}; return { splitWords, wordsFromOcr };`)();

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

if (typeof Intl.Segmenter === 'function') {
  const words = splitWords('小草从地下探出头来。');
  check('长句子拆成词，不留单个字', words.every((w) => w.length >= 2) && words.includes('小草'), true);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
