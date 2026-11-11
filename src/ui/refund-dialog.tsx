/**
 * 申請退款的確認對話框（#260，設計稿 B 版）：帳號頁方案卡片的「申請退款」打開。文案由 view.ts 的 refundDialogView 決定；
 * 「確定退款」是 danger、「先不要」關掉。用原生 <dialog> 的 showModal()：焦點留在對話框裡，Esc 等於「先不要」。
 */
import { useEffect, useRef } from 'preact/hooks';
import { Button, Callout } from './components.tsx';
import type { RefundDialogView } from './view.ts';

export interface RefundDialogProps {
  view: RefundDialogView;
  /** 送出中：兩個按鈕都停用。 */
  sending: boolean;
  /** 上一次送出失敗（連不上、Paddle 失敗）：還沒退款，可以再按一次。 */
  failed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RefundDialog({ view, sending, failed, onConfirm, onCancel }: RefundDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      class="ac-dialog"
      aria-label={view.title}
      onCancel={(e) => {
        e.preventDefault();
        if (!sending) onCancel();
      }}
    >
      <h3>{view.title}</h3>
      <ul>
        {view.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {failed && (
        <Callout tone="danger" role="alert">
          <p>退款申請沒有送出，請稍後再試一次。</p>
        </Callout>
      )}
      <div class="ac-dialog__actions">
        <Button disabled={sending} onClick={onCancel}>
          {view.cancel}
        </Button>
        <Button variant="danger" disabled={sending} onClick={onConfirm}>
          {view.confirm}
        </Button>
      </div>
    </dialog>
  );
}
