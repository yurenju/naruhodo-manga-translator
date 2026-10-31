/**
 * 仿直式捲動（縦読み）網站（spec #142）：兩張合成頁上下接成一張 880×2560 的長 canvas（像直式捲動漫畫那樣，接縫看不出來），
 * 圖片來自另一個 origin 所以 canvas 是 tainted。canvas 放在自己捲動的容器（`#scroller`）裡，顯示寬 440、高 1280；
 * 容器只有 440×640，剛好露出一張合成頁的高度，所以 scrollTop 0 看到第 1 張、640 看到第 2 張。
 * 畫完後 body 會有 data-ready="true"。
 */
export const VERTICAL_PAGES = ['p01-basic', 'p02-ruby'];

/** 容器的可見高度＝一張合成頁顯示出來的高度（CSS px）。 */
export const VERTICAL_VIEW_HEIGHT = 640;

export function verticalScrollPage(imageOrigin: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>直式捲動漫畫網站（模擬）</title>
<style>
  body { margin: 0; background: #222; font-family: sans-serif; }
  #scroller { width: 440px; height: ${VERTICAL_VIEW_HEIGHT}px; margin: 16px auto 0; overflow-y: auto; scrollbar-width: none; }
  #scroller canvas { width: 440px; height: ${VERTICAL_VIEW_HEIGHT * VERTICAL_PAGES.length}px; display: block; }
</style>
</head>
<body>
<div id="scroller"><canvas id="episode" width="880" height="${1280 * VERTICAL_PAGES.length}"></canvas></div>
<script>
  const imageOrigin = ${JSON.stringify(imageOrigin)};
  const ctx = document.getElementById('episode').getContext('2d');
  Promise.all(${JSON.stringify(VERTICAL_PAGES)}.map((id, i) => new Promise((resolve, reject) => {
    const img = new Image(); // 沒有 crossOrigin：畫進 canvas 後就 tainted
    img.onload = () => { ctx.drawImage(img, 0, i * 1280); resolve(); };
    img.onerror = reject;
    img.src = imageOrigin + '/' + id + '.png';
  }))).then(() => { document.body.dataset.ready = 'true'; });
</script>
</body>
</html>`;
}
