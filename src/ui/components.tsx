/**
 * side panel 的共用元件（spec #70「Design tokens 與元件」、#71）。樣式在 components.css，顏色與尺寸都取自
 * src/shared/tokens.css。class 前綴 naru-，只給樣式用；測試用 role／accessible name 找元素。
 */
import type { ButtonHTMLAttributes, ComponentChildren, HTMLAttributes } from 'preact';
import { useId, useState } from 'preact/hooks';
import type { PageHeading, SpreadSide } from './view.ts';

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon' | 'link' | 'danger';

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'className'> & {
  /**
   * primary：主要動作（一區最多一個）；secondary：預設；ghost：次要、工具列；icon：只有圖示，要給 aria-label；
   * link：小字、底線，比較不顯眼的替代選項（例如「使用自備金鑰」）；danger：確定執行無法復原的動作，只用在確定刪除的那個按鈕。
   */
  variant?: ButtonVariant;
  class?: string;
};

export function Button({ variant = 'secondary', type = 'button', class: extra, ...rest }: ButtonProps) {
  return <button type={type} class={cx('naru-btn', `naru-btn--${variant}`, extra)} {...rest} />;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** tabs 才顯示的一行副標；不算進按鈕的 accessible name（用 aria-describedby）。 */
  description?: string;
}

/**
 * 分段切換：一組 aria-pressed 的按鈕，外層是有名字的 group。
 * segmented：灰底膠囊（例如顯示層級）；tabs：頂部整排的底線分頁，每格有標題與副標（Page Mode：最上層、整片內容都跟著它）。
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  variant = 'segmented',
}: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  variant?: 'segmented' | 'tabs';
}) {
  const id = useId();
  return (
    <div
      role="group"
      aria-label={label}
      class={variant === 'tabs' ? 'naru-tabs' : 'naru-seg'}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o, i) => {
        const descId = variant === 'tabs' && o.description ? `${id}-${i}` : undefined;
        return (
          <button key={o.value} type="button" aria-pressed={o.value === value} aria-describedby={descId} onClick={() => onChange(o.value)}>
            <span class="naru-seg__label">{o.label}</span>
            {/* 在 button 裡的文字會算進名字；aria-hidden 拿掉，aria-describedby 照樣讀得到 */}
            {descId && (
              <span id={descId} class="naru-seg__desc" aria-hidden="true">
                {o.description}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 開關：原生 checkbox 加 role="switch"，鍵盤與表單行為照舊；label 就是它的 accessible name。 */
export function Switch({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 開關下面的一行說明。 */
  description?: string;
}) {
  const id = useId();
  return (
    <label class="naru-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-describedby={description ? id : undefined}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span class="naru-switch__track" aria-hidden="true" />
      <span class="naru-switch__text">
        <span class="naru-switch__label">{label}</span>
        {description && (
          <span id={id} class="naru-switch__desc">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * 單選卡片（radiogroup 裡的一張，#93 設定頁的翻譯方式）：標題與說明，選中的有主色框並展開內容。
 * 原生 radio，鍵盤與讀屏照原生走；accessible name 只有標題，說明用 aria-describedby。
 */
export function RadioCard({
  name,
  title,
  description,
  checked,
  onSelect,
  children,
}: {
  /** 同一組卡片共用的 radio name。 */
  name: string;
  title: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
  /** 選中時展開的內容。 */
  children?: ComponentChildren;
}) {
  const id = useId();
  return (
    <div class={cx('naru-radio-card', checked && 'naru-radio-card--on')}>
      <label class="naru-radio-card__head">
        <input type="radio" name={name} checked={checked} aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} onChange={onSelect} />
        <span class="naru-radio-card__text">
          <strong id={`${id}-t`}>{title}</strong>
          <span id={`${id}-d`} class="naru-radio-card__desc">
            {description}
          </span>
        </span>
      </label>
      {checked && <div class="naru-radio-card__body">{children}</div>}
    </div>
  );
}

/**
 * 小標籤。neutral：一般；warn：推測、過期；loose：框外文字（Loose Text）；danger：失敗；ok：啟動狀態（膠囊＋圓點）；
 * solid：黑底白字，方案名稱旁的「年繳」。
 */
export type BadgeTone = 'neutral' | 'warn' | 'loose' | 'danger' | 'ok' | 'solid';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ComponentChildren }) {
  return (
    <span class={cx('naru-badge', `naru-badge--${tone}`)}>
      {tone === 'ok' && <span class="naru-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** 雙價並列的一半：小標、大字（價格＋「／年」這種單位）、大字下面的小字。 */
export interface PriceSide {
  label: string;
  price: string;
  unit: string;
  note: string;
}

/**
 * 雙價並列（價格呈現定案）：左半「你付」、右半「平均」，交界的箭頭圓章只是裝飾。夠寬時左右排，窄的時候上下排
 * （container query，components.css）。網站的 site/src/components/PricePair.astro 輸出同一份 DOM，改的時候兩邊一起改。
 */
export function PricePair({ pay, average }: { pay: PriceSide; average: PriceSide }) {
  const side = (s: PriceSide) => (
    <>
      <span class="naru-price-pair__k">{s.label}</span>
      <span class="naru-price-pair__v">
        {s.price}
        <small>{s.unit}</small>
      </span>
      <span class="naru-price-pair__s">{s.note}</span>
    </>
  );
  return (
    <div class="naru-price-pair">
      <div class="naru-price-pair__box">
        <div class="naru-price-pair__side">{side(pay)}</div>
        <div class="naru-price-pair__side naru-price-pair__side--avg">
          {side(average)}
          <span class="naru-price-pair__arrow" aria-hidden="true">
            <svg class="naru-price-pair__right" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1.5 6h9M7 2.5l3.5 3.5L7 9.5" />
            </svg>
            <svg class="naru-price-pair__down" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 1.5v9M2.5 7l3.5 3.5L9.5 7" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}

/** 提示框。info：一般說明；warn：需要注意（過期、沒有 key）；danger：錯誤。role 等屬性原樣傳下去。 */
export type CalloutTone = 'info' | 'warn' | 'danger';

type CalloutProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'className'> & {
  tone?: CalloutTone;
  class?: string;
};

export function Callout({ tone = 'info', class: extra, ...rest }: CalloutProps) {
  return <div class={cx('naru-callout', `naru-callout--${tone}`, extra)} {...rest} />;
}

/** 還在跑的一行（辨識中…、翻譯中…）。 */
export function Progress({ children }: { children: ComponentChildren }) {
  return <span class="naru-progress">{children}</span>;
}

/**
 * 「譯」區塊（淺色版；頁面 tooltip 的深色版在 content script 用 DOM 畫）：先藏著內容，滑過或聚焦才顯示，
 * 離開又藏起來。group 的名字是「譯」，測試與讀屏都靠它找到區塊。
 */
export function RevealChip({ children }: { children: ComponentChildren }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div
      role="group"
      aria-label="譯"
      tabIndex={0}
      class={cx('naru-reveal', revealed && 'naru-reveal--on')}
      onMouseEnter={() => setRevealed(true)}
      onMouseLeave={() => setRevealed(false)}
      onFocus={() => setRevealed(true)}
      onBlur={() => setRevealed(false)}
    >
      <span class="naru-reveal__tag" aria-hidden="true">
        譯
      </span>
      {revealed ? children : <span class="naru-reveal__hint">滑過這裡看譯文</span>}
    </div>
  );
}

/** 小圖示：Spread 畫兩格、亮起的那格是這個 Page；單頁畫一格。標題已經說了是哪頁，圖示只是裝飾。 */
function PageIcon({ side }: { side: SpreadSide | undefined }) {
  const cells = side === undefined ? [{ x: 5, lit: true }] : [
    { x: 1, lit: side === 'left' },
    { x: 10, lit: side === 'right' },
  ];
  return (
    <svg class="naru-page-header__icon" viewBox="0 0 19 14" width={19} height={14} aria-hidden="true">
      {cells.map(({ x, lit }) => (
        <rect key={x} class={lit ? 'lit' : undefined} x={x + 0.5} y={0.5} width={7} height={13} rx={1.5} />
      ))}
    </svg>
  );
}

/**
 * 每個 Page 的頁首（取代縮圖）：圖示＋「右頁 · 先讀」「左頁 · 後讀」或「第 N 頁」，右側小字放翻譯狀態。
 * 標題是 heading，id 給外層 listitem 用 aria-labelledby 當名字。
 */
export function PageHeader({
  id,
  side,
  heading,
  status,
}: {
  id: string;
  side: SpreadSide | undefined;
  /** 頁首文字（view.ts 算好的）。 */
  heading: PageHeading;
  status?: ComponentChildren;
}) {
  return (
    <div class="naru-page-header">
      <PageIcon side={side} />
      <h2 id={id} class="naru-page-header__title">
        {heading.title}
        {heading.order && <span class="naru-page-header__order"> · {heading.order}</span>}
      </h2>
      {status && <div class="naru-page-header__status">{status}</div>}
    </div>
  );
}
