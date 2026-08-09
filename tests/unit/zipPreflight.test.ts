import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ION_ZIP_MAX_COMPRESSION_RATIO,
  ION_ZIP_MAX_ENTRIES,
  ION_ZIP_MAX_SINGLE_UNCOMPRESSED_BYTES,
  ION_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
  preflightIonWorkbookZip,
} from '../../src/core/zipPreflight'

function declaredZip(options: {
  entries?: number
  compressed?: number
  uncompressed?: number
  malformedCentralDirectory?: boolean
  zip64?: boolean
  multidisk?: boolean
  extra?: Uint8Array
  trailingSignature?: number
} = {}): ArrayBuffer {
  const entries = options.entries ?? 1
  const centralOffset = 30
  const extra = options.extra ?? new Uint8Array()
  const centralSize = entries * (47 + extra.byteLength)
  const trailingSize = options.trailingSignature === undefined ? 0 : 4
  const bytes = new Uint8Array(centralOffset + centralSize + trailingSize + 22)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < entries; index += 1) {
    const offset = centralOffset + index * (47 + extra.byteLength)
    view.setUint32(
      offset,
      options.malformedCentralDirectory && index === 0 ? 0 : 0x02014b50,
      true,
    )
    view.setUint32(offset + 20, options.compressed ?? 10, true)
    view.setUint32(offset + 24, options.uncompressed ?? 10, true)
    view.setUint16(offset + 28, 1, true)
    view.setUint16(offset + 30, extra.byteLength, true)
    bytes[offset + 46] = 0x61
    bytes.set(extra, offset + 47)
  }
  if (options.trailingSignature !== undefined) {
    view.setUint32(centralOffset + centralSize, options.trailingSignature, true)
  }
  const eocd = centralOffset + centralSize + trailingSize
  view.setUint32(eocd, 0x06054b50, true)
  view.setUint16(eocd + 4, options.multidisk ? 1 : 0, true)
  view.setUint16(eocd + 8, options.zip64 ? 0xffff : entries, true)
  view.setUint16(eocd + 10, options.zip64 ? 0xffff : entries, true)
  view.setUint32(eocd + 12, centralSize, true)
  view.setUint32(eocd + 16, centralOffset, true)
  return bytes.buffer
}

describe('preflightIonWorkbookZip', () => {
  it('accepts the normal XLSX fixture without inflating entries', () => {
    const bytes = readFileSync('tests/fixtures/ions-small.xlsx')
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    expect(preflightIonWorkbookZip(input, 'ions-small.xlsx').entries).toBeGreaterThan(0)
  })

  it('rejects an excessive declared entry count before walking entries', () => {
    expect(() =>
      preflightIonWorkbookZip(
        declaredZip({ entries: ION_ZIP_MAX_ENTRIES + 1 }),
        'entries.xlsx',
      ),
    ).toThrow(/entries\.xlsx.*ZIP.*条目.*5000.*拆分/s)
  })

  it('rejects an excessive single declared uncompressed entry', () => {
    expect(() =>
      preflightIonWorkbookZip(
        declaredZip({ uncompressed: ION_ZIP_MAX_SINGLE_UNCOMPRESSED_BYTES + 1 }),
        'single.xlsx',
      ),
    ).toThrow(/single\.xlsx.*单个.*25 MiB/s)
  })

  it('rejects an excessive declared compression ratio', () => {
    expect(() =>
      preflightIonWorkbookZip(
        declaredZip({ compressed: 1, uncompressed: ION_ZIP_MAX_COMPRESSION_RATIO + 1 }),
        'ratio.xlsx',
      ),
    ).toThrow(/ratio\.xlsx.*压缩比.*200:1/s)
  })

  it('rejects an excessive declared total without allocating declared sizes', () => {
    expect(() =>
      preflightIonWorkbookZip(
        declaredZip({
          entries: 5,
          compressed: 1024 * 1024,
          uncompressed: Math.floor(ION_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES / 5) + 1,
        }),
        'total.xlsx',
      ),
    ).toThrow(/total\.xlsx.*总解压大小.*100 MiB/s)
  })

  it('rejects malformed central-directory metadata', () => {
    expect(() =>
      preflightIonWorkbookZip(declaredZip({ malformedCentralDirectory: true }), 'bad.xlsx'),
    ).toThrow(/bad\.xlsx.*中央目录.*无效/s)
  })

  it('rejects unsupported ZIP64 metadata rather than guessing', () => {
    expect(() => preflightIonWorkbookZip(declaredZip({ zip64: true }), 'zip64.xlsx')).toThrow(
      /zip64\.xlsx.*ZIP64.*不支持/s,
    )
  })

  it.each([
    ['locator', 0x07064b50],
    ['record', 0x06064b50],
  ])('rejects a ZIP64 %s signature even without legacy sentinels', (_name, signature) => {
    expect(() =>
      preflightIonWorkbookZip(declaredZip({ trailingSignature: signature }), 'zip64-signature.xlsx'),
    ).toThrow(/zip64-signature\.xlsx.*ZIP64.*不支持/s)
  })

  it('rejects a ZIP64 central-directory extra field without 32-bit sentinels', () => {
    const extra = new Uint8Array([0x01, 0x00, 0x00, 0x00])
    expect(() => preflightIonWorkbookZip(declaredZip({ extra }), 'zip64-extra.xlsx')).toThrow(
      /zip64-extra\.xlsx.*ZIP64.*不支持/s,
    )
  })

  it.each([
    new Uint8Array([0x02, 0x00, 0x01]),
    new Uint8Array([0x02, 0x00, 0x04, 0x00, 0xaa]),
  ])('rejects truncated central-directory extra fields', (extra) => {
    expect(() => preflightIonWorkbookZip(declaredZip({ extra }), 'truncated-extra.xlsx')).toThrow(
      /truncated-extra\.xlsx.*额外字段.*无效/s,
    )
  })

  it('rejects multidisk ZIP metadata rather than guessing', () => {
    expect(() =>
      preflightIonWorkbookZip(declaredZip({ multidisk: true }), 'multidisk.xlsx'),
    ).toThrow(/multidisk\.xlsx.*不支持.*多磁盘/s)
  })
})
