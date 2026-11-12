// Render cover.html → cover.pdf at A4 with backgrounds (Playwright chromium).
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("file://" + path.resolve(dir, "cover.html"));
await page.waitForTimeout(600); // fonts settle
await page.pdf({
  path: path.resolve(dir, "cover.pdf"),
  width: "210mm",
  height: "297mm",
  printBackground: true,
  pageRanges: "1",
});
await browser.close();
console.log("cover rendered");
