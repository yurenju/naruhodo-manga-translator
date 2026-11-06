/** wizard 寫的設定檔（~/.config/naruhodo/*.env）的格式；with-op、prod-connect、paddle-tunnel 與 smoke 共用。 */

/** 讀 wizard 寫的 KEY='value' 檔（單引號內的 '\'' 還原成 '），也接受沒加引號或雙引號的值。 */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const [, key, raw] = /^([A-Z0-9_]+)=(.*)$/.exec(line) ?? [];
    if (!key || raw === undefined) continue;
    let value = raw;
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("'\\''", "'");
    else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}
