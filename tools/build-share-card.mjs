#!/usr/bin/env node
/**
 * Draws the image a shared PonsWars link unfurls as.
 *
 * §80.4 makes every surface a shareable URL, so a link to one gets posted —
 * and a post with no image is a grey rectangle with a hostname in it. This
 * writes the 1200×630 card that sits behind `og:image`.
 *
 * Composed here rather than in the app because it is not a page: nothing
 * renders it, a crawler fetches it. It is drawn from the same marks the app
 * uses — the house arrowhead, the ring of five sectors, the ten faction
 * accents — so the card and the product are recognisably the same thing.
 *
 * Committed rather than generated at build time. It changes when the identity
 * changes, which is rarely, and a build step that needs a rasteriser is a build
 * step that eventually breaks on someone's machine.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ACTIVE_TICKERS, BATTLES_PER_ROUND } from '../packages/shared-types/dist/index.js';
import { FACTION_ACCENT } from '../packages/ui-tokens/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps', 'web', 'public');

/**
 * The ten faction accents, in roster order (§4.1).
 *
 * Read from the built token package rather than typed here. The first pass had
 * them as literals and every one of them was wrong — they were the real brand
 * colours of the companies behind the tickers rather than the palette §2 gives
 * the factions, which is both a second source of truth and the wrong one.
 */
const ACCENTS = ACTIVE_TICKERS.map((ticker) => FACTION_ACCENT[ticker]);

const SECTORS = Array.from({ length: BATTLES_PER_ROUND }, (_, index) => {
  const heading = (index / BATTLES_PER_ROUND) * Math.PI * 2 + Math.PI / 10 - Math.PI / 2;
  return { x: 930 + Math.cos(heading) * 150, y: 315 + Math.sin(heading) * 150 };
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#05080b"/>
  <g opacity="0.5">
    ${Array.from({ length: 90 }, (_, index) => {
      // A fixed lattice rather than random noise, so regenerating the card does
      // not produce a different starfield every time.
      const x = ((index * 137) % 1200) + (index % 7) * 3;
      const y = ((index * 311) % 630) + (index % 5) * 2;
      return `<circle cx="${String(x)}" cy="${String(y)}" r="${String(1 + (index % 3) * 0.4)}" fill="#8fa6b4"/>`;
    }).join('')}
  </g>

  <g transform="translate(88 118)">
    <path d="M28 0 L56 28 L28 56 L0 28 Z" fill="none" stroke="#9cff38" stroke-width="2.4" opacity="0.6"/>
    <g fill="#9cff38" transform="scale(0.875)">
      <path d="M32 15 L37.5 31 L32 27.5 L26.5 31 Z"/>
      <path d="M19.5 25.5 L26.5 36 L19.5 43 L16 33.5 Z"/>
      <path d="M44.5 25.5 L48 33.5 L44.5 43 L37.5 36 Z"/>
      <path d="M23 44.5 L41 44.5 L41 49 L23 49 Z"/>
    </g>
  </g>
  <text x="164" y="158" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="700" font-size="40" letter-spacing="1" fill="#e8f1f6">Pons<tspan fill="#9cff38">Wars</tspan></text>

  <text x="88" y="292" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="700" font-size="76" fill="#e8f1f6">REAL MARKETS.</text>
  <text x="88" y="374" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="700" font-size="76" fill="#9cff38">HIGHER STAKES.</text>
  <text x="88" y="430" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="23" letter-spacing="3" fill="#8fa6b4">${String(ACTIVE_TICKERS.length).toUpperCase()} FACTIONS · ${String(BATTLES_PER_ROUND)} BATTLES · EVERY TEN MINUTES</text>

  ${ACCENTS.map((accent, index) => `<rect x="${String(88 + index * 34)}" y="472" width="22" height="6" rx="2" fill="${accent}"/>`).join('')}

  <g>
    <circle cx="930" cy="315" r="196" fill="none" stroke="#162b36" stroke-width="1.5"/>
    <circle cx="930" cy="315" r="150" fill="none" stroke="#1d3744" stroke-width="1.5" stroke-dasharray="4 8"/>
    ${SECTORS.map((sector) => `<line x1="930" y1="315" x2="${sector.x.toFixed(1)}" y2="${sector.y.toFixed(1)}" stroke="#1d3744" stroke-width="1.5"/>`).join('')}
    ${SECTORS.map(
      (
        sector,
        index,
      ) => `<circle cx="${sector.x.toFixed(1)}" cy="${sector.y.toFixed(1)}" r="26" fill="#0b1620" stroke="#2c4a5a" stroke-width="1.5"/>
      <path d="M${(sector.x - 17).toFixed(1)} ${sector.y.toFixed(1)} a17 17 0 0 1 34 0 Z" fill="${ACCENTS[index * 2] ?? '#2c4a5a'}" opacity="0.9"/>
      <path d="M${(sector.x - 17).toFixed(1)} ${sector.y.toFixed(1)} a17 17 0 0 0 34 0 Z" fill="${ACCENTS[index * 2 + 1] ?? '#2c4a5a'}" opacity="0.9"/>`,
    ).join('')}
    <path d="M930 268 L965 315 L930 362 L895 315 Z" fill="none" stroke="#9cff38" stroke-width="3"/>
    <circle cx="930" cy="315" r="11" fill="#9cff38"/>
  </g>

  <text x="1112" y="578" text-anchor="end" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="19" letter-spacing="3" fill="#5d7080">SAME MARKETS. A MORE INTERESTING UNIVERSE.</text>
</svg>`;

mkdirSync(out, { recursive: true });
const target = join(out, 'share-card.png');
const info = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(target);
console.log(
  `share-card.png  ${String(info.width)}x${String(info.height)}  ${(info.size / 1024).toFixed(0)} KB`,
);
