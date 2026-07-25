/**
 * Rasterise the Stelic mark into the PNG sizes a manifest and iOS need.
 *
 * Run by hand (`node scripts/generate-icons.mjs`), not by the build. The outputs are
 * committed, so a deploy never depends on `sharp` being installable in the build image —
 * and a logo does not change often enough to justify the risk.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NAVY = '#0b204b'
const BLUE = '#009be3'

const source = await readFile(resolve(root, 'src/app/icon.svg'), 'utf8')

/** The mark's own artwork, lifted out of the app icon so it can be re-composed. */
const OPEN = '<g transform="translate'
const CLOSE = '</g><rect y="87"'
const artwork = source.slice(source.indexOf(OPEN), source.indexOf(CLOSE) + '</g>'.length)

/**
 * Where the letterform actually sits in the source artwork, which is not the canvas centre.
 *
 * Measured, not guessed: rasterised on its own and trimmed, the mark occupies x 33.5–66.5 and
 * y 14.3–58.8 of the 100-unit canvas. Its centre is therefore (50, 36.6) — the artwork sits
 * high because the app icon reserves the foot of the square for the accent band.
 */
const MARK_CENTRE_Y = 36.6

/**
 * A square icon.
 *
 * `inset` is the fraction of the canvas left clear around the mark, scaled about the mark's
 * own optical centre rather than the top-left corner — otherwise shrinking it also drifts it
 * upward. Maskable icons are cropped to a circle inscribed in the middle 80%, so the artwork
 * has to sit well inside that or Android shaves the corners of the mark off.
 *
 * The accent band is dropped on a maskable icon. It runs to the very bottom edge, which a
 * circular crop would reduce to a thin chord — worse than not having it.
 */
function svg({ rounded, inset, band }) {
  const scale = 1 - inset * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  ${rounded ? '<defs><clipPath id="c"><rect width="100" height="100" rx="22.5"/></clipPath></defs>' : ''}
  <g${rounded ? ' clip-path="url(#c)"' : ''}>
    <rect width="100" height="100" fill="${NAVY}"/>
    <g transform="translate(50 50) scale(${scale}) translate(-50 -${MARK_CENTRE_Y})">${artwork}</g>
    ${band ? `<rect y="87" width="100" height="13" fill="${BLUE}"/>` : ''}
  </g>
</svg>`
}

const targets = [
  // The manifest's two required sizes: the mark on its own navy field, rounded like the
  // browser tab icon so the installed app matches what the tab showed.
  { file: 'public/icons/icon-192.png', size: 192, rounded: true, inset: 0, band: true },
  { file: 'public/icons/icon-512.png', size: 512, rounded: true, inset: 0, band: true },
  // Maskable: full bleed, artwork pulled into the safe zone. Android crops this to whatever
  // shape the launcher uses, and anything in the outer 10% may be cut.
  {
    file: 'public/icons/icon-maskable-512.png',
    size: 512,
    rounded: false,
    inset: 0.1,
    band: false,
  },
  // iOS applies its own rounded mask and ignores transparency, so this is a square.
  {
    file: 'public/apple-touch-icon.png',
    size: 180,
    rounded: false,
    inset: 0,
    band: true,
  },
]

for (const target of targets) {
  const out = resolve(root, target.file)
  await mkdir(dirname(out), { recursive: true })
  await sharp(Buffer.from(svg(target)))
    .resize(target.size, target.size)
    .png({ compressionLevel: 9 })
    .toFile(out)
  console.log(`wrote ${target.file} (${target.size}×${target.size})`)
}
