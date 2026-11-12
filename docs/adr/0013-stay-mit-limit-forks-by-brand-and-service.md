---
status: accepted
---

# 維持 MIT，對 fork 的限制只靠品牌和服務條款

我們想寫一份 fork 指引，說明 fork 不可以做哪些事。但 MIT 授權只要求保留授權聲明，除此之外修改、散布、商用都允許，所以從程式碼授權這邊禁止不了任何事。我們決定不換授權，有約束力的限制只放在 MIT 管不到的兩個地方：Naruhodo 的名稱與圖示（屬於 Sad Coder, Inc.），以及我們營運的服務（TERMS 規定只能透過官方外掛使用）。其他希望 fork 配合的事，在 `FORKING.md` 裡寫成「請求」，明白說它們沒有約束力，免得讀者以為那也是授權條件。

## 不採用的做法

- **改成 AGPL 之類的 copyleft 授權，強制 fork 開源。** 已經以 MIT 發出去的版本收不回來，fork 的人只要停在舊版就好；而我們真正擔心的冒名和盜用服務，copyleft 本來也擋不住。
- **改成 BSL 之類的 source-available 授權，限制商用。** 跟上面一樣收不回已發出的版本，而且會讓這個專案不再算開源，TERMS 第 7 節「以 MIT 發布」的說法也要跟著改。我們不在意有人做商用 fork，只在意對方不要冒用 Naruhodo 的名義、不要用我們的服務。

## 不直覺的地方

- **正式 build 預設連到官方服務**（`scripts/build.ts` 的 `hostedApiUrl`），所以 fork 直接 build 發布就會違反服務條款。`FORKING.md` 有提醒，程式碼的預設值另開 issue 處理。
