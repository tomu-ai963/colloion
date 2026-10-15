/**
 * public/icons/icon.svg から PWA・ホーム画面・favicon 用の PNG を書き出す。
 *   node scripts/icons.mjs
 * sharp は wrangler（miniflare）の依存として node_modules に入っているものを使う
 * （アイコンを描き直したときだけ手で実行する。ビルドには含めない）。
 * SVG は全面に背景を敷き、絵は中央の安全域（半径 40%）に収めてあるので、
 * 同じ絵を any と maskable の両方に使う。
 */
import sharp from 'sharp'

const SRC = 'public/icons/icon.svg'
const OUT = [
  ['public/icons/icon-192.png', 192],
  ['public/icons/icon-512.png', 512],
  ['public/icons/apple-touch-icon.png', 180],
  ['public/icons/favicon-32.png', 32],
]

for (const [file, size] of OUT) {
  await sharp(SRC, { density: 72 * (size / 512) * 4 })
    .resize(size, size)
    .removeAlpha() // 背景は全面不透明。iOS が透明部分を黒で埋めることもないように
    .png({ compressionLevel: 9 })
    .toFile(file)
  console.log(file, size)
}
