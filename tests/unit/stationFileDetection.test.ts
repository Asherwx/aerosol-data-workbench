import { describe, expect, it } from 'vitest'

import { detectStationFileKind, validateStationWideIdentity } from '../../src/core/stationFileDetection'
import { serializeExtractedStationCsv } from '../../src/core/extractedStationCsv'

describe('detectStationFileKind', () => {
  it('recognizes BOM/CRLF national daily headers without parsing data', () => {
    expect(detectStationFileKind('\uFEFFdate,hour,type,3329A\r\n20241101,0,SO2,1', 'china_sites_20241101.csv'))
      .toEqual({ kind: 'national-daily' })
  })

  it.each(['anything.csv', 'china_sites_20240230.csv', 'china_sites_20241101.CSV'])
  ('rejects national headers without a strict valid daily filename: %s', (filename) => {
    expect(() => detectStationFileKind('date,hour,type,3329A\n20241101,0,SO2,1', filename)).toThrow(/文件名/)
  })

  it('recognizes the exact serialized station-wide schema', () => {
    const csv = serializeExtractedStationCsv({
      stationId: '3329A',
      rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 1 }],
    })
    expect(detectStationFileKind(csv, '3329A_20241101_20241101.csv')).toEqual({ kind: 'station-wide' })
  })

  it.each(['wide.csv', '3329A_20241131_20241201.csv', '3329A_20241202_20241201.csv'])
  ('rejects station-wide headers without a valid identity filename: %s', (filename) => {
    const csv = serializeExtractedStationCsv({ stationId: '3329A', rows: [] })
    expect(() => detectStationFileKind(csv, filename)).toThrow(/文件名/)
  })

  it('blocks station-wide filename metadata and date range mismatches', () => {
    const rows = [{ timestamp: '2024-11-01 00:00:00' }]
    expect(() => validateStationWideIdentity('3329A_20241101_20241101.csv', '3329A', '2277A', rows)).toThrow(/当前选择/)
    expect(() => validateStationWideIdentity('2277A_20241101_20241101.csv', '3329A', '3329A', rows)).toThrow(/文件名/)
    expect(() => validateStationWideIdentity('3329A_20241102_20241102.csv', '3329A', '3329A', rows)).toThrow(/日期范围/)
  })

  it('rejects an unknown header with an actionable Chinese error', () => {
    expect(() => detectStationFileKind('a,b,c\n1,2,3', 'unknown.csv')).toThrow(/无法识别.*unknown\.csv.*表头/)
  })
})
