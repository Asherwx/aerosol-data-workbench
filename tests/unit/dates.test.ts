import { describe, expect, it } from 'vitest'

import { formatUtcDate, iterateUtcDaysInclusive } from '../../src/core/dates'

describe('date helpers', () => {
  it('rejects an invalid Date when formatting', () => {
    expect(() => formatUtcDate(new Date(Number.NaN))).toThrow('日期对象无效')
  })

  it('rejects an invalid iteration endpoint', () => {
    expect(() => Array.from(iterateUtcDaysInclusive(new Date(), new Date(Number.NaN)))).toThrow(
      '日期对象无效',
    )
  })

  it('normalizes iteration endpoints to UTC midnight', () => {
    const dates = Array.from(
      iterateUtcDaysInclusive(
        new Date('2024-12-31T23:30:00.000Z'),
        new Date('2025-01-01T01:30:00.000Z'),
      ),
    )

    expect(dates.map((date) => date.toISOString())).toEqual([
      '2024-12-31T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
    ])
  })
})
