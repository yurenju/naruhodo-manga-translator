/**
 * side panel 的逐字稿（spec #27 第 8 節、#39、#70／#76）：依閱讀順序一行一句，上方切換 Display Level，
 * 振り仮名用 rubyDisplay（alignRuby）對齊回每段漢字，頁面 ↔ panel 的 hover 同步。
 * 原文標 lang="ja"、譯文標 lang="zh-Hant"：字型跟著語言走，測試也靠它找元素。
 */
import { useEffect, useRef } from 'preact/hooks';
import type { PageText } from '../shared/page-text.ts';
import { rubyDisplay, type RubyDisplay } from '../shared/ruby.ts';
import { Badge, RevealChip, SegmentedControl, Switch } from './components.tsx';

/** 閱讀時的 Display Level：整頁一起切。 */
export const LEVELS = ['只看譯文', '原文＋譯文', '加上讀音'] as const;
export type Level = (typeof LEVELS)[number];
export const DEFAULT_LEVEL: Level = '加上讀音';

/**
 * 逐字稿要顯示什麼，依 Page Mode 而定（GLOSSARY 的 Display Level）：閱讀時三個層級；
 * 學習時只有振り仮名開關，譯文一律藏在「譯」區塊後面。
 */
export type Display = { mode: 'read'; level: Level } | { mode: 'learn'; furigana: boolean };

/** 逐字稿上方的切換：閱讀時是 Display Level，學習時是振り仮名 Switch。 */
export function DisplaySwitch({
  display,
  onLevel,
  onFurigana,
}: {
  display: Display;
  onLevel: (level: Level) => void;
  onFurigana: (on: boolean) => void;
}) {
  return (
    <div class="levels">
      {display.mode === 'read' ? (
        <SegmentedControl label="顯示層級" options={LEVELS.map((l) => ({ value: l, label: l }))} value={display.level} onChange={onLevel} />
      ) : (
        <Switch label="顯示讀音" checked={display.furigana} onChange={onFurigana} />
      )}
    </div>
  );
}

/** 原文＋ルビ；對不上時退回「原文＋下面一行整句讀音」。 */
function Ruby({ ja, display }: { ja: string; display: RubyDisplay }) {
  if ('fallback' in display)
    return (
      <>
        {ja}
        <small class="reading">{display.fallback}</small>
      </>
    );
  return (
    <>
      {display.segments.map((s, i) =>
        s.rt === undefined ? (
          s.text
        ) : (
          <ruby key={i}>
            {s.text}
            <rt>{s.rt}</rt>
          </ruby>
        ),
      )}
    </>
  );
}

export interface TranscriptProps {
  text: PageText;
  translated: boolean;
  display: Display;
  /** 頁面上滑鼠所在的那句（高亮並捲過去）。 */
  hoveredId: string | undefined;
  /** 滑過這行（null＝離開）→ 頁面上那句高亮。 */
  onHover: (lineId: string | null) => void;
}

/** 逐字稿：Balloon 與 Loose Text 依閱讀順序混在同一串；Loose Text 標「框外文字」。 */
export function Transcript({ text, translated, display, hoveredId, onHover }: TranscriptProps) {
  const learn = display.mode === 'learn';
  const showRuby = learn ? display.furigana : display.level === '加上讀音';
  const translationOnly = !learn && display.level === '只看譯文';
  const lines = [
    ...text.balloons.map((b) => ({ ...b, loose: false })),
    ...text.looseText.map((l) => ({ ...l, loose: true })),
  ].sort((a, b) => a.order - b.order);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (hoveredId === undefined) return;
    list.current?.querySelector('li.hl')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hoveredId]);

  return (
    <ol aria-label="逐字稿" ref={list}>
      {lines.map((line) => {
        // unreadable：OCR 原文（灰、刪除線）＋「無法辨識 · 未覆蓋」，每個層級都一樣
        const unreadable = translated && line.unreadable;
        const hasTranslation = translated && line.譯文 !== '';
        const showOriginal = unreadable || !translationOnly || !hasTranslation;
        // 要畫ルビ的句子才對齊讀音（讀音全是 LLM 推測，不另外標示）
        const ruby = showRuby && !unreadable ? rubyDisplay(line.原文, line.讀音) : undefined;
        const shownTranslation = (
          <span lang="zh-Hant" class="translation">
            {line.譯文}
          </span>
        );
        return (
          <li
            key={line.id}
            class={line.id === hoveredId ? 'hl' : undefined}
            onMouseEnter={() => onHover(line.id)}
            onMouseLeave={() => onHover(null)}
          >
            {showOriginal && (
              <span lang="ja" class={unreadable ? 'original unreadable' : ruby ? 'original with-ruby' : 'original'}>
                {ruby ? <Ruby ja={line.原文} display={ruby} /> : line.原文}
              </span>
            )}
            {line.loose && (
              <span class="badges">
                <Badge tone="loose">框外文字</Badge>
              </span>
            )}
            {unreadable && <span class="unreadable-label">無法辨識 · 未覆蓋</span>}
            {!unreadable &&
              (hasTranslation ? (
                learn ? <RevealChip>{shownTranslation}</RevealChip> : shownTranslation
              ) : (
                <span class="untranslated">未翻譯</span>
              ))}
          </li>
        );
      })}
    </ol>
  );
}
