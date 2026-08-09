import { describe, expect, it } from 'vitest'

import type { StationSeriesRow } from '../../src/core/stationSeries'
import { STATION_QC_VARIABLES, qualityControlStation } from '../../src/core/stationQualityControl'

const measurements = {
  SO2: 1,
  NO2: 2,
  O3: 3,
  CO: 0.4,
  PM10: 5,
  'PM2.5': 6,
} as const

function row(values: Partial<StationSeriesRow> = {}): StationSeriesRow {
  return {
    timestamp: '2024-11-01 00:00:00',
    ...measurements,
    missing: [],
    status: '\u5b8c\u6574',
    ...values,
  }
}

describe('qualityControlStation', () => {
  it('keeps a complete canonical station row with the six exact variables', () => {
    const result = qualityControlStation([row()])

    expect(STATION_QC_VARIABLES).toEqual([
      { key: 'SO2', displayName: 'SO2 (\u03bcg/m\u00b3)' },
      { key: 'NO2', displayName: 'NO2 (\u03bcg/m\u00b3)' },
      { key: 'O3', displayName: 'O3 (\u03bcg/m\u00b3)' },
      { key: 'CO', displayName: 'CO (mg/m\u00b3)' },
      { key: 'PM10', displayName: 'PM10 (\u03bcg/m\u00b3)' },
      { key: 'PM2.5', displayName: 'PM2.5 (\u03bcg/m\u00b3)' },
    ])
    expect(result.rows[0]).toMatchObject({ ...measurements, QC_flag: '\u6b63\u5e38', QC_flags: [], QC_keep: true })
    expect(result.counts).toEqual({ '\u6b63\u5e38': 1 })
    expect(result.keptRows).toEqual(result.rows)
    expect(result.rejectedRows).toEqual([])
  })

  it('flags invalid measurements and bidirectional station metadata without dropping values', () => {
    const input = row({
      SO2: undefined,
      NO2: Number.NaN,
      O3: Number.POSITIVE_INFINITY,
      CO: -1,
      missing: ['PM10'],
      status: '\u5b8c\u6574',
    })
    const result = qualityControlStation([input])

    expect(result.rows[0]?.QC_flags.map((flag) => [flag.code, flag.variable])).toEqual([
      ['missing', 'SO2'], ['nonfinite', 'NO2'], ['nonfinite', 'O3'], ['negative', 'CO'],
      ['station-missing-omitted', 'SO2'], ['station-missing-omitted', 'NO2'],
      ['station-missing-omitted', 'O3'], ['station-finite-declared-missing', 'PM10'],
      ['station-status-mismatch', undefined],
    ])
    expect(result.rows[0]).toMatchObject({ SO2: undefined, NO2: Number.NaN, O3: Infinity, CO: -1, QC_keep: false })
  })

  it('preserves and rejects six simultaneous zero values while retaining a zero normal count', () => {
    const result = qualityControlStation([row({ SO2: 0, NO2: 0, O3: 0, CO: 0, PM10: 0, 'PM2.5': 0 })])

    expect(result.rows[0]).toMatchObject({ SO2: 0, NO2: 0, O3: 0, CO: 0, PM10: 0, 'PM2.5': 0, QC_keep: false })
    expect(result.rows[0]?.QC_flags.map((flag) => flag.code)).toEqual(['all-station-zero'])
    expect(result.counts['\u6b63\u5e38']).toBe(0)
  })

  it('audits missing hours as gaps without fabricating measurement rows', () => {
    const result = qualityControlStation([
      row({ timestamp: '2024-11-01 00:00:00' }),
      row({ timestamp: '2024-11-01 02:00:00' }),
    ])

    expect(result.rows).toHaveLength(2)
    expect(result.gaps).toEqual(['2024-11-01 01:00:00'])
    expect(result.gapCount).toBe(1)
    expect(result.warnings).toHaveLength(1)
  })

  it('rejects invalid canonical timestamps, duplicate timestamps, and unsafe row counts', () => {
    expect(() => qualityControlStation([row({ timestamp: '2024/11/01' })])).toThrow(/YYYY-MM-DD HH:00:00/)
    expect(() => qualityControlStation([row(), row()])).toThrow(/duplicate/i)
    expect(() => qualityControlStation(Array.from({ length: 8785 }, (_, index) => row({ timestamp: `2024-01-01 ${String(index % 24).padStart(2, '0')}:00:00` })))).toThrow(/8784/)
  })

  it('does not mutate inputs and keeps all result partitions independent', () => {
    const input = [row(), row({ timestamp: '2024-11-01 01:00:00', SO2: 0, NO2: 0, O3: 0, CO: 0, PM10: 0, 'PM2.5': 0 })]
    const snapshot = structuredClone(input)
    const result = qualityControlStation(input)

    result.rows[0]!.missing.push('SO2')
    result.keptRows[0]!.SO2 = 99
    result.rejectedRows[0]!.QC_flags.length = 0
    expect(input).toEqual(snapshot)
    expect(result.rows[0]?.SO2).toBe(1)
    expect(result.rows[1]?.QC_flags).toHaveLength(1)
  })
})
