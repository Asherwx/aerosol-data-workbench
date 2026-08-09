import { describe, expect, it } from 'vitest'

import { qualityControlDynamic } from '../../src/core/dynamicQualityControl'
import type { UserMergedRow } from '../../src/core/hourlyMerge'
import type { UserVariableSpec } from '../../src/core/userDataset'

const stationValues = { SO2: 1, NO2: 2, O3: 3, CO: 0.4, PM10: 5, 'PM2.5': 6 } as const
const variables: UserVariableSpec[] = [
  { key: 'dust', label: 'Dust\u0007', unit: 'ug/m3\u202e', nonNegative: true, sourceColumn: 1 },
  { key: 'temperature', label: 'Temperature', unit: 'C', nonNegative: false, sourceColumn: 2 },
]

function row(values: Partial<UserMergedRow> = {}): UserMergedRow {
  return {
    timestamp: '2024-11-01 00:00:00', ...stationValues,
    missing: [], status: '\u5b8c\u6574', userValues: { dust: 1, temperature: -2 }, ...values,
  }
}

describe('qualityControlDynamic', () => {
  it('runs the exact shared station rules before dynamic user-variable rules', () => {
    const result = qualityControlDynamic([
      row({ SO2: -1, userValues: { dust: -3, temperature: -4 } }),
    ], variables)
    expect(result.rows[0]?.QC_flags.map(({ code, variable }) => [code, variable])).toEqual([
      ['negative', 'SO2'], ['negative', 'dust'],
    ])
    expect(result.rows[0]?.QC_flags[1]?.message).toContain('Dust (ug/m3)')
    expect(result.rows[0]?.QC_flags[1]?.message).not.toMatch(/[\u0007\u202e]/)
    expect(result.rows[0]?.userValues).toEqual({ dust: -3, temperature: -4 })
  })

  it('flags missing and nonfinite values for every variable, but negatives only when required', () => {
    const result = qualityControlDynamic([
      row({ userValues: { dust: undefined, temperature: Number.POSITIVE_INFINITY } }),
    ], variables)
    expect(result.rows[0]?.QC_flags.map(({ code, variable }) => [code, variable])).toEqual([
      ['missing', 'dust'], ['nonfinite', 'temperature'],
    ])
    expect(result.counts['\u6b63\u5e38']).toBe(0)
  })

  it('preserves all-zero station behavior and includes a zero normal count', () => {
    const result = qualityControlDynamic([row({
      SO2: 0, NO2: 0, O3: 0, CO: 0, PM10: 0, 'PM2.5': 0,
    })], variables)
    expect(result.rows[0]?.QC_flags.map(({ code }) => code)).toEqual(['all-station-zero'])
    expect(result.counts['\u6b63\u5e38']).toBe(0)
  })

  it('does not mutate scientific values and deep-clones all result partitions', () => {
    const input = [row()]
    const snapshot = structuredClone(input)
    const result = qualityControlDynamic(input, variables)
    result.rows[0]!.userValues.dust = 99
    result.keptRows[0]!.userValues.temperature = 88
    result.keptRows[0]!.QC_flags.push({ code: 'negative', variable: 'dust', message: 'changed' })
    expect(input).toEqual(snapshot)
    expect(result.rows[0]?.userValues.temperature).toBe(-2)
    expect(result.keptRows[0]?.userValues.dust).toBe(1)
    expect(result.rows[0]?.QC_flags).toEqual([])
  })

  it('enforces station QC timestamp, duplicate, and row/range limits', () => {
    expect(() => qualityControlDynamic([row({ timestamp: '2024/11/01' })], variables)).toThrow(/YYYY-MM-DD/)
    expect(() => qualityControlDynamic([row(), row()], variables)).toThrow(/duplicate/i)
    expect(() => qualityControlDynamic([
      row({ timestamp: '2023-01-01 00:00:00' }),
      row({ timestamp: '2025-01-01 00:00:00' }),
    ], variables)).toThrow(/8784/)
  })
})
