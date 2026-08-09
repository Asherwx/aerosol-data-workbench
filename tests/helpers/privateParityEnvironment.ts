export type PrivateParityMode = 'skip' | 'run' | 'invalid'

export const INCOMPLETE_PRIVATE_PARITY_ENV_MESSAGE =
  '私有数据配置不完整 / Incomplete private data configuration: set both PRIVATE_STATION_FIXTURES and PRIVATE_ION_WORKBOOK, or unset both.'

export function privateParityMode(
  stationFixtures: string | undefined,
  ionWorkbook: string | undefined,
): PrivateParityMode {
  const hasStation = Boolean(stationFixtures?.trim())
  const hasIon = Boolean(ionWorkbook?.trim())
  if (hasStation && hasIon) return 'run'
  if (!hasStation && !hasIon) return 'skip'
  return 'invalid'
}
