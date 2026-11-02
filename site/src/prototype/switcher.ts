/**
 * PROTOTYPE（拋棄式）：試翻頁與 onboarding 下載告知的 UI 變體切換列。定案後連同 site/src/prototype/ 一起丟掉。
 * 底部置中的切換列：← / → 換變體（鍵盤方向鍵也可以），網址的 ?variant= 跟著改，重新整理不會跑掉。
 */
export function mountSwitcher(variants: Record<string, string>, onChange: (key: string) => void): void {
  if (!import.meta.env.DEV) return;
  const keys = Object.keys(variants);
  const params = new URLSearchParams(location.search);
  let current = keys.includes(params.get('variant') ?? '') ? params.get('variant')! : keys[0]!;

  const bar = document.createElement('div');
  bar.setAttribute('style', [
    'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)', 'z-index:99999',
    'display:flex', 'align-items:center', 'gap:8px', 'padding:6px 10px', 'border-radius:999px',
    'background:#111', 'color:#fff', 'font:13px system-ui', 'box-shadow:0 4px 16px rgba(0,0,0,.35)',
  ].join(';'));
  const button = (text: string, delta: number) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.setAttribute('style', 'border:0;background:#333;color:#fff;border-radius:999px;width:28px;height:28px;cursor:pointer');
    b.onclick = () => go(delta);
    return b;
  };
  const label = document.createElement('span');
  label.setAttribute('style', 'min-width:220px;text-align:center');
  bar.append(button('←', -1), label, button('→', 1));
  document.body.append(bar);

  function render() {
    label.textContent = `PROTOTYPE ${current}（${variants[current]}）`;
    onChange(current);
  }
  function go(delta: number) {
    current = keys[(keys.indexOf(current) + delta + keys.length) % keys.length]!;
    const url = new URL(location.href);
    url.searchParams.set('variant', current);
    history.replaceState(null, '', url);
    render();
  }
  addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, [contenteditable]')) return;
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  });
  render();
}
