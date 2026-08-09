import { describe, expect, it } from 'vitest'

import {
  INCOMPLETE_PRIVATE_PARITY_ENV_MESSAGE,
  privateParityMode,
} from '../helpers/privateParityEnvironment'

describe('private parity environment configuration', () => {
  it.each([
    [undefined, undefined, 'skip'],
    ['', '   ', 'skip'],
    ['station-directory', 'ion-workbook.xlsx', 'run'],
    ['station-directory', undefined, 'invalid'],
    [undefined, 'ion-workbook.xlsx', 'invalid'],
  ] as const)('classifies station=%j ion=%j as %s', (station, ion, expected) => {
    expect(privateParityMode(station, ion)).toBe(expected)
  })

  it('provides an explicit bilingual remediation message', () => {
    expect(INCOMPLETE_PRIVATE_PARITY_ENV_MESSAGE).toMatch(/私有数据配置不完整/)
    expect(INCOMPLETE_PRIVATE_PARITY_ENV_MESSAGE).toMatch(/Incomplete private data configuration/)
    expect(INCOMPLETE_PRIVATE_PARITY_ENV_MESSAGE).toContain('PRIVATE_STATION_FIXTURES')
    expect(INCOMPLETE_PRIVATE_PARITY_ENV_MESSAGE).toContain('PRIVATE_ION_WORKBOOK')
  })
})
