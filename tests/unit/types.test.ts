import { describe, expect, it } from 'vitest'

import { POLLUTANTS } from '../../src/core/types'

describe('domain types', () => {
  it('exports pollutants in the required order', () => {
    expect(POLLUTANTS).toEqual(['SO2', 'NO2', 'O3', 'CO', 'PM10', 'PM2.5'])
  })
})
