/**
 * 盤點時操作 debug Chrome（npm run debug:chrome，port 9222）的分頁：node .claude/skills/audit-extension/tools/cdp.ts <指令> ...
 *   list                                   列出網頁分頁
 *   open <url>                             開新分頁並切到前景，印出 targetId
 *   nav <urlPart> <url>                    url 含 urlPart 的分頁導航到 url
 *   shot <urlPart> <out.png> [x y w h]     截可見區域；給了 x y w h（CSS px）就只截那塊並放大 2 倍
 *   key <urlPart> <Key>                    送按鍵：ArrowLeft、ArrowRight、ArrowDown、ArrowUp、Space、PageDown
 *   click <urlPart> <x> <y>                在 CSS 座標點一下
 *   wheel <urlPart> <dy> [x y]             在 (x, y) 滾動 dy CSS px（預設視窗中央），直式 viewer 用
 *   size <urlPart> <w> <h>                 設定那個分頁所在視窗的大小
 *   panel text [--tab N]                   side panel（sidepanel.html?tabId=N）畫面上的文字；空字串＝沒渲染出來
 *   panel shot <out.png> [--tab N]         截 side panel
 *   panel reload [--tab N]                 重新載入 side panel，印出 5 秒內的例外與 console，再印畫面文字
 *   開著不只一個 side panel 時用 --tab 指定 tabId（debug:activate 會印出來）。
 * 在頁面裡執行程式用 npm run debug:eval -- page --url <urlPart> -e "<運算式>"。
 */
import { writeFileSync } from 'node:fs';
import { connectCdp, type Cdp } from '../../../../scripts/debug-chrome.ts';

const PORT = 9222;
const KEY_CODES: Record<string, number> = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32, PageDown: 34 };

interface PageTarget {
  targetId: string;
  url: string;
}

async function pages(cdp: Cdp): Promise<PageTarget[]> {
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: (PageTarget & { type: string })[] };
  return targetInfos.filter((t) => t.type === 'page' && /^https?:/.test(t.url));
}

async function pick(cdp: Cdp, urlPart: string): Promise<PageTarget> {
  const all = await pages(cdp);
  const target = all.find((t) => t.url.includes(urlPart));
  if (target === undefined) throw new Error(`找不到 url 含 ${urlPart} 的分頁：\n${all.map((t) => t.url).join('\n')}`);
  return target;
}

/** 接上分頁，回傳之後送指令要帶的 sessionId。 */
async function attach(cdp: Cdp, urlPart: string): Promise<{ target: PageTarget; sessionId: string }> {
  const target = await pick(cdp, urlPart);
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })) as { sessionId: string };
  return { target, sessionId };
}

async function viewport(cdp: Cdp, sessionId: string): Promise<{ width: number; height: number; dpr: number }> {
  const { result } = await cdp.send(
    'Runtime.evaluate',
    { expression: '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })', returnByValue: true },
    sessionId,
  );
  return result.value;
}

/** 接上 side panel：cdp.ts 其他指令只認 http(s) 分頁，看不到 chrome-extension:// 的 side panel。 */
async function attachPanel(cdp: Cdp, tab: string | undefined): Promise<string> {
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: (PageTarget & { type: string })[] };
  const panels = targetInfos.filter((t) => t.type === 'page' && t.url.includes('/sidepanel.html') && (tab === undefined || t.url.endsWith(`tabId=${tab}`)));
  if (panels.length !== 1)
    throw new Error(`找到 ${panels.length} 個 side panel${tab === undefined ? '，用 --tab <tabId> 指定' : ''}：\n${panels.map((t) => t.url).join('\n')}`);
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: panels[0]!.targetId, flatten: true })) as { sessionId: string };
  return sessionId;
}

async function panelText(cdp: Cdp, sessionId: string): Promise<string> {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sessionId);
  return result.value === '' ? '（side panel 是空白的：#app 沒有渲染出來）' : result.value;
}

async function panel(cdp: Cdp, [action, out]: string[], tab: string | undefined): Promise<string> {
  const sessionId = await attachPanel(cdp, tab);
  switch (action) {
    case 'text':
      return panelText(cdp, sessionId);
    case 'shot': {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(out!, Buffer.from(data, 'base64'));
      return out!;
    }
    case 'reload': {
      const logs: string[] = [];
      cdp.on((message) => {
        const { method, params } = message as { method?: string; params?: any; sessionId?: string };
        if ((message as { sessionId?: string }).sessionId !== sessionId) return;
        if (method === 'Runtime.exceptionThrown') logs.push(`例外 ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
        if (method === 'Runtime.consoleAPICalled') logs.push(`console.${params.type} ${params.args.map((a: any) => a.value ?? a.description).join(' ')}`);
      });
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Page.reload', {}, sessionId);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return [...(logs.length > 0 ? logs : ['（沒有例外或 console 輸出）']), '---', await panelText(cdp, sessionId)].join('\n');
    }
    default:
      throw new Error(`panel 要接 text、shot 或 reload`);
  }
}

async function run(cdp: Cdp, [cmd, ...args]: string[]): Promise<string> {
  if (cmd === 'panel') {
    const at = args.indexOf('--tab');
    const tab = at === -1 ? undefined : args.splice(at, 2)[1];
    return panel(cdp, args, tab);
  }
  const [urlPart = ''] = args;
  switch (cmd) {
    case 'list':
      return (await pages(cdp)).map((t) => t.url).join('\n');
    case 'open': {
      const { targetId } = await cdp.send('Target.createTarget', { url: urlPart });
      await cdp.send('Target.activateTarget', { targetId });
      return targetId;
    }
    case 'nav': {
      const { sessionId } = await attach(cdp, urlPart);
      await cdp.send('Page.navigate', { url: args[1] }, sessionId);
      return 'ok';
    }
    case 'shot': {
      const { target, sessionId } = await attach(cdp, urlPart);
      // 背景分頁不會畫新的 frame，截圖會卡住
      await cdp.send('Target.activateTarget', { targetId: target.targetId });
      const [x, y, width, height] = args.slice(2, 6).map(Number);
      const clip = width === undefined ? undefined : { x, y, width, height, scale: 2 };
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }, sessionId);
      writeFileSync(args[1]!, Buffer.from(data, 'base64'));
      const { width: w, height: h, dpr } = await viewport(cdp, sessionId);
      return `${args[1]}（視窗 ${w}×${h} CSS px，devicePixelRatio ${dpr}${clip ? '，clip 放大 2 倍' : '：截圖像素 ÷ dpr＝CSS 座標'}）`;
    }
    case 'key': {
      const { sessionId } = await attach(cdp, urlPart);
      const code = args[1]!;
      const key = code === 'Space' ? ' ' : code;
      for (const type of ['rawKeyDown', 'keyUp'])
        await cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: KEY_CODES[code] }, sessionId);
      return 'ok';
    }
    case 'click': {
      const { sessionId } = await attach(cdp, urlPart);
      const [x, y] = [Number(args[1]), Number(args[2])];
      for (const type of ['mousePressed', 'mouseReleased'])
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
      return 'ok';
    }
    case 'wheel': {
      const { sessionId } = await attach(cdp, urlPart);
      const { width, height } = await viewport(cdp, sessionId);
      const [x = width / 2, y = height / 2] = args.slice(2, 4).map(Number);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Number(args[1]) }, sessionId);
      return 'ok';
    }
    case 'size': {
      const { target } = await attach(cdp, urlPart);
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: target.targetId });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: Number(args[1]), height: Number(args[2]) } });
      return 'ok';
    }
    default:
      throw new Error(`未知指令 ${cmd}；用法見 ${import.meta.filename} 開頭`);
  }
}

const cdp = await connectCdp(PORT).catch(() => {
  throw new Error(`port ${PORT} 沒有開著的 Chrome；先在 Terminal 面板跑 npm run debug:chrome`);
});
try {
  console.log(await run(cdp, process.argv.slice(2)));
} finally {
  cdp.close();
}
