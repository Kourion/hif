// Renders app/icons/icon.svg to the PNG sizes the web app manifest needs.
// Usage: node tools/render-icons.mjs   (needs Playwright with Chromium)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');

const dir = fileURLToPath(new URL('../app/icons/', import.meta.url));
const svg = readFileSync(dir + 'icon.svg', 'utf8');
// Maskable: full-bleed background, artwork scaled into the 80% safe zone.
const maskable = svg
  .replace('rx="104"', 'rx="0"')
  .replace(/<g fill/, '<g transform="translate(256 256) scale(0.86) translate(-256 -256)"><g fill')
  .replace('</svg>', '</g></svg>');

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, source, size] of [
  ['icon-192.png', svg, 192],
  ['icon-512.png', svg, 512],
  ['icon-maskable-512.png', maskable, 512],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
  await page.screenshot({ path: dir + name, omitBackground: true });
}
await browser.close();
console.log('icons written to', dir);
