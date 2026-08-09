import JSZip from 'jszip'

import type { ResultZipWorkerFile } from './resultZipProtocol'

const ZIP_ENTRY_TIMESTAMP = Date.UTC(1980, 0, 1, 0, 0, 0, 0)

export async function createResultZipDirect(
  files: readonly ResultZipWorkerFile[],
): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const file of files) {
    zip.file(file.name, new Uint8Array(file.buffer), {
      createFolders: false,
      date: new Date(ZIP_ENTRY_TIMESTAMP),
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })
  }
  const generated = await zip.generateAsync({
    type: 'uint8array',
    platform: 'DOS',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  const copy = new Uint8Array(generated.byteLength)
  copy.set(generated)
  return copy.buffer
}
