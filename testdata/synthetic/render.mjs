// Render every spec in specs/ to out/<id>.png + out/<id>.json (ground truth).
// Usage: node render.mjs [spec-id ...]
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.join(here, "specs");
const outDir = path.join(here, "out");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) throw new Error("Chrome not found; set CHROME_PATH");

const only = new Set(process.argv.slice(2));
const files = (await readdir(specDir)).filter((f) => f.endsWith(".json")).sort();
const template = await readFile(path.join(here, "template.js"), "utf8");

await mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  for (const file of files) {
    const spec = JSON.parse(await readFile(path.join(specDir, file), "utf8"));
    if (only.size && !only.has(spec.id)) continue;

    const page = await browser.newPage();
    await page.setViewport({ width: spec.width, height: spec.height, deviceScaleFactor: 1 });
    await page.setContent("<!doctype html><html lang=ja><head><meta charset=utf-8></head><body></body></html>");
    await page.addScriptTag({ content: template });
    await page.evaluate((s) => window.build(s), spec);
    await page.evaluate(() => document.fonts.ready);

    const gt = await page.evaluate((s) => window.groundTruth(s), spec);
    await page.screenshot({ path: path.join(outDir, `${spec.id}.png`) });
    if (spec.blank) {
      // Same Page without the text: what a perfect erase would leave behind.
      await page.evaluate(() => document.querySelectorAll("[data-text-id]").forEach((el) => (el.style.visibility = "hidden")));
      await page.screenshot({ path: path.join(outDir, `${spec.id}-blank.png`) });
    }
    await writeFile(path.join(outDir, `${spec.id}.json`), JSON.stringify(gt, null, 2) + "\n");
    console.log(`${spec.id}: ${gt.texts.length} texts, ${gt.panels.length} panels`);
    await page.close();
  }
} finally {
  await browser.close();
}
