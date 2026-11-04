/**
 * PROTOTYPE（prototype/brand-yellow，#187）：brand-prototype.css 的 shadow root 版本。
 * shadow root 裡 tokens.css 宣告在 :host，會蓋掉從外面繼承的值，所以改成看 host 或祖先的 data-variant。
 */
import PROTO from './brand-prototype.css';

export const BRAND_PROTOTYPE_SHADOW = PROTO.replace(/\[data-variant[^\]]*\]/g, (selector) => `:host-context(${selector})`);
