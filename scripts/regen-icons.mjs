// One-shot: regenerate public/icons/*.png from the B1 brand geometry.
// Renders the SVG in headless Chromium and screenshots at exact sizes with
// omitBackground so the any-purpose icons keep transparency outside the tile.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const TILE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2563EB"/><stop offset="0.55" stop-color="#0EA5E9"/><stop offset="1" stop-color="#22D3EE"/>
    </linearGradient>
    <linearGradient id="f" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#7DD3FC"/><stop offset="1" stop-color="#CFFAFE"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#g)"/>
  <path d="M27 19v26l22-13z" fill="#fff" opacity="0.96"/>
  <path d="M27 19c-3.2 1.6-4.6 4.1-4.3 7 .2 2 1.4 3.4 1.1 5.6-.3 2.4-2.2 4-4.8 4.2 1.1-2.6.6-4.4-1.5-6.4-2.4-2.3-3.1-5.8-1.5-9.2 1.9-4.1 6.3-6.3 11-5.3-1.9 1.3-3 2.6-3.5 4.1z" fill="url(#f)"/>
</svg>`;

// Maskable: full-bleed gradient canvas, glyph inside the 80% safe zone.
const MASKABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2563EB"/><stop offset="0.55" stop-color="#0EA5E9"/><stop offset="1" stop-color="#22D3EE"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" fill="url(#g)"/>
  <path d="M25.4 21.6v20.8l17.6-10.4z" fill="#fff" opacity="0.97"/>
</svg>`;

const html = (svg, size) =>
  `<!doctype html><html><body style="margin:0;background:transparent">
   <div style="width:${size}px;height:${size}px">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div>
   </body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
mkdirSync("public/icons", { recursive: true });

const shoot = async (svg, size, out) => {
  await page.setContent(html(svg, size));
  await page.locator("div").screenshot({
    path: out,
    omitBackground: true,
    scale: "css",
  });
  console.log("wrote", out);
};

await shoot(TILE, 192, "public/icons/icon-192.png");
await shoot(TILE, 512, "public/icons/icon-512.png");
await shoot(MASKABLE, 512, "public/icons/icon-maskable-512.png");
await browser.close();
