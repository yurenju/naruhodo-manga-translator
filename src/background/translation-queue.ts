/**
 * 翻譯佇列的排程（#34、spec #27 第 3.4 節）：兩段，本機段（偵測／OCR）併發 1、LLM 段併發 2，跨 tab 共用
 * （offscreen 只有一份模型）。先做 priority 高的、再來比較新的一批、同一批裡依閱讀順序。
 * 本機段還沒開始的工作，每次排程前問 isWanted，已經不要的（翻走的 Page）丟掉；已開始的一律做完。
 * 工作帶 after 時，本機段做完先等它，才排進 LLM 段（同一批裡在後的頁等前頁的 ①，ADR 0005）。
 * 工作本身做什麼（跑流水線、翻譯、更新畫面）由呼叫端的 runLocal／runLlm 決定。
 */

/** 本機段與 LLM 段的併發數（spec 第 3.4 節）。 */
export const LOCAL_CONCURRENCY = 1;
export const LLM_CONCURRENCY = 2;

export interface QueuedJob {
  priority: number;
  /** 第幾次排程（越大越新，先做）。 */
  batch: number;
  /** 同一批裡的閱讀順序（越小先做）。 */
  index: number;
  /** 進 LLM 段之前要等的事；等的時候不佔 LLM 段的名額。 */
  after?: Promise<unknown>;
}

export interface TranslationQueueDeps<J extends QueuedJob> {
  /** 跑本機段；回傳 true＝接著排進 LLM 段。 */
  runLocal(job: J): Promise<boolean>;
  runLlm(job: J): Promise<void>;
  /** 本機段還沒開始的工作還要不要做。 */
  isWanted(job: J): boolean;
  /** 不要的工作被拿出佇列時。 */
  onDrop(job: J): void;
}

export function createTranslationQueue<J extends QueuedJob>(deps: TranslationQueueDeps<J>) {
  const localQueue: J[] = [];
  const llmQueue: J[] = [];
  let localRunning = 0;
  let llmRunning = 0;

  /** 先做的排前面：priority 高 → 比較新的一批 → 同一批裡閱讀順序前面的。 */
  function takeNext(queue: J[]): J | undefined {
    queue.sort((a, b) => b.priority - a.priority || b.batch - a.batch || a.index - b.index);
    return queue.shift();
  }

  /** 本機段裡已經不要、還沒開始的工作丟掉。 */
  function dropUnwanted(): void {
    for (const job of [...localQueue]) {
      if (deps.isWanted(job)) continue;
      localQueue.splice(localQueue.indexOf(job), 1);
      deps.onDrop(job);
    }
  }

  /** 排進 LLM 段；有 after 的等它結束才排。 */
  function enqueueLlm(job: J): void {
    if (!job.after) {
      llmQueue.push(job);
      return;
    }
    void job.after.then(() => {
      llmQueue.push(job);
      pump();
    });
  }

  function pump(): void {
    dropUnwanted();
    while (localRunning < LOCAL_CONCURRENCY) {
      const job = takeNext(localQueue);
      if (!job) break;
      localRunning++;
      void deps
        .runLocal(job)
        .then((toLlm) => {
          if (toLlm) enqueueLlm(job);
        })
        .finally(() => {
          localRunning--;
          pump();
        });
    }
    while (llmRunning < LLM_CONCURRENCY) {
      const job = takeNext(llmQueue);
      if (!job) break;
      llmRunning++;
      void deps.runLlm(job).finally(() => {
        llmRunning--;
        pump();
      });
    }
  }

  return {
    enqueueLocal(job: J): void {
      localQueue.push(job);
      pump();
    },
    /** 已經有本機段的結果，直接排進 LLM 段（「翻譯此頁／重試」）。 */
    enqueueLlm(job: J): void {
      enqueueLlm(job);
      pump();
    },
    dropUnwanted,
  };
}
