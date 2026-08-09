import { describe, expect, it } from 'vitest'

import {
  parseExtractedStationCsv,
  serializeExtractedStationCsv,
} from '../../src/core/extractedStationCsv'

describe('serializeExtractedStationCsv', () => {
  it('writes a BOM-prefixed CRLF station CSV and parses it without the national format', () => {
    const csv = serializeExtractedStationCsv({
      stationId: '3329A',
      rows: [
        { timestamp: '2024-11-01 01:00:00', SO2: 2, 'PM2.5': 0 },
        { timestamp: '2024-11-01 00:00:00', SO2: 1, NO2: 3 },
      ],
    })

    expect(csv).toBe(
      '\uFEFFstation_id,timestamp,SO2(μg/m³),NO2(μg/m³),O3(μg/m³),CO(mg/m³),PM10(μg/m³),PM2.5(μg/m³)\r\n3329A,2024-11-01 00:00:00,1,3,,,,\r\n3329A,2024-11-01 01:00:00,2,,,,,0\r\n',
    )
    expect(parseExtractedStationCsv(csv)).toEqual({
      stationId: '3329A',
      rows: [
        { timestamp: '2024-11-01 00:00:00', SO2: 1, NO2: 3 },
        { timestamp: '2024-11-01 01:00:00', SO2: 2, 'PM2.5': 0 },
      ],
      warnings: [],
      warningTotal: 0,
    })
  })

  it('keeps the first finite duplicate and rejects formula-like station metadata', () => {
    const csv = serializeExtractedStationCsv({
      stationId: '3329A',
      rows: [
        { timestamp: '2024-11-01 00:00:00', SO2: 1 },
        { timestamp: '2024-11-01 00:00:00', SO2: 2, NO2: 4 },
      ],
    })
    const result = parseExtractedStationCsv(csv)

    expect(result.rows).toEqual([
      { timestamp: '2024-11-01 00:00:00', SO2: 1, NO2: 4 },
    ])
    expect(result.warnings).toHaveLength(1)
    expect(result.warningTotal).toBe(1)
    expect(() => parseExtractedStationCsv(csv.replace('3329A', '=3329A'))).toThrow('站点编号格式无效')
  })

  it('writes every station data type while keeping the six conventional columns importable', () => {
    const csv = serializeExtractedStationCsv({
      stationId: '3329A',
      rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 3, 'PM2.5': 49 }],
      allRows: [{
        timestamp: '2024-11-01 00:00:00',
        values: { SO2: 3, 'PM2.5': 49, AQI: 80, SO2_24h: 12, O3_8h: 41 },
      }],
    })

    const [header, data] = csv.replace(/^\uFEFF/, '').split(/\r?\n/)
    expect(header).toContain(',AQI,')
    expect(header).toContain(',SO2_24h,')
    expect(header).toContain(',O3_8h')
    expect(data).toContain(',80,12,41')
    expect(parseExtractedStationCsv(csv).rows).toEqual([
      { timestamp: '2024-11-01 00:00:00', SO2: 3, 'PM2.5': 49 },
    ])
  })

  it.each(['abc', '3329a', '33299', ' 3329A '])('requires canonical station IDs: %s', (stationId) => {
    expect(() => serializeExtractedStationCsv({ stationId, rows: [] })).toThrow('站点编号格式无效')
  })
})
