import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = `${root}src/assets/aerosol-hero-static-v2.png`
const outputs = [
  { width: 960, path: `${root}src/assets/aerosol-hero-static-v2-960.webp`, maxBytes: 320_000 },
  { width: 1672, path: `${root}src/assets/aerosol-hero-static-v2-1680.webp`, maxBytes: 620_000 },
]

const sourceBytes = await readFile(source)
if (sourceBytes.length > 2_500_000) throw new Error('Hero PNG exceeds the 2.5 MB source cap.')

const metadata = await sharp(sourceBytes, { failOn: 'error' }).metadata()
if (metadata.format !== 'png' || metadata.width !== 1672 || metadata.height !== 941) {
  throw new Error(`Hero source must decode as a 1672x941 PNG; received ${metadata.format} ${metadata.width}x${metadata.height}.`)
}

for (const output of outputs) {
  await sharp(sourceBytes, { failOn: 'error' })
    .resize({ width: output.width, withoutEnlargement: true })
    .webp({ quality: 84, effort: 6, smartSubsample: true })
    .toFile(output.path)
  const generated = await sharp(output.path, { failOn: 'error' }).metadata()
  const size = (await stat(output.path)).size
  if (generated.format !== 'webp' || generated.width !== output.width || !generated.height) {
    throw new Error(`Generated hero failed WebP decode or dimensions: ${output.path}`)
  }
  if (size > output.maxBytes) throw new Error(`Generated hero exceeds ${output.maxBytes} bytes: ${output.path}`)
  console.log(`${output.path.replace(root, '')}: ${generated.width}x${generated.height}, ${size} bytes`)
}
