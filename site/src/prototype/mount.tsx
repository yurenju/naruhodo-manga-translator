/** PROTOTYPE（#187）：brand-extension.astro 的進入點。 */
import { render } from 'preact';
import { BrandCompare } from './BrandCompare.tsx';

render(<BrandCompare />, document.querySelector('[data-compare]')!);
