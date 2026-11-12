// Render cover.html → cover.pdf at A4 with backgrounds (Playwright chromium).
const { chromium } = require("@playwright/test");
const path = require("path");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + path.resolve(__dirname, "cover.html"));
  await page.waitForTimeout(600); // fonts settle
  await page.pdf({
    path: path.resolve(__dirname, "cover.pdf"),
    width: "210mm",
    height: "297mm",
    printBackground: true,
    pageRanges: "1",
  });
  await browser.close();
  console.log("cover rendered");
})();
