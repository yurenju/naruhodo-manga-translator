/**
 * PROTOTYPE（拋棄式）：onboarding 的「預先下載辨識模型」要怎麼告知，加上第 4 步改成「到試翻頁試試看」。
 * 問題：下載要早點開始，但又要讓使用者知道在下載什麼；簡單與告知之間的平衡長什麼樣子？
 * 外框照抄 src/onboarding/main.tsx 的 class（ob-*），登入與選方案是假的，下載是計時器模擬。
 *
 * A 自動下載、角落小字　B 自動下載、事先說明＋卡片頂端進度條　C 讓使用者勾選要不要現在下載
 * D 第 1 步說明（不勾選）、按「開始設定」才開始下載，之後用 A 的角落小字
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Button } from '../../../src/ui/components.tsx';
import logoSrc from '../../../src/icons/naruhodo.svg?url';
import { mountSwitcher } from './switcher.ts';

type Variant = 'A' | 'B' | 'C' | 'D';
type Step = 'intro' | 'signIn' | 'plan' | 'tutorial';
type Download = { phase: 'idle' | 'downloading' | 'ready'; loaded: number };

const STEPS: { step: Step; title: string }[] = [
  { step: 'intro', title: '說明' },
  { step: 'signIn', title: '同意並登入' },
  { step: 'plan', title: '選擇方案' },
  { step: 'tutorial', title: '開始翻譯' },
];

const TRY_URL = '/try-prototype/';

function useDownload(total: number, seconds: number) {
  const [download, setDownload] = useState<Download>({ phase: 'idle', loaded: 0 });
  useEffect(() => {
    if (download.phase !== 'downloading') return;
    const timer = setInterval(() => {
      setDownload((d) => {
        const loaded = Math.min(total, d.loaded + total / (seconds * 10));
        return loaded >= total ? { phase: 'ready', loaded: total } : { ...d, loaded };
      });
    }, 100);
    return () => clearInterval(timer);
  }, [download.phase, total, seconds]);
  const start = () => setDownload((d) => (d.phase === 'idle' ? { phase: 'downloading', loaded: 0 } : d));
  const reset = () => setDownload({ phase: 'idle', loaded: 0 });
  return { download, start, reset };
}

const mb = (n: number) => Math.round(n);

function Dots({ current }: { current: Step }) {
  const index = STEPS.findIndex((s) => s.step === current);
  return (
    <ol class="ob-dots" aria-label="步驟">
      {STEPS.map((s, i) => (
        <li key={s.step} class={i < index ? 'done' : i === index ? 'cur' : undefined}>
          <span aria-hidden="true">{i + 1}</span>
          {s.title}
        </li>
      ))}
    </ol>
  );
}

function ProgressText({ download, total }: { download: Download; total: number }) {
  if (download.phase === 'ready') return <>✓ 辨識模型已就緒</>;
  if (download.phase === 'idle') return <>辨識模型尚未下載</>;
  return (
    <>
      正在下載辨識模型 {mb(download.loaded)} / {total} MB
    </>
  );
}

function App() {
  const [variant, setVariant] = useState<Variant>(() => (new URLSearchParams(location.search).get('variant') as Variant) || 'A');
  const [step, setStep] = useState<Step>('intro');
  const [total, setTotal] = useState(472);
  const [seconds, setSeconds] = useState(40);
  const [optIn, setOptIn] = useState(true);
  const { download, start, reset } = useDownload(total, seconds);

  useEffect(() => mountSwitcher({ A: '自動下載・角落小字', B: '自動下載・事先說明＋進度條', C: '讓使用者勾選', D: '說明＋按下後角落小字' }, (key) => {
    setVariant(key as Variant);
    setStep('intro');
    reset();
  }), []);

  // A、B：onboarding 一打開就開始
  useEffect(() => {
    if ((variant === 'A' || variant === 'B') && download.phase === 'idle') start();
  }, [variant, download.phase]);

  const pct = Math.round((download.loaded / total) * 100);

  return (
    <div class="ob">
      {/* 模擬用的控制，不是設計的一部分 */}
      <div class="proto-panel">
        <strong>模擬</strong>
        <label>
          <input type="radio" checked={total === 472} onChange={() => { setTotal(472); reset(); }} /> WebGPU 472 MB
        </label>
        <label>
          <input type="radio" checked={total === 128} onChange={() => { setTotal(128); reset(); }} /> wasm 128 MB
        </label>
        <label>
          <input type="radio" checked={seconds === 40} onChange={() => setSeconds(40)} /> 40 秒
        </label>
        <label>
          <input type="radio" checked={seconds === 180} onChange={() => setSeconds(180)} /> 3 分鐘
        </label>
        <code>
          variant={variant} step={step} download={download.phase} {pct}%
        </code>
      </div>

      <header class="ob-brand">
        <img src={logoSrc} alt="" width={24} height={24} />
        Naruhodo
      </header>
      <Dots current={step} />

      {variant === 'B' && download.phase !== 'idle' && (
        <div class="proto-topbar" title="辨識模型">
          <div class="proto-topbar__track">
            <div class="proto-topbar__fill" style={{ width: `${pct}%` }} />
          </div>
          <span>
            <ProgressText download={download} total={total} />
          </span>
        </div>
      )}

      <main class="ob-card">
        {step === 'intro' && (
          <>
            <h1 class="ob-h1">歡迎使用 Naruhodo</h1>
            <p class="ob-lead">在日文漫畫網站上，把對話框直接換成中文；也可以保留日文、滑過看讀音，拿來學日文。</p>
            <div class="ob-price">
              <ul>
                <li>用 email 註冊之後，有 <strong>50 頁的免費額度</strong>（大約兩話），不用輸入付款資料。</li>
                <li>試用滿意的話，可以訂閱：年繳 US$20，每月可翻 800 頁。</li>
                <li>回頭看已經翻過的頁面不會扣頁數；翻譯失敗也不扣。</li>
              </ul>
            </div>
            {variant === 'B' && (
              <p class="hint">
                辨識日文的模型會在你的電腦上執行。我們已經開始在背景下載（約 {total} MB，只需要一次），你繼續設定就好。
              </p>
            )}
            {variant === 'C' && (
              <label class="proto-optin">
                <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.currentTarget.checked)} />
                <span>
                  設定時順便在背景下載辨識模型（約 {total} MB，只需要一次）
                  <br />
                  <span class="hint">不勾的話，會在第一次翻譯時才下載。</span>
                </span>
              </label>
            )}
            {variant === 'D' && (
              <p class="proto-notice">
                按下「開始設定」之後，會在背景下載辨識日文的模型（約 {total} MB，只需要一次）。
              </p>
            )}
            <Button
              variant="primary"
              class="ob-big"
              onClick={() => {
                if ((variant === 'C' && optIn) || variant === 'D') start();
                setStep('signIn');
              }}
            >
              開始設定
            </Button>
          </>
        )}

        {step === 'signIn' && (
          <>
            <h2 class="ob-h2">同意並登入</h2>
            <p>（假的）輸入 email，收驗證碼。</p>
            <form onSubmit={(e) => { e.preventDefault(); setStep('plan'); }}>
              <label>
                Email
                <input type="email" value="reader@example.com" />
              </label>
              <Button variant="primary" type="submit">同意並寄送驗證碼</Button>
            </form>
          </>
        )}

        {step === 'plan' && (
          <>
            <h2 class="ob-h2">選擇方案</h2>
            <div class="ob-plans">
              <div class="ob-plan">
                <p class="ob-plan__name">免費額度</p>
                <p class="ob-plan__price">50 頁</p>
                <Button variant="secondary" onClick={() => setStep('tutorial')}>先用免費額度</Button>
              </div>
              <div class="ob-plan ob-plan--hl">
                <p class="ob-plan__name">訂閱</p>
                <p class="ob-plan__price">US$20 / 年</p>
                <Button variant="primary" onClick={() => setStep('tutorial')}>訂閱</Button>
              </div>
            </div>
          </>
        )}

        {step === 'tutorial' && (
          <>
            <h2 class="ob-h2">設定完成，來試翻一頁吧</h2>
            <p>我們準備了一張試翻頁的日文漫畫，<strong>這一頁不會用到額度。</strong></p>
            {variant === 'B' && (
              <div class={`proto-status ${download.phase === 'ready' ? 'ok' : ''}`}>
                <ProgressText download={download} total={total} />
                {download.phase === 'downloading' && <span class="hint">　還沒下載完也可以先去，翻譯時會接著下載。</span>}
              </div>
            )}
            {variant === 'C' && download.phase === 'idle' && (
              <div class="proto-status">
                辨識模型還沒下載（約 {total} MB）。
                <Button variant="link" onClick={start}>現在下載</Button>
                <span class="hint">　或在第一次翻譯時自動下載。</span>
              </div>
            )}
            {variant === 'C' && download.phase !== 'idle' && (
              <div class={`proto-status ${download.phase === 'ready' ? 'ok' : ''}`}>
                <ProgressText download={download} total={total} />
              </div>
            )}
            <p style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' }}>
              <Button variant="primary" class="ob-big" onClick={() => window.open(TRY_URL, '_blank')}>
                到試翻頁試試看
              </Button>
              <Button variant="secondary" class="ob-big" onClick={() => alert('（prototype）關掉 onboarding 分頁')}>
                完成
              </Button>
            </p>
            <p class="hint">之後在任何日文漫畫網站，點工具列上的 Naruhodo 圖示或按 Alt+Shift+M 就能翻譯。</p>
          </>
        )}
      </main>
      <p class="ob-foot">已經有 Anthropic API key？使用自備金鑰</p>

      {(variant === 'A' || variant === 'D') && download.phase !== 'idle' && (
        <div class={`proto-pill ${download.phase === 'ready' ? 'ok' : ''}`} title="外掛在背景下載辨識日文的模型，只需要一次">
          {download.phase === 'downloading' && <span class="proto-spin" aria-hidden="true" />}
          <ProgressText download={download} total={total} />
        </div>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
