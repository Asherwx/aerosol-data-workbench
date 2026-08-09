import { describe, expect, it } from 'vitest'

import {
  MAX_HOURLY_SERIES_HOURS,
  buildHourlySeries,
} from '../../src/core/stationSeries'
import type { HourlyStationRow } from '../../src/core/types'

const completeValues = {
  SO2: 1,
  NO2: 2,
  O3: 3,
  CO: 4,
  PM10: 5,
  'PM2.5': 6,
} as const

describe('buildHourlySeries', () => {
  it('returns empty audit outputs for empty input', () => {
    expect(buildHourlySeries([])).toEqual({
      rows: [],
      duplicateTimes: [],
      warnings: [],
    })
  })

  it('fills every Beijing hour between the earliest and latest rows', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-11-01 02:00:00', SO2: 8 },
      { timestamp: '2024-11-01 00:00:00', SO2: 6 },
    ])

    expect(result.rows.map((row) => row.timestamp)).toEqual([
      '2024-11-01 00:00:00',
      '2024-11-01 01:00:00',
      '2024-11-01 02:00:00',
    ])
    expect(result.rows[1]).toMatchObject({
      status: '存在缺测',
      missing: ['SO2', 'NO2', 'O3', 'CO', 'PM10', 'PM2.5'],
    })
  })

  it('marks a row complete only when all six pollutants are finite', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-11-01 00:00:00', ...completeValues },
    ])

    expect(result.rows).toEqual([
      {
        timestamp: '2024-11-01 00:00:00',
        ...completeValues,
        missing: [],
        status: '完整',
      },
    ])
  })

  it('lists missing pollutants in canonical POLLUTANTS order', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-11-01 00:00:00', NO2: 0, PM10: 9 },
    ])

    expect(result.rows[0]).toMatchObject({
      missing: ['SO2', 'O3', 'CO', 'PM2.5'],
      status: '存在缺测',
    })
  })

  it('merges complementary pollutant values from duplicate timestamp rows', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-11-01 00:00:00', SO2: 1 },
      { timestamp: '2024-11-01 00:00:00', NO2: 2 },
    ])

    expect(result.rows[0]).toMatchObject({ SO2: 1, NO2: 2 })
    expect(result.duplicateTimes).toEqual(['2024-11-01 00:00:00'])
    expect(result.warnings).toEqual([])
  })

  it('retains the first finite conflicting value and emits a deterministic audit warning', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-11-01 00:00:00', SO2: 5 },
      { timestamp: '2024-11-01 00:00:00', SO2: 9 },
    ])

    expect(result.rows[0]?.SO2).toBe(5)
    expect(result.duplicateTimes).toEqual(['2024-11-01 00:00:00'])
    expect(result.warnings).toEqual([
      '时间 2024-11-01 00:00:00 的 SO2 存在重复有效值；已保留首次值 5，忽略后续值 9',
    ])
  })

  it('does not warn when duplicate pollutant values are the same finite number', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-11-01 00:00:00', SO2: 5 },
      { timestamp: '2024-11-01 00:00:00', SO2: 5 },
    ])

    expect(result.rows[0]?.SO2).toBe(5)
    expect(result.duplicateTimes).toEqual(['2024-11-01 00:00:00'])
    expect(result.warnings).toEqual([])
  })

  it('preserves zero and lets neither undefined nor a later finite duplicate erase it', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-11-01 00:00:00', SO2: 0 },
      { timestamp: '2024-11-01 00:00:00', SO2: undefined },
      { timestamp: '2024-11-01 00:00:00', SO2: 7 },
    ])

    expect(result.rows[0]?.SO2).toBe(0)
    expect(result.warnings).toEqual([
      '时间 2024-11-01 00:00:00 的 SO2 存在重复有效值；已保留首次值 0，忽略后续值 7',
    ])
  })

  it.each([
    '2024-11-01T00:00:00',
    '2024-11-01 00:30:00',
    '2024-02-30 00:00:00',
    '2024-11-01 24:00:00',
  ])('rejects invalid canonical Beijing timestamp %s', (timestamp) => {
    expect(() => buildHourlySeries([{ timestamp, SO2: 1 }])).toThrow(
      `无效小时数据时间：${timestamp}`,
    )
  })

  it('crosses month and year boundaries without host-local date parsing', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-12-31 23:00:00', SO2: 1 },
      { timestamp: '2025-01-01 01:00:00', SO2: 2 },
    ])

    expect(result.rows.map((row) => row.timestamp)).toEqual([
      '2024-12-31 23:00:00',
      '2025-01-01 00:00:00',
      '2025-01-01 01:00:00',
    ])
  })

  it('crosses a leap-day boundary', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-02-28 23:00:00', SO2: 1 },
      { timestamp: '2024-02-29 01:00:00', SO2: 2 },
    ])

    expect(result.rows.map((row) => row.timestamp)).toEqual([
      '2024-02-28 23:00:00',
      '2024-02-29 00:00:00',
      '2024-02-29 01:00:00',
    ])
  })

  it('accepts the maximum expected inclusive hourly timeline', () => {
    const result = buildHourlySeries([
      { timestamp: '2024-01-01 00:00:00', SO2: 1 },
      { timestamp: '2024-12-31 23:00:00', SO2: 2 },
    ])

    expect(result.rows).toHaveLength(MAX_HOURLY_SERIES_HOURS)
  })

  it('rejects an unexpectedly oversized timeline before allocation', () => {
    expect(() =>
      buildHourlySeries([
        { timestamp: '2024-01-01 00:00:00', SO2: 1 },
        { timestamp: '2025-01-01 00:00:00', SO2: 2 },
      ]),
    ).toThrow(`小时序列超过安全上限 ${MAX_HOURLY_SERIES_HOURS}`)
  })

  it('does not mutate input and does not alias input or output arrays and objects', () => {
    const input: HourlyStationRow[] = [
      { timestamp: '2024-11-01 00:00:00', SO2: 1 },
    ]
    const snapshot = structuredClone(input)
    const first = buildHourlySeries(input)

    first.rows[0]!.SO2 = 99
    first.rows[0]!.missing.push('NO2')
    first.duplicateTimes.push('2099-01-01 00:00:00')
    first.warnings.push('changed')
    const second = buildHourlySeries(input)

    expect(input).toEqual(snapshot)
    expect(first.rows[0]).not.toBe(input[0])
    expect(second.rows[0]?.SO2).toBe(1)
    expect(second.rows[0]?.missing).toEqual(['NO2', 'O3', 'CO', 'PM10', 'PM2.5'])
    expect(second.duplicateTimes).toEqual([])
    expect(second.warnings).toEqual([])
  })
})
