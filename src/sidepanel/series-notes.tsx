/**
 * Series Notes 區塊（spec #27 第 8 節、#38）：檢視與修正這個 tab 目前 Series 的條目（改過就 locked）、刪除條目與
 * 不記的詞（#214）、接受／忽略建議修改、手動清除這部 Series 的快取、刪除這部作品。寫入都交給 SW（跟翻譯時套用 notes_changes 排在同一個 ledger）。
 */
import { useEffect, useState } from 'preact/hooks';
import type { Message, NotesResponse } from '../shared/messages.ts';
import type { EditableFields, NotesSuggestion } from '../shared/series-notes.ts';
import type { NotesEntry } from '../shared/translator.ts';
import { Button, Callout } from '../ui/components.tsx';

const send = <R,>(message: Message) => chrome.runtime.sendMessage<Message, R>(message);

/** 編輯表單的欄位，依顯示順序。自稱／語氣／稱呼只有人名會填，但不擋。 */
const FIELDS = ['讀音', '譯文', '類別', '備註', '自稱', '語氣', '稱呼'] as const;

/**
 * 條目的編輯表單。「刪除」直接刪、不再確認（#214）；「之後不要再記這個詞」預設勾選，勾著刪＝變成不記的詞。
 */
function EntryForm({
  entry,
  onDone,
  onDelete,
}: {
  entry: NotesEntry;
  onDone: (fields: EditableFields | undefined) => void;
  onDelete: (exclude: boolean) => void;
}) {
  const [draft, setDraft] = useState<EditableFields>(() => Object.fromEntries(FIELDS.map((f) => [f, entry[f] ?? ''])));
  const [exclude, setExclude] = useState(true);
  return (
    <form
      class="note-form"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(draft);
      }}
    >
      {FIELDS.map((field) => (
        <label key={field}>
          {field}
          <input value={draft[field]} onInput={(e) => setDraft({ ...draft, [field]: (e.target as HTMLInputElement).value })} />
        </label>
      ))}
      <div class="note-form__actions">
        <Button variant="primary" type="submit">儲存</Button>
        <Button onClick={() => onDone(undefined)}>
          取消
        </Button>
        <span class="note-form__spacer" />
        <Button variant="danger" onClick={() => onDelete(exclude)}>
          刪除
        </Button>
      </div>
      <label class="note-form__exclude">
        <input type="checkbox" checked={exclude} onChange={(e) => setExclude((e.target as HTMLInputElement).checked)} />
        之後不要再記這個詞
      </label>
    </form>
  );
}

function EntryRow({ entry, onEdit }: { entry: NotesEntry; onEdit: () => void }) {
  return (
    <tr>
      <td lang="ja">{entry.原文}</td>
      <td lang="ja">{entry.讀音}</td>
      <td>{entry.譯文}</td>
      <td>{entry.類別}</td>
      <td>{entry.locked && <span title="人改過：LLM 只能提建議">🔒</span>}</td>
      <td>
        <Button variant="ghost" aria-label={`編輯 ${entry.原文}`} onClick={onEdit}>
          編輯
        </Button>
      </td>
    </tr>
  );
}

function SuggestionItem({ suggestion, current, tabId }: { suggestion: NotesSuggestion; current: string | undefined; tabId: number }) {
  const ref = { 原文: suggestion.原文, 建議譯文: suggestion.建議譯文 };
  return (
    <li>
      <span lang="ja">{suggestion.原文}</span>：{current} → {suggestion.建議譯文}
      {suggestion.理由 && <span class="hint">（{suggestion.理由}）</span>}
      <Button onClick={() => void send({ type: 'panel:acceptSuggestion', tabId, suggestion: ref })}>
        接受
      </Button>
      <Button onClick={() => void send({ type: 'panel:ignoreSuggestion', tabId, suggestion: ref })}>
        忽略
      </Button>
    </li>
  );
}

/** 不記的詞（#214）：角色與用語最底部，預設收起來；「恢復」讓 LLM 之後可以再記。 */
function ExcludedTerms({ excluded, tabId }: { excluded: string[]; tabId: number }) {
  if (excluded.length === 0) return null;
  return (
    <details class="excluded-terms">
      <summary>不記的詞（{excluded.length}）</summary>
      <p class="hint">這些詞 LLM 不會再記。按恢復之後，翻譯時遇到會重新記下來。</p>
      <ul aria-label="不記的詞">
        {excluded.map((原文) => (
          <li key={原文}>
            <span lang="ja">{原文}</span>
            <Button aria-label={`恢復 ${原文}`} onClick={() => void send({ type: 'panel:restoreExcluded', tabId, 原文 })}>
              恢復
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 刪除這部作品（#214）：放在作品頁最底部、清除快取下面。先問一次；刪完顯示它的 tab 都停用，side panel 顯示「已刪除」。
 */
export function DeleteSeries({ tabId, name }: { tabId: number; name: string }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming)
    return (
      <Callout tone="danger" class="naru-callout--stack" role="group" aria-label="確認刪除作品">
        確定刪除「{name}」？翻譯快取、角色與用語、不記的詞都會一起刪掉，無法復原。之後再讀這部作品要重新翻譯（要花費用）。
        <div class="naru-row">
          <Button variant="danger" onClick={() => void send({ type: 'panel:deleteSeries', tabId })}>
            刪除
          </Button>
          <Button onClick={() => setConfirming(false)}>取消</Button>
        </div>
      </Callout>
    );
  return (
    <p>
      <Button variant="danger" onClick={() => setConfirming(true)}>
        刪除這部作品
      </Button>
    </p>
  );
}

/** 手動清除這部 Series 的快取（spec 第 4.3 節：不自動清除）。先問一次。放在作品頁最底部（#191）。 */
export function ClearCache({ tabId }: { tabId: number }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'done'>('idle');
  if (state === 'confirm')
    return (
      <Callout tone="warn">
        確定清除這部作品的翻譯快取？角色與用語會保留，之後的頁會重新翻譯（要花費用）。
        <Button variant="primary" onClick={() => void send({ type: 'panel:clearCache', tabId }).then(() => setState('done'))}>
          清除
        </Button>
        <Button onClick={() => setState('idle')}>取消</Button>
      </Callout>
    );
  return (
    <p>
      <Button onClick={() => setState('confirm')}>清除這部作品的翻譯快取</Button>
      {state === 'done' && <span role="status"> 已清除快取</span>}
    </p>
  );
}

/** 作品頁裡、作品身分下面的一段（#191；以前從 ⚙ 選單打開，#77）；打開時才讀 Notes。 */
export function SeriesNotesSection({ tabId }: { tabId: number }) {
  const [notes, setNotes] = useState<NotesResponse | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);

  useEffect(() => {
    let seriesId: string | undefined;
    const refresh = () =>
      void send<NotesResponse>({ type: 'panel:getNotes', tabId }).then((r) => {
        seriesId = r.seriesId;
        setNotes(r);
      });
    const onMessage = (message: Message) => {
      if (message.type === 'notes:changed' && message.seriesId === seriesId) refresh();
      if ((message.type === 'series:changed' || message.type === 'status:changed') && message.tabId === tabId) refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    refresh();
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);

  const translationOf = (原文: string) => notes?.entries.find((e) => e.原文 === 原文)?.譯文;
  if (!notes) return null;
  return (
    <section aria-label="角色與用語" class="notes">
      <h2>角色與用語</h2>
      {notes.suggestions.length > 0 && (
        <>
          <h3>建議修改</h3>
          <ul aria-label="建議修改">
            {notes.suggestions.map((s) => (
              <SuggestionItem key={`${s.原文}/${s.建議譯文}`} suggestion={s} current={translationOf(s.原文)} tabId={tabId} />
            ))}
          </ul>
        </>
      )}
      {notes.entries.length === 0 ? (
        <Callout>還沒有條目：翻譯時 LLM 會把人名、用語記下來。</Callout>
      ) : (
        <table>
          <thead>
            <tr>
              <th>原文</th>
              <th>讀音</th>
              <th>譯文</th>
              <th>類別</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            {notes.entries.map((entry) =>
              editing === entry.原文 ? (
                <tr key={entry.原文}>
                  <td colSpan={6}>
                    <span lang="ja">{entry.原文}</span>
                    <EntryForm
                      entry={entry}
                      onDone={(fields) => {
                        setEditing(undefined);
                        if (fields) void send({ type: 'panel:editNote', tabId, 原文: entry.原文, fields });
                      }}
                      onDelete={(exclude) => {
                        setEditing(undefined);
                        void send({ type: 'panel:deleteNote', tabId, 原文: entry.原文, exclude });
                      }}
                    />
                  </td>
                </tr>
              ) : (
                <EntryRow key={entry.原文} entry={entry} onEdit={() => setEditing(entry.原文)} />
              ),
            )}
          </tbody>
        </table>
      )}
      <p class="hint">改過的條目會鎖定（🔒），之後 LLM 只能提建議修改。用到改過條目的頁會提示過時，按「重新翻譯」才重翻。</p>
      <ExcludedTerms excluded={notes.excluded} tabId={tabId} />
    </section>
  );
}
