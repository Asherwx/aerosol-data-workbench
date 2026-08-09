import type { ResultArtifacts } from '../core/exports'
import type { DynamicQualityControlResult } from '../core/dynamicQualityControl'
import type { QcWorkbookMetadata } from '../core/exportShared'
import type { HourlyMergeResult, UserHourlyMergeResult } from '../core/hourlyMerge'
import type { ParseIonWorkbookOptions, ParsedIonWorkbook } from '../core/ionWorkbook'
import type { QualityControlResult } from '../core/qualityControl'
import type { ParsedStationFile } from '../core/stationCsv'
import type { HourlySeriesResult, StationSeriesRow } from '../core/stationSeries'
import type { ParsedUserDataset, UserDataMapping, UserMappingRequired } from '../core/userDataset'
import type {
  DownloadLink,
  DownloadStationRangeOptions,
  DownloadStationRangeProgress,
  DownloadedStationRange,
  HourlyStationRow,
} from '../core/types'

export const PIPELINE_STEPS = [
  'data-source',
  'station-series',
  'quality-control',
  'exports',
] as const

export type PipelineStep = (typeof PIPELINE_STEPS)[number]
export type PipelineStage = PipelineStep

export type DataSourceMode = 'online-links' | 'online-station' | 'local-import'
export type QcMode = 'station' | 'merged'
export type SourceStatus = 'empty' | 'parsing' | 'ready' | 'error'
export type UserDataStatus = SourceStatus | 'mapping-required'
export type PipelineStatus = 'idle' | 'running' | 'complete' | 'error' | 'cancelled'

export interface CreateExportArtifactsInput {
  mode: QcMode
  stationRows: readonly StationSeriesRow[]
  qcResult: QualityControlResult | DynamicQualityControlResult
  metadata: QcWorkbookMetadata
  startDate: string
  endDate: string
  signal: AbortSignal
  parsedUserDataset: ParsedUserDataset | null
  userMergeResult: UserHourlyMergeResult | null
}

export interface RunQcModeInput {
  stationRows: readonly StationSeriesRow[]
  ionFile: File | null
  signal: AbortSignal
}

export interface PipelineServices {
  buildDownloadLinks(startDate: string, endDate: string): DownloadLink[]
  downloadStationRange?: (
    options: DownloadStationRangeOptions,
  ) => Promise<DownloadedStationRange>
  parseStationInputs?: (
    files: readonly File[],
    stationId: string,
    signal?: AbortSignal,
  ) => Promise<ParsedStationFile[]>
  buildHourlySeries(rows: readonly HourlyStationRow[]): HourlySeriesResult
  runQcMode?: (
    mode: QcMode,
    input: RunQcModeInput,
  ) => Promise<QualityControlResult> | QualityControlResult
  createExportArtifacts?: (
    input: CreateExportArtifactsInput,
  ) => Promise<ResultArtifacts>
  parseUserDataFile?: (
    file: File,
    mapping: UserDataMapping | undefined,
    signal: AbortSignal,
  ) => Promise<ParsedUserDataset>

  // Compatibility services used by the pre-redesign UI and tests until Task 10.
  parseStationFiles?: (
    files: readonly File[],
    stationId: string,
    signal?: AbortSignal,
  ) => Promise<ParsedStationFile[]>
  parseIonWorkbook?: (
    input: ArrayBuffer | File,
    filename: string,
    options?: ParseIonWorkbookOptions,
  ) => Promise<ParsedIonWorkbook>
  mergeHourly?: (
    stationRows: readonly StationSeriesRow[],
    ionRows: readonly ParsedIonWorkbook['rows'][number][],
  ) => HourlyMergeResult
  runQualityControl?: (rows: HourlyMergeResult['rows']) => QualityControlResult
}

export type DownloadFn = (content: Blob, filename: string) => void

export interface UsePipelineOptions {
  services?: PipelineServices
  stationEndpoint?: string
  download?: DownloadFn
  now?: () => Date
  warningLimit?: number
  version?: string
}

export interface PipelineModel {
  startDate: string
  endDate: string
  stationId: string
  stationFiles: File[]
  ionFile: File | null
  userDataFile: File | null
  userDataStatus: UserDataStatus
  userDataError: string | null
  parsedUserDataset: ParsedUserDataset | null
  userMappingRequired: UserMappingRequired | null
  sourceMode: DataSourceMode | null
  sourceStatus: SourceStatus
  downloadProgress: DownloadStationRangeProgress | null
  activeStep: PipelineStep
  qcMode: QcMode | null
  status: PipelineStatus
  progress: number
  message: string
  error: string | null
  warnings: string[]
  downloadLinks: DownloadLink[]
  parsedStationFiles: ParsedStationFile[]
  stationSeries: HourlySeriesResult | null
  stationSeriesResult: HourlySeriesResult | null
  stationRows: StationSeriesRow[]
  stationQcResult: QualityControlResult | null
  mergedQcResult: DynamicQualityControlResult | null
  qcResult: QualityControlResult | DynamicQualityControlResult | null
  exportArtifactsByMode: Record<QcMode, ResultArtifacts | null>
  exportArtifacts: ResultArtifacts | null

  // Compatibility data retained until the merged-data redesign lands.
  ionWorkbook: ParsedIonWorkbook | null
  ionRows: ParsedIonWorkbook['rows']
  mergeResult: HourlyMergeResult | null
  userMergeResult: UserHourlyMergeResult | null

  setStartDate(value: string): void
  setEndDate(value: string): void
  setStationId(value: string): void
  setSourceMode(value: DataSourceMode): void
  setStationFiles(value: File[]): void
  setIonFile(value: File | null): void
  setUserDataFile(value: File | null, mapping?: UserDataMapping): void
  setParsedUserDataset(value: ParsedUserDataset | null): void
  setQcMode(value: QcMode | null): void
  setActiveStep(value: PipelineStep): void
  downloadAndUseStationData(): Promise<void>
  runQcMode(mode: QcMode): Promise<void>
  canRun(step: PipelineStep): boolean
  runStep(step: PipelineStep): Promise<void>
  runAll(): Promise<void>
  cancel(): void
  resetResults(): void
}
