// Generates PWA icons without external image tooling: renders a simple
// placeholder mark (green background, white ledger band) into RGBA scanlines
// and encodes them as PNG with node:zlib. Rerun via `pnpm icons`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public')

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const BRAND = [0x16, 0xa3, 0x4a, 0xff]
const WHITE = [0xff, 0xff, 0xff, 0xff]

// Rounded-corner mask: 1 inside the rounded square, 0 outside.
function insideRounded(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function render(size, inset = 1) {
  const rgba = Buffer.alloc(size * size * 4)
  const scale = size / 512
  const radius = Math.round(90 * scale)
  // White "ledger page" band with a green rule line, drawn in icon space.
  // `inset` shrinks the mark toward the center: maskable icons need a
  // safe zone so circular masks never clip the artwork.
  const C = 256 * scale
  const band = {
    x0: Math.round(C + (120 * scale - C) * inset),
    y0: Math.round(C + (150 * scale - C) * inset),
    x1: Math.round(C + (392 * scale - C) * inset),
    y1: Math.round(C + (382 * scale - C) * inset),
    r: Math.round(28 * scale * inset),
  }
  band.ruleTop = Math.round(C + (244 * scale - C) * inset)
  band.ruleBottom = Math.round(C + (258 * scale - C) * inset)
  const inBand = (x, y) =>
    x >= band.x0 &&
    x <= band.x1 &&
    y >= band.y0 &&
    y <= band.y1 &&
    insideRounded(
      x - band.x0 + band.r,
      y - band.y0 + band.r,
      band.x1 - band.x0 + 2 * band.r,
      band.r,
    )
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (!insideRounded(x, y, size, radius)) continue // transparent corner
      const color = y >= band.ruleTop && y < band.ruleBottom && inBand(x, y) ? BRAND : WHITE
      rgba.set(inBand(x, y) ? color : BRAND, i)
    }
  }
  return rgba
}

const targets = [
  ['pwa-192.png', 192, 1],
  ['pwa-512.png', 512, 1],
  ['pwa-maskable-512.png', 512, 0.78],
  ['apple-touch-icon.png', 180, 1],
]

mkdirSync(outDir, { recursive: true })
for (const [name, size, inset] of targets) {
  writeFileSync(join(outDir, name), encodePng(size, render(size, inset)))
  console.log(`wrote public/${name} (${size}x${size})`)
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="家庭记账"><title>家庭记账</title><rect width="512" height="512" rx="90" fill="#16a34a"/><rect x="120" y="150" width="272" height="232" rx="28" fill="#fff"/><rect x="120" y="244" width="272" height="14" fill="#16a34a"/></svg>`
writeFileSync(join(outDir, 'favicon.svg'), favicon)
console.log('wrote public/favicon.svg')
