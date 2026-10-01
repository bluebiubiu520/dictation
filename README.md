# 小听写

给小学生用的听写网页应用：拍课本 → 识别出中英文词语 → 校对词表 → 手机朗读报听写 → 对答案、错词重听。

## 技术

- 纯前端，无需后端、无需构建：`index.html` + `app.js` + `style.css`
- 文字识别：[PaddleOCR.js](https://www.npmjs.com/package/@paddleocr/paddleocr-js)（PP-OCRv6 tiny，浏览器内运行，第一次拍照下载约 12MB，之后缓存在手机上）。识别出的一行字再按照片上的空隙拆成生字、词语。
  手机不支持（需要 iOS 16.4 以上 / 支持 WebAssembly SIMD 的浏览器）或加载失败时，自动改用 [Tesseract.js](https://github.com/naptha/tesseract.js)
- 朗读：浏览器自带的 Web Speech API（中文用 zh-CN，英文用 en-US，自动判断）
- 词表保存在浏览器 localStorage
- PWA：可在手机上“添加到主屏幕”，离线也能听写已保存的词表

## 本地运行

```bash
python3 -m http.server 8080
```

然后打开 http://localhost:8080 。手机要调用摄像头需要 HTTPS（或 localhost），部署到任意静态托管（GitHub Pages、Vercel、Netlify）即可。

## 测试

```bash
node tests/split.test.js
```
