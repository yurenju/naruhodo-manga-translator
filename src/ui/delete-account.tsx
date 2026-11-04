/**
 * 刪除帳號的確認頁（#95 畫面定案）：設定頁的「刪除帳號」打開，整個 side panel 換成這一頁（頂部的「← 刪除帳號」由 SidePanel 畫）。
 * 列出刪除之後會怎樣；「刪除帳號」是 danger、「取消」回到設定頁。內容要跟 PRIVACY.md 寫的刪除帳號一致（#96）。
 */
import { Button, Callout } from './components.tsx';

export interface DeleteAccountProps {
  email: string;
  /** 送出中：兩個按鈕都停用。 */
  deleting: boolean;
  /** 上一次刪除失敗了（例如連不上、取消訂閱失敗）：帳號還在，可以再按一次。 */
  failed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteAccount({ email, deleting, failed, onConfirm, onCancel }: DeleteAccountProps) {
  return (
    <section aria-label="刪除帳號" class="delete-account">
      <p>
        確定要刪除 <strong>{email}</strong> 的帳號？
      </p>
      <ul>
        <li>剩下的頁數與用量紀錄都會刪除。</li>
        <li>有訂閱的話會一起取消，不會再扣款；已付的費用不會自動退還。</li>
        <li>之後用同一個 email 重新註冊，不會再有免費額度。</li>
        <li>這台電腦上的翻譯快取、角色與用語不受影響。</li>
      </ul>
      {failed && (
        <Callout tone="danger" role="alert">
          <p>刪除失敗，帳號還在。請稍後再試一次。</p>
        </Callout>
      )}
      <div class="naru-row">
        <Button variant="danger" disabled={deleting} onClick={onConfirm}>
          刪除帳號
        </Button>
        <Button disabled={deleting} onClick={onCancel}>
          取消
        </Button>
      </div>
    </section>
  );
}
