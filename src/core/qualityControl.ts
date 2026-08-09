import type { MergedRow } from './hourlyMerge'
import {
  collectStationMeasurementFlags,
} from './stationQualityControl'
import type { Pollutant } from './types'

export const QC_VARIABLES = [
  { key: 'SO2', displayName: 'SO2 (μg/m³)' },
  { key: 'NO2', displayName: 'NO2 (μg/m³)' },
  { key: 'O3', displayName: 'O3 (μg/m³)' },
  { key: 'CO', displayName: 'CO (mg/m³)' },
  { key: 'PM10', displayName: 'PM10 (μg/m³)' },
  { key: 'PM2.5', displayName: 'PM2.5 (μg/m³)' },
  { key: 'NO3', displayName: 'NO3 (μg/m³)' },
  { key: 'SO4', displayName: 'SO4 (μg/m³)' },
  { key: 'NH4', displayName: 'NH4 (μg/m³)' },
] as const

const STATION_VARIABLES = QC_VARIABLES.slice(0, 6) as readonly {
  key: Pollutant
  displayName: string
}[]
const COMPLETE_STATUSES = new Set(['完整'])

export type QcVariable = (typeof QC_VARIABLES)[number]['key']
export type QcFlagCode =
  | 'missing'
  | 'nonfinite'
  | 'negative'
  | 'all-station-zero'
  | 'station-missing-omitted'
  | 'station-finite-declared-missing'
  | 'station-status-mismatch'

export interface StructuredQcFlag {
  code: QcFlagCode
  variable?: QcVariable
  message: string
}

export type CheckedRow = MergedRow & {
  QC_flag: string
  QC_flags: StructuredQcFlag[]
  QC_keep: boolean
}

export interface QualityControlResult {
  rows: CheckedRow[]
  counts: Record<string, number>
  keptRows: CheckedRow[]
  rejectedRows: CheckedRow[]
}

function cloneCheckedRow(row: CheckedRow): CheckedRow {
  return {
    ...row,
    missing: [...row.missing],
    QC_flags: row.QC_flags.map((flag) => ({ ...flag })),
  }
}

function addFlag(
  flags: StructuredQcFlag[],
  seenMessages: Set<string>,
  flag: StructuredQcFlag,
): void {
  if (seenMessages.has(flag.message)) return
  seenMessages.add(flag.message)
  flags.push(flag)
}

export function qualityControl(input: readonly MergedRow[]): QualityControlResult {
  const counts: Record<string, number> = { 正常: 0 }
  const rows = input.map((source): CheckedRow => {
    const flags: StructuredQcFlag[] = []
    const seenMessages = new Set<string>()

    for (const flag of collectStationMeasurementFlags(source)) {
      addFlag(flags, seenMessages, flag)
    }

    for (const variable of QC_VARIABLES) {
      if (STATION_VARIABLES.some((stationVariable) => stationVariable.key === variable.key)) continue
      const value = source[variable.key]
      if (value === undefined) {
        addFlag(flags, seenMessages, {
          code: 'missing',
          variable: variable.key,
          message: `缺失：${variable.displayName}`,
        })
      } else if (!Number.isFinite(value)) {
        addFlag(flags, seenMessages, {
          code: 'nonfinite',
          variable: variable.key,
          message: `非有限值：${variable.displayName}`,
        })
      } else if (value < 0) {
        addFlag(flags, seenMessages, {
          code: 'negative',
          variable: variable.key,
          message: `负值：${variable.displayName}`,
        })
      }
    }

    if (STATION_VARIABLES.every((variable) => source[variable.key] === 0)) {
      addFlag(flags, seenMessages, {
        code: 'all-station-zero',
        message: '六项污染物同时为0',
      })
    }

    const declaredMissing = new Set<Pollutant>(source.missing)
    for (const variable of STATION_VARIABLES) {
      const value = source[variable.key]
      const actualMissing = !Number.isFinite(value)
      const isDeclaredMissing = declaredMissing.has(variable.key)
      if (actualMissing && !isDeclaredMissing) {
        addFlag(flags, seenMessages, {
          code: 'station-missing-omitted',
          variable: variable.key,
          message: `站点缺测标记遗漏：${variable.displayName}`,
        })
      } else if (!actualMissing && isDeclaredMissing) {
        addFlag(flags, seenMessages, {
          code: 'station-finite-declared-missing',
          variable: variable.key,
          message: `站点有限值被标为缺测：${variable.displayName}`,
        })
      }
    }

    const hasStationMissing = STATION_VARIABLES.some(
      (variable) => !Number.isFinite(source[variable.key]),
    )
    const statusAgrees = hasStationMissing
      ? source.status === '存在缺测'
      : COMPLETE_STATUSES.has(source.status)
    if (!statusAgrees) {
      addFlag(flags, seenMessages, {
        code: 'station-status-mismatch',
        message: '站点状态与缺测字段不一致',
      })
    }

    const QC_flag = flags.length === 0
      ? '正常'
      : flags.map((flag) => flag.message).join('；')
    if (flags.length === 0) {
      counts.正常 = (counts.正常 ?? 0) + 1
    } else {
      for (const flag of flags) {
        counts[flag.message] = (counts[flag.message] ?? 0) + 1
      }
    }

    return {
      ...source,
      missing: [...source.missing],
      QC_flag,
      QC_flags: flags.map((flag) => ({ ...flag })),
      QC_keep: flags.length === 0,
    }
  })

  return {
    rows,
    counts,
    keptRows: rows.filter((row) => row.QC_keep).map(cloneCheckedRow),
    rejectedRows: rows.filter((row) => !row.QC_keep).map(cloneCheckedRow),
  }
}
