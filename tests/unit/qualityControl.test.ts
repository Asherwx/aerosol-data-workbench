import { describe, expect, it } from 'vitest'

import type { MergedRow } from '../../src/core/hourlyMerge'
import {
  QC_VARIABLES,
  qualityControl,
} from '../../src/core/qualityControl'

const complete = {
  SO2: 1,
  NO2: 2,
  O3: 3,
  CO: 0.4,
  PM10: 5,
  'PM2.5': 6,
  NO3: 7,
  SO4: 8,
  NH4: 9,
} as const

function row(values: Partial<MergedRow> = {}): MergedRow {
  return {
    timestamp: '2024-11-01 00:00:00',
    ...complete,
    missing: [],
    status: '完整',
    ...values,
  }
}

describe('qualityControl', () => {
  it('retains the merged nine-variable compatibility wrapper', () => {
    const result = qualityControl([row({ NO3: -1 })])

    expect(result.rows[0]).toMatchObject({
      NO3: -1,
      QC_keep: false,
      QC_flags: [{ code: 'negative', variable: 'NO3', message: '\u8d1f\u503c\uff1aNO3 (\u03bcg/m\u00b3)' }],
    })
  })

  it('keeps a normal row and records the normal summary count', () => {
    const result = qualityControl([row()])

    expect(result.rows[0]).toMatchObject({ QC_flag: '正常', QC_flags: [], QC_keep: true })
    expect(result.counts).toEqual({ 正常: 1 })
    expect(result.keptRows).toEqual(result.rows)
    expect(result.rejectedRows).toEqual([])
  })

  it('exports exact display names and units for all required variables', () => {
    expect(QC_VARIABLES).toEqual([
      { key: 'SO2', displayName: 'SO2 (μg/m³)' },
      { key: 'NO2', displayName: 'NO2 (μg/m³)' },
      { key: 'O3', displayName: 'O3 (μg/m³)' },
      { key: 'CO', displayName: 'CO (mg/m³)' },
      { key: 'PM10', displayName: 'PM10 (μg/m³)' },
      { key: 'PM2.5', displayName: 'PM2.5 (μg/m³)' },
      { key: 'NO3', displayName: 'NO3 (μg/m³)' },
      { key: 'SO4', displayName: 'SO4 (μg/m³)' },
      { key: 'NH4', displayName: 'NH4 (μg/m³)' },
    ])
  })

  it('flags missing station and ion variables precisely without treating zero as missing', () => {
    const stationMissing = row({ SO2: undefined, missing: ['SO2'], status: '存在缺测' })
    const ionMissing = row({ NH4: undefined })
    const result = qualityControl([stationMissing, ionMissing])

    expect(result.rows[0]?.QC_flags).toEqual([
      { code: 'missing', variable: 'SO2', message: '缺失：SO2 (μg/m³)' },
    ])
    expect(result.rows[1]?.QC_flags).toEqual([
      { code: 'missing', variable: 'NH4', message: '缺失：NH4 (μg/m³)' },
    ])
  })

  it('distinguishes nonfinite and negative values with precise variable names', () => {
    const result = qualityControl([
      row({ NO2: Number.NaN, NO3: Number.POSITIVE_INFINITY, CO: -0.1, SO4: -2 }),
    ])

    expect(result.rows[0]?.QC_flags).toEqual([
      { code: 'nonfinite', variable: 'NO2', message: '非有限值：NO2 (μg/m³)' },
      { code: 'negative', variable: 'CO', message: '负值：CO (mg/m³)' },
      { code: 'nonfinite', variable: 'NO3', message: '非有限值：NO3 (μg/m³)' },
      { code: 'negative', variable: 'SO4', message: '负值：SO4 (μg/m³)' },
      { code: 'station-missing-omitted', variable: 'NO2', message: '站点缺测标记遗漏：NO2 (μg/m³)' },
      { code: 'station-status-mismatch', message: '站点状态与缺测字段不一致' },
    ])
    expect(result.rows[0]?.QC_keep).toBe(false)
  })

  it('flags all six station pollutants equal to zero and preserves every original zero', () => {
    const zeroRow = row({ SO2: 0, NO2: 0, O3: 0, CO: 0, PM10: 0, 'PM2.5': 0 })
    const result = qualityControl([zeroRow])

    expect(result.rows[0]?.QC_flag).toBe('六项污染物同时为0')
    expect(result.rows[0]?.QC_keep).toBe(false)
    expect(result.rows[0]).toMatchObject({ SO2: 0, NO2: 0, O3: 0, CO: 0, PM10: 0, 'PM2.5': 0 })
    expect(result.rows[0]).toMatchObject({ NO3: 7, SO4: 8, NH4: 9 })
    expect(result.counts).toMatchObject({ 正常: 0, 六项污染物同时为0: 1 })
  })

  it('does not flag partial zeros when all required values are otherwise valid', () => {
    const result = qualityControl([row({ SO2: 0, NO2: 0, CO: 0 })])
    expect(result.rows[0]).toMatchObject({ QC_flag: '正常', QC_keep: true })
  })

  it('reflects inconsistent station missing/status metadata without duplicate equivalent flags', () => {
    const result = qualityControl([
      row({ SO2: undefined, missing: [], status: '完整' }),
      row({ missing: ['NO2'], status: '完整' }),
    ])

    expect(result.rows[0]?.QC_flags.map((flag) => flag.message)).toEqual([
      '缺失：SO2 (μg/m³)',
      '站点缺测标记遗漏：SO2 (μg/m³)',
      '站点状态与缺测字段不一致',
    ])
    expect(result.rows[1]?.QC_flags.map((flag) => flag.message)).toEqual([
      '站点有限值被标为缺测：NO2 (μg/m³)',
    ])
  })

  it.each([
    {
      name: 'actual missing omitted while status says missing',
      values: { SO2: undefined, missing: [], status: '存在缺测' } as Partial<MergedRow>,
      messages: ['缺失：SO2 (μg/m³)', '站点缺测标记遗漏：SO2 (μg/m³)'],
    },
    {
      name: 'nonfinite omitted while status says missing',
      values: { SO2: Number.NaN, missing: [], status: '存在缺测' } as Partial<MergedRow>,
      messages: ['非有限值：SO2 (μg/m³)', '站点缺测标记遗漏：SO2 (μg/m³)'],
    },
    {
      name: 'finite declared missing while status says complete',
      values: { missing: ['SO2'], status: '完整' } as Partial<MergedRow>,
      messages: ['站点有限值被标为缺测：SO2 (μg/m³)'],
    },
    {
      name: 'finite declared missing while status says missing',
      values: { missing: ['SO2'], status: '存在缺测' } as Partial<MergedRow>,
      messages: [
        '站点有限值被标为缺测：SO2 (μg/m³)',
        '站点状态与缺测字段不一致',
      ],
    },
  ])('checks missing metadata bidirectionally: $name', ({ values, messages }) => {
    const result = qualityControl([row(values)])
    expect(result.rows[0]?.QC_flags.map((flag) => flag.message)).toEqual(messages)
  })

  it('orders multiple flags deterministically and tallies each individual flag', () => {
    const result = qualityControl([
      row({ SO2: undefined, missing: ['SO2'], status: '存在缺测', NO3: -1 }),
      row({ SO2: undefined, missing: ['SO2'], status: '存在缺测' }),
      row(),
    ])

    expect(result.rows[0]?.QC_flag).toBe('缺失：SO2 (μg/m³)；负值：NO3 (μg/m³)')
    expect(result.counts).toEqual({
      '缺失：SO2 (μg/m³)': 2,
      '负值：NO3 (μg/m³)': 1,
      正常: 1,
    })
    expect(result.keptRows).toHaveLength(1)
    expect(result.rejectedRows).toHaveLength(2)
    expect(result.rows.map((checked) => checked.timestamp)).toEqual([
      '2024-11-01 00:00:00',
      '2024-11-01 00:00:00',
      '2024-11-01 00:00:00',
    ])
  })

  it('does not mutate inputs or alias rows, missing arrays, flags, or result partitions', () => {
    const input = [row()]
    const snapshot = structuredClone(input)
    const first = qualityControl(input)
    first.rows[0]!.SO2 = 99
    first.rows[0]!.missing.push('NO2')
    first.rows[0]!.QC_flags.push({ code: 'negative', variable: 'NH4', message: 'changed' })
    const second = qualityControl(input)

    expect(input).toEqual(snapshot)
    expect(first.rows[0]).not.toBe(input[0])
    expect(first.rows[0]?.missing).not.toBe(input[0]?.missing)
    expect(first.keptRows).not.toBe(first.rows)
    expect(first.keptRows[0]).not.toBe(first.rows[0])
    first.keptRows[0]!.SO2 = 77
    first.keptRows[0]!.missing.push('O3')
    first.keptRows[0]!.QC_flags.push({
      code: 'negative',
      variable: 'NH4',
      message: 'partition changed',
    })
    expect(first.rows[0]?.SO2).toBe(99)
    expect(first.rows[0]?.missing).not.toContain('O3')
    expect(first.rows[0]?.QC_flags).not.toContainEqual({
      code: 'negative',
      variable: 'NH4',
      message: 'partition changed',
    })
    expect(second.rows[0]?.SO2).toBe(1)
    expect(second.rows[0]?.QC_flags).not.toContainEqual({
      code: 'negative',
      variable: 'NH4',
      message: 'changed',
    })
  })

  it('keeps rejected partition rows independent from the primary checked rows', () => {
    const result = qualityControl([row({ NO3: -1 })])

    expect(result.rejectedRows[0]).not.toBe(result.rows[0])
    result.rejectedRows[0]!.NO3 = 10
    result.rejectedRows[0]!.QC_flags.length = 0

    expect(result.rows[0]?.NO3).toBe(-1)
    expect(result.rows[0]?.QC_flags).toHaveLength(1)
  })
})
