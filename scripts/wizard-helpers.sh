# 多個 wizard 共用的 helper，在 STAGES 段落用 source 載入（wizard 的 library 本身不能手改）：
#   source "$(dirname "${BASH_SOURCE[0]}")/wizard-helpers.sh"

# copy_to_clipboard VALUE：放進剪貼簿，不顯示在畫面上；空字串等於清空剪貼簿。沒有剪貼簿工具就失敗。
copy_to_clipboard() {
  if command -v clip.exe >/dev/null 2>&1; then printf '%s' "$1" | clip.exe
  elif command -v pbcopy >/dev/null 2>&1; then printf '%s' "$1" | pbcopy
  elif command -v wl-copy >/dev/null 2>&1; then if [[ -n "$1" ]]; then printf '%s' "$1" | wl-copy; else wl-copy --clear; fi
  elif command -v xclip >/dev/null 2>&1; then printf '%s' "$1" | xclip -selection clipboard
  else return 1
  fi
}

# production_database_id：worker/wrangler.jsonc 最上層的 D1 database_id，還沒建立就是空字串（scripts/production-config.ts）。
production_database_id() { node scripts/production-config.ts database-id 2>/dev/null || true; }
