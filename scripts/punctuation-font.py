"""
重新產生覆蓋層的標點字型（src/content/punctuation-font.ts）。平常不用跑：產出的檔案已經 commit。

用法：pip install fonttools brotli，然後 python -I scripts/punctuation-font.py

為什麼要這個字型：覆蓋層的譯文用系統字型（微軟正黑體、PingFang TC），但微軟正黑體沒有置中的「。，、」：
橫書字形在左下角、直書字形在右上角（日式）。台灣的直書標點在格子正中間，所以只把這幾個標點換成
Noto Sans TC 的字形（繁中子集的預設字形就是置中的），其餘的字照舊用系統字型。

來源是 notofonts/noto-cjk 固定 commit（Sans2.004）的 NotoSansTC-VF.otf（Variable，字重 100–900），
只留 PUNCTUATION 的字，轉成 woff2 後以 base64 寫進 TS：content script 與產品網站直接 import，
不必對網頁開放外掛檔案（web_accessible_resources），也不用 fetch。
"""
import base64
import hashlib
import io
import os
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

COMMIT = '523d033d6cb47f4a80c58a35753646f5c3608a78'  # tag Sans2.004
URL = f'https://raw.githubusercontent.com/notofonts/noto-cjk/{COMMIT}/Sans/Variable/OTF/Subset/NotoSansTC-VF.otf'
SHA256 = 'a080726eee9d78ec74fd95184a79c58c3085f10713e26876aab0130f543e9120'

# 直書位置會因系統字型而跑掉的標點：。，、；：．
PUNCTUATION = [0x3001, 0x3002, 0xFF0C, 0xFF0E, 0xFF1A, 0xFF1B]

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'content', 'punctuation-font.ts')


def unicode_range(codepoints):
    return ', '.join(f'U+{c:X}' for c in sorted(codepoints))


def main():
    otf = urllib.request.urlopen(URL).read()
    sha = hashlib.sha256(otf).hexdigest()
    if sha != SHA256:
        raise SystemExit(f'NotoSansTC-VF.otf 的 SHA-256 不符：{sha}')
    font = TTFont(io.BytesIO(otf))
    options = subset.Options()
    options.layout_features = ['*']  # 留 vert：直書時用直書字形
    options.name_IDs = ['*']  # 授權與著作權聲明（OFL 要求保留）
    options.flavor = 'woff2'
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=PUNCTUATION)
    subsetter.subset(font)
    buffer = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buffer)
    woff2 = buffer.getvalue()
    data = base64.b64encode(woff2).decode('ascii')
    lines = [data[i:i + 120] for i in range(0, len(data), 120)]
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('// 由 scripts/punctuation-font.py 產生，不要手改。\n')
        f.write(f'// Noto Sans TC（notofonts/noto-cjk {COMMIT[:8]}，SIL Open Font License 1.1）的 {len(PUNCTUATION)} 個標點，woff2 {len(woff2)} bytes。\n')
        f.write(f"export const PUNCTUATION_UNICODE_RANGE = '{unicode_range(PUNCTUATION)}';\n")
        f.write('export const PUNCTUATION_WOFF2_BASE64 =\n')
        f.write('\n'.join(f"  '{line}' +" for line in lines[:-1]))
        f.write(f"\n  '{lines[-1]}';\n")
    print(f'{len(PUNCTUATION)} 個標點 → woff2 {len(woff2)} bytes → {os.path.normpath(OUT)}')


main()
