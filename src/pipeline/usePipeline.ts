import { useCallback, useEffect, useRef, useState } from 'react'

import type { ResultArtifacts } from '../core/exports'
import { qualityControlDynamic, type DynamicQualityControlResult } from '../core/dynamicQualityControl'
import { sanitizeLogText, sanitizeQcWorkbookMetadata } from '../core/exportShared'
import { mergeUserHourly, type HourlyMergeResult, type UserHourlyMergeResult } from '../core/hourlyMerge'
import type { ParsedIonWorkbook } from '../core/ionWorkbook'
import type { QualityControlResult } from '../core/qualityControl'
import type { ParsedStationFile } from '../core/stationCsv'
import type { HourlySeriesResult } from '../core/stationSeries'
import type { ParsedUserDataset, UserDataMapping } from '../core/userDataset'
import { parseUserCsvFile, parseUserWorkbook } from '../core/userWorkbook'
import { MAX_DOWNLOAD_RANGE_DAYS } from '../core/downloadLinks'
import { isSafeStationEndpoint } from '../core/onlineStationDownload'
import { STATION_ID_PATTERN, type DownloadLink, type DownloadStationRangeProgress } from '../core/types'
import { defaultPipelineServices, defaultStationEndpoint } from './defaultPipelineServices'
import {
  PIPELINE_STEPS,
  type DataSourceMode,
  type PipelineModel,
  type PipelineServices,
  type PipelineStage,
  type PipelineStep,
  type QcMode,
  type SourceStatus,
  type UserDataStatus,
  type UsePipelineOptions,
} from './pipelineTypes'

export { PIPELINE_STEPS, defaultPipelineServices }
export type {
  CreateExportArtifactsInput,
  DataSourceMode,
  DownloadFn,
  PipelineModel,
  PipelineServices,
  PipelineStage,
  PipelineStatus,
  PipelineStep,
  QcMode,
  RunQcModeInput,
  SourceStatus,
  UserDataStatus,
  UsePipelineOptions,
} from './pipelineTypes'

type Results = {
  downloadLinks: DownloadLink[]
  parsedStationFiles: ParsedStationFile[]
  stationSeries: HourlySeriesResult | null
  stationQcResult: QualityControlResult | null
  mergedQcResult: DynamicQualityControlResult | null
  exportArtifactsByMode: Record<QcMode, ResultArtifacts | null>
  ionWorkbook: ParsedIonWorkbook | null
  ionRows: ParsedIonWorkbook['rows']
  mergeResult: HourlyMergeResult | null
  userMergeResult: UserHourlyMergeResult | null
}

const EMPTY_RESULTS: Results = {
  downloadLinks: [],
  parsedStationFiles: [],
  stationSeries: null,
  stationQcResult: null,
  mergedQcResult: null,
  exportArtifactsByMode: { station: null, merged: null },
  ionWorkbook: null,
  ionRows: [],
  mergeResult: null,
  userMergeResult: null,
}

type Inputs = {
  startDate: string
  endDate: string
  stationId: string
  stationFiles: File[]
  ionFile: File | null
  sourceMode: DataSourceMode | null
  qcMode: QcMode | null
  userDataFile: File | null
}

type ActiveRun = {
  id: number
  stage: PipelineStage
  mode: QcMode | null
  kind: 'step' | 'run-all'
}

class PipelinePrerequisiteError extends Error {}

type CompletionKey = 'data-source' | 'station-series' | `quality-control:${QcMode}` | `exports:${QcMode}`

function completionKey(stage: PipelineStage, mode: QcMode | null): CompletionKey | null {
  if (stage === 'data-source' || stage === 'station-series') return stage
  return mode === null ? null : `${stage}:${mode}`
}

function safeFilename(value: string): string {
  return value.split(/[\\/]/).at(-1) || '未命名文件'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
}

function validDownloadRange(startDate: string, endDate: string): boolean {
  if (!validIsoDate(startDate) || !validIsoDate(endDate)) return false
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  const inclusiveDays = (end - start) / (24 * 60 * 60 * 1000) + 1
  return inclusiveDays >= 1 && inclusiveDays <= MAX_DOWNLOAD_RANGE_DAYS
}

function assertDates(startDate: string, endDate: string): void {
  if (!validIsoDate(startDate) || !validIsoDate(endDate)) {
    throw new PipelinePrerequisiteError('请选择有效的开始和结束日期')
  }
  if (endDate < startDate) throw new PipelinePrerequisiteError('结束日期不能早于开始日期')
}

function isPipelineStage(step: unknown): step is PipelineStep {
  return typeof step === 'string' && (PIPELINE_STEPS as readonly string[]).includes(step)
}

function sanitizeParsedFiles(files: readonly ParsedStationFile[]): ParsedStationFile[] {
  return files.map((file) => ({
    ...file,
    filename: safeFilename(file.filename),
    rows: file.rows.map((row) => ({ ...row })),
    warnings: file.warnings.map((warning) => sanitizeLogText(warning)),
  }))
}

function messageFor(stage: PipelineStage, running: boolean): string {
  const label: Record<PipelineStage, string> = {
    'data-source': '获取或导入数据',
    'station-series': '构建逐时序列',
    'quality-control': '执行数据质控',
    exports: '生成导出文件',
  }
  return running ? `正在${label[stage]}…` : `${label[stage]}完成`
}

function unsupportedQcMessage(mode: QcMode): string {
  return mode === 'station'
    ? '当前版本尚未提供站点数据质控服务'
    : '当前版本尚未提供用户数据合并质控服务'
}

function cloneParsedUserDataset(value: ParsedUserDataset): ParsedUserDataset {
  return {
    rows: value.rows.map((row) => ({ timestamp: row.timestamp, values: { ...row.values } })),
    variables: value.variables.map((variable) => ({ ...variable })),
    ...(value.mapping ? {
      mapping: {
        timestampColumn: value.mapping.timestampColumn,
        variables: value.mapping.variables.map((variable) => ({ ...variable })),
      },
    } : {}),
    ...(value.mappingRequired ? {
      mappingRequired: {
        reason: value.mappingRequired.reason,
        timeCandidates: [...value.mappingRequired.timeCandidates],
        columns: value.mappingRequired.columns.map((column) => ({ ...column })),
      },
    } : {}),
    warnings: value.warnings.map((warning) => sanitizeLogText(warning)),
    warningTotal: value.warningTotal,
    sheetName: sanitizeLogText(value.sheetName),
  }
}

async function parseUserDataFileDefault(
  file: File,
  mapping: UserDataMapping | undefined,
  signal: AbortSignal,
): Promise<ParsedUserDataset> {
  if (signal.aborted) throw new DOMException('User data parsing was cancelled.', 'AbortError')
  if (/\.xlsx$/i.test(file.name)) return parseUserWorkbook(file, file.name, { mapping, signal })
  if (!/\.csv$/i.test(file.name)) throw new Error('User data file must be CSV or XLSX.')
  return parseUserCsvFile(file, file.name, { mapping, signal })
}

export function usePipeline(options: UsePipelineOptions = {}): PipelineModel {
  const services = options.services ?? defaultPipelineServices
  const endpoint = options.stationEndpoint ?? defaultStationEndpoint()
  const now = options.now ?? (() => new Date())
  const warningLimit = Math.max(1, Math.min(100, Math.floor(options.warningLimit ?? 100)))
  const version = options.version ?? '0.0.0'
  const download = options.download

  const [inputs, setInputs] = useState<Inputs>({
    startDate: '',
    endDate: '',
    stationId: '3329A',
    stationFiles: [],
    ionFile: null,
    userDataFile: null,
    sourceMode: null,
    qcMode: 'station',
  })
  const [results, setResults] = useState<Results>(EMPTY_RESULTS)
  const [sourceStatus, setSourceStatusState] = useState<SourceStatus>('empty')
  const [downloadProgress, setDownloadProgressState] = useState<DownloadStationRangeProgress | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [activeStep, setActiveStepState] = useState<PipelineStage>('data-source')
  const [status, setStatusState] = useState<PipelineModel['status']>('idle')
  const [parsedUserDataset, setParsedUserDatasetState] = useState<ParsedUserDataset | null>(null)
  const [userDataStatus, setUserDataStatus] = useState<UserDataStatus>('empty')
  const [userDataError, setUserDataError] = useState<string | null>(null)

  const inputsRef = useRef(inputs)
  const resultsRef = useRef(results)
  const sourceStatusRef = useRef<SourceStatus>('empty')
  const activeStepRef = useRef<PipelineStage>('data-source')
  const statusRef = useRef<PipelineModel['status']>('idle')
  const parsedUserDatasetRef = useRef<ParsedUserDataset | null>(null)
  const warningBucketsRef = useRef<Partial<Record<PipelineStage | `qc:${QcMode}` | 'user-data', readonly string[]>>>({})
  const completionVersionsRef = useRef<Partial<Record<CompletionKey, string>>>({})
  const runIdRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const activeRunRef = useRef<ActiveRun | null>(null)
  const userRunIdRef = useRef(0)
  const userControllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  const publishResults = useCallback((next: Results) => {
    resultsRef.current = next
    if (mountedRef.current) setResults(next)
  }, [])

  const publishSourceStatus = useCallback((next: SourceStatus) => {
    sourceStatusRef.current = next
    if (mountedRef.current) setSourceStatusState(next)
  }, [])

  const publishStatus = useCallback((next: PipelineModel['status']) => {
    statusRef.current = next
    if (mountedRef.current) setStatusState(next)
  }, [])

  const publishProgress = useCallback((next: DownloadStationRangeProgress | null) => {
    if (mountedRef.current) setDownloadProgressState(next)
  }, [])

  const publishWarnings = useCallback(() => {
    const unique: string[] = []
    const seen = new Set<string>()
    for (const values of Object.values(warningBucketsRef.current)) {
      for (const raw of values ?? []) {
        const warning = sanitizeLogText(raw)
        if (!warning || seen.has(warning)) continue
        seen.add(warning)
        unique.push(warning)
      }
    }
    const next = unique.length <= warningLimit
      ? unique
      : [...unique.slice(0, Math.max(0, warningLimit - 1)), `警告共 ${unique.length} 条；已省略 ${unique.length - Math.max(0, warningLimit - 1)} 条`]
    if (mountedRef.current) setWarnings(next)
  }, [warningLimit])

  const supersede = useCallback(() => {
    runIdRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    activeRunRef.current = null
    return runIdRef.current
  }, [])

  const supersedeUser = useCallback(() => {
    userRunIdRef.current += 1
    userControllerRef.current?.abort()
    userControllerRef.current = null
    return userRunIdRef.current
  }, [])

  const supersedeMergedRun = useCallback(() => {
    const active = activeRunRef.current
    if (!active || active.mode !== 'merged') return
    if (active.stage !== 'quality-control' && active.stage !== 'exports') return
    supersede()
    publishStatus('idle')
  }, [publishStatus, supersede])

  const isCurrent = useCallback((id: number) => mountedRef.current && runIdRef.current === id, [])

  const clearDownstream = useCallback((stage: PipelineStage, qcMode?: QcMode | null) => {
    const current = resultsRef.current
    let next = current
    if (stage === 'data-source') {
      next = {
        ...current,
        stationSeries: null,
        stationQcResult: null,
        mergedQcResult: null,
        exportArtifactsByMode: { station: null, merged: null },
        ionWorkbook: null,
        ionRows: [],
        mergeResult: null,
        userMergeResult: null,
      }
      delete warningBucketsRef.current['station-series']
      delete warningBucketsRef.current['qc:station']
      delete warningBucketsRef.current['qc:merged']
      delete warningBucketsRef.current.exports
      completionVersionsRef.current = {}
    } else if (stage === 'station-series') {
      next = {
        ...current,
        stationQcResult: null,
        mergedQcResult: null,
        exportArtifactsByMode: { station: null, merged: null },
        ionWorkbook: null,
        ionRows: [],
        mergeResult: null,
        userMergeResult: null,
      }
      delete warningBucketsRef.current['qc:station']
      delete warningBucketsRef.current['qc:merged']
      delete warningBucketsRef.current.exports
      delete completionVersionsRef.current['station-series']
      delete completionVersionsRef.current['quality-control:station']
      delete completionVersionsRef.current['quality-control:merged']
      delete completionVersionsRef.current['exports:station']
      delete completionVersionsRef.current['exports:merged']
    } else if (stage === 'quality-control') {
      const mode = qcMode ?? 'station'
      next = {
        ...current,
        ...(mode === 'merged'
          ? { mergedQcResult: null, userMergeResult: null }
          : { stationQcResult: null }),
        exportArtifactsByMode: { ...current.exportArtifactsByMode, [mode]: null },
      }
      delete warningBucketsRef.current[`qc:${mode}`]
      delete warningBucketsRef.current.exports
      delete completionVersionsRef.current[`quality-control:${mode}`]
      delete completionVersionsRef.current[`exports:${mode}`]
    } else {
      next = qcMode === null || qcMode === undefined
        ? current
        : { ...current, exportArtifactsByMode: { ...current.exportArtifactsByMode, [qcMode]: null } }
      delete warningBucketsRef.current.exports
      if (qcMode !== null && qcMode !== undefined) delete completionVersionsRef.current[`exports:${qcMode}`]
    }
    publishResults(next)
    publishWarnings()
  }, [publishResults, publishWarnings])

  const clearSourceAndDownstream = useCallback(() => {
    const next = { ...EMPTY_RESULTS }
    warningBucketsRef.current = {}
    completionVersionsRef.current = {}
    publishResults(next)
    publishWarnings()
    publishSourceStatus('empty')
    publishProgress(null)
    setProgress(0)
  }, [publishProgress, publishResults, publishSourceStatus, publishWarnings])

  const begin = useCallback((
    stage: PipelineStage,
    invalidate = true,
    qcMode?: QcMode | null,
    kind: ActiveRun['kind'] = 'step',
  ) => {
    const id = supersede()
    const controller = new AbortController()
    controllerRef.current = controller
    activeRunRef.current = { id, stage, mode: qcMode ?? null, kind }
    if (invalidate) clearDownstream(stage, qcMode)
    activeStepRef.current = stage
    setActiveStepState(stage)
    publishStatus('running')
    setError(null)
    setMessage(messageFor(stage, true))
    return { id, controller }
  }, [clearDownstream, publishStatus, supersede])

  const fail = useCallback((stage: PipelineStage, cause: unknown, id: number, source = false) => {
    if (!isCurrent(id)) return
    activeRunRef.current = null
    const detail = sanitizeLogText(errorText(cause)) || '未知错误'
    const text = cause instanceof PipelinePrerequisiteError
      ? detail
      : `${source ? '数据来源' : `步骤“${stage}”`}失败：${detail}`
    if (source) publishSourceStatus('error')
    publishStatus('error')
    setMessage(text)
    setError(text)
  }, [isCurrent, publishSourceStatus, publishStatus])

  const finish = useCallback((stage: PipelineStage, id: number) => {
    if (!isCurrent(id)) return false
    activeRunRef.current = null
    publishStatus('complete')
    setMessage(messageFor(stage, false))
    setProgress(((PIPELINE_STEPS.indexOf(stage) + 1) / PIPELINE_STEPS.length) * 100)
    controllerRef.current = null
    return true
  }, [isCurrent, publishStatus])

  const publishSourceFiles = useCallback((files: ParsedStationFile[], id: number) => {
    if (!isCurrent(id)) return false
    const safeFiles = sanitizeParsedFiles(files)
    publishResults({ ...resultsRef.current, parsedStationFiles: safeFiles })
    warningBucketsRef.current['data-source'] = safeFiles.flatMap((file) => file.warnings)
    publishWarnings()
    publishSourceStatus('ready')
    return true
  }, [isCurrent, publishResults, publishSourceStatus, publishWarnings])

  const parseLocalFiles = useCallback(async (files: File[], stationId: string) => {
    const id = supersede()
    const controller = new AbortController()
    controllerRef.current = controller
    clearDownstream('data-source')
    publishResults({ ...resultsRef.current, parsedStationFiles: [] })
    publishSourceStatus('parsing')
    publishStatus('running')
    publishProgress(null)
    setError(null)
    setMessage(messageFor('data-source', true))
    if (!stationId.trim()) {
      fail('data-source', new PipelinePrerequisiteError('站点编号不能为空'), id, true)
      return
    }
    if (!services.parseStationInputs) {
      fail('data-source', new Error('当前版本尚未提供本地站点文件解析服务'), id, true)
      return
    }
    try {
      const parsed = await services.parseStationInputs(files, stationId.trim(), controller.signal)
      if (!publishSourceFiles(parsed, id)) return
      completionVersionsRef.current['data-source'] = version
      finish('data-source', id)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      fail('data-source', cause, id, true)
    } finally {
      if (isCurrent(id)) controllerRef.current = null
    }
  }, [clearDownstream, fail, finish, isCurrent, publishProgress, publishResults, publishSourceFiles, publishSourceStatus, publishStatus, services, supersede, version])

  const setSourceMode = useCallback((value: DataSourceMode) => {
    const current = inputsRef.current
    if (current.sourceMode === value) return
    const userParsing = userControllerRef.current !== null
    supersede()
    supersedeUser()
    const next = { ...current, sourceMode: value }
    inputsRef.current = next
    setInputs(next)
    clearSourceAndDownstream()
    publishStatus('idle')
    setMessage('')
    setError(null)
    if (userParsing) {
      setUserDataStatus('empty')
      setUserDataError(null)
    }
    if (value === 'local-import' && next.stationFiles.length > 0) {
      void parseLocalFiles(next.stationFiles, next.stationId)
    }
  }, [clearSourceAndDownstream, parseLocalFiles, publishStatus, supersede, supersedeUser])

  const setStationFiles = useCallback((value: File[]) => {
    supersede()
    const files = [...value]
    const next = { ...inputsRef.current, stationFiles: files, sourceMode: 'local-import' as const }
    inputsRef.current = next
    setInputs(next)
    clearSourceAndDownstream()
    setMessage('')
    setError(null)
    if (files.length === 0) {
      publishStatus('idle')
      return
    }
    void parseLocalFiles(files, next.stationId)
  }, [clearSourceAndDownstream, parseLocalFiles, publishStatus, supersede])

  const updateSimpleInput = useCallback(<K extends 'startDate' | 'endDate'>(key: K, value: string) => {
    const next = { ...inputsRef.current, [key]: value }
    inputsRef.current = next
    setInputs(next)
    if (next.sourceMode === 'online-links' || next.sourceMode === 'online-station') {
      supersede()
      clearSourceAndDownstream()
      publishStatus('idle')
      setMessage('')
      setError(null)
    }
  }, [clearSourceAndDownstream, publishStatus, supersede])

  const setStationId = useCallback((value: string) => {
    const next = { ...inputsRef.current, stationId: value }
    inputsRef.current = next
    setInputs(next)
    supersede()
    clearSourceAndDownstream()
    setMessage('')
    setError(null)
    if (next.sourceMode === 'local-import' && next.stationFiles.length > 0) {
      void parseLocalFiles(next.stationFiles, value)
    } else {
      publishStatus('idle')
    }
  }, [clearSourceAndDownstream, parseLocalFiles, publishStatus, supersede])

  const executeOnlineStation = useCallback(async (
    run: { id: number; controller: AbortController },
    current: Inputs,
  ) => {
    publishSourceStatus('parsing')
    publishProgress({ completed: 0, total: 0, failed: 0 })
    assertDates(current.startDate, current.endDate)
    if (!current.stationId.trim()) throw new PipelinePrerequisiteError('站点编号不能为空')
    if (!endpoint) throw new PipelinePrerequisiteError('未配置在线站点数据服务地址')
    if (!services.downloadStationRange) throw new Error('当前版本尚未提供在线站点下载服务')
    const value = await services.downloadStationRange({
      startDate: current.startDate,
      endDate: current.endDate,
      stationId: current.stationId.trim(),
      endpoint,
      signal: run.controller.signal,
      onProgress: (next) => {
        if (isCurrent(run.id)) publishProgress({ ...next })
      },
    })
    if (!isCurrent(run.id)) return false
    const parsed: ParsedStationFile[] = [{
      filename: safeFilename(value.filename),
      rows: value.rows.map((row) => ({ ...row })),
      warnings: value.warnings.map((warning) => sanitizeLogText(warning)),
    }]
    if (!publishSourceFiles(parsed, run.id)) return false
    if (download) download(new Blob([value.csvText], { type: 'text/csv;charset=utf-8' }), parsed[0].filename)
    return true
  }, [download, endpoint, isCurrent, publishProgress, publishSourceFiles, publishSourceStatus, services])

  const downloadAndUseStationData = useCallback(async () => {
    if (inputsRef.current.sourceMode !== 'online-station') {
      const next = { ...inputsRef.current, sourceMode: 'online-station' as const, stationFiles: [] }
      inputsRef.current = next
      setInputs(next)
      clearSourceAndDownstream()
    }
    const run = begin('data-source')
    try {
      const completed = await executeOnlineStation(run, inputsRef.current)
      if (completed) {
        completionVersionsRef.current['data-source'] = version
        finish('data-source', run.id)
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError' && !isCurrent(run.id)) return
      fail('data-source', cause, run.id, true)
    } finally {
      if (isCurrent(run.id)) controllerRef.current = null
    }
  }, [begin, clearSourceAndDownstream, executeOnlineStation, fail, finish, isCurrent, version])

  const canRun = useCallback((step: PipelineStep): boolean => {
    if (!isPipelineStage(step)) return false
    const current = inputsRef.current
    const currentResults = resultsRef.current
    if (step === 'data-source') {
      if (current.sourceMode === 'local-import') return current.stationFiles.length > 0 && sourceStatusRef.current !== 'parsing'
      if (current.sourceMode === 'online-links') return validDownloadRange(current.startDate, current.endDate)
      if (current.sourceMode === 'online-station') {
        return validDownloadRange(current.startDate, current.endDate)
          && STATION_ID_PATTERN.test(current.stationId.trim())
          && typeof endpoint === 'string' && isSafeStationEndpoint(endpoint)
      }
      return false
    }
    if (step === 'station-series') return sourceStatusRef.current === 'ready' && currentResults.parsedStationFiles.length > 0
    if (step === 'quality-control') {
      if (currentResults.stationSeries === null) return false
      return current.qcMode !== 'merged'
        || (parsedUserDatasetRef.current !== null && parsedUserDatasetRef.current.mappingRequired === undefined)
    }
    if (current.qcMode === 'station') return currentResults.stationQcResult !== null
    if (current.qcMode === 'merged') return currentResults.mergedQcResult !== null
    return false
  }, [endpoint])

  const isStageComplete = useCallback((stage: PipelineStage, mode: QcMode | null): boolean => {
    const key = completionKey(stage, mode)
    if (!key || completionVersionsRef.current[key] !== version) return false
    const current = resultsRef.current
    if (stage === 'data-source') {
      return inputsRef.current.sourceMode === 'online-links'
        ? current.downloadLinks.length > 0
        : sourceStatusRef.current === 'ready' && current.parsedStationFiles.length > 0
    }
    if (stage === 'station-series') return current.stationSeries !== null
    if (mode === null) return false
    if (stage === 'quality-control') {
      return mode === 'station' ? current.stationQcResult !== null : current.mergedQcResult !== null
    }
    return current.exportArtifactsByMode[mode] !== null
  }, [version])

  const guidanceFor = useCallback((step: PipelineStage): string => {
    if (step === 'quality-control' && resultsRef.current.stationSeries !== null) {
      if (inputsRef.current.qcMode === 'merged' && (!parsedUserDatasetRef.current || parsedUserDatasetRef.current.mappingRequired)) {
        return '\u8bf7\u5148\u5bfc\u5165\u5e76\u5b8c\u6210\u7528\u6237\u6570\u636e\u5b57\u6bb5\u6620\u5c04'
      }
      return '\u8bf7\u5148\u9009\u62e9\u8d28\u63a7\u6a21\u5f0f'
    }
    if (step === 'station-series') return '请先获取或导入站点数据'
    if (step === 'quality-control') return '请先获取或导入站点数据，并构建逐时序列'
    if (step === 'exports') {
      if (inputsRef.current.qcMode === null) return '请先选择质控模式'
      return inputsRef.current.qcMode === 'station'
        ? '请先完成“站点数据质控”'
        : '请先完成“用户数据合并质控”'
    }
    const mode = inputsRef.current.sourceMode
    if (mode === null) return '请先选择在线获取或本地导入'
    if (mode === 'local-import') return '请先选择站点 CSV 文件'
    return '请先填写有效的日期范围'
  }, [])

  const executeStage = useCallback(async (
    stage: PipelineStage,
    run: { id: number; controller: AbortController },
    mode: QcMode | null,
  ): Promise<boolean> => {
    if (!isCurrent(run.id)) return false
    const active = activeRunRef.current
    activeRunRef.current = {
      id: run.id,
      stage,
      mode,
      kind: active?.id === run.id ? active.kind : 'step',
    }
    activeStepRef.current = stage
    setActiveStepState(stage)
    setMessage(messageFor(stage, true))
    if (!canRun(stage)) throw new PipelinePrerequisiteError(guidanceFor(stage))
    const current = inputsRef.current

    if (stage === 'data-source') {
      if (current.sourceMode === 'online-links') {
        assertDates(current.startDate, current.endDate)
        const links = services.buildDownloadLinks(current.startDate, current.endDate)
        if (!isCurrent(run.id)) return false
        publishResults({ ...resultsRef.current, downloadLinks: links })
        publishSourceStatus('empty')
      } else if (current.sourceMode === 'online-station') {
        if (!await executeOnlineStation(run, current)) return false
      } else {
        if (!services.parseStationInputs) throw new Error('当前版本尚未提供本地站点文件解析服务')
        publishSourceStatus('parsing')
        const parsed = await services.parseStationInputs(current.stationFiles, current.stationId.trim(), run.controller.signal)
        if (!publishSourceFiles(parsed, run.id)) return false
      }
    } else if (stage === 'station-series') {
      const rows = resultsRef.current.parsedStationFiles.flatMap((file) => file.rows)
      const value = services.buildHourlySeries(rows)
      if (!isCurrent(run.id)) return false
      publishResults({ ...resultsRef.current, stationSeries: value })
      warningBucketsRef.current['station-series'] = value.warnings
      publishWarnings()
    } else if (stage === 'quality-control') {
      if (mode === null) throw new PipelinePrerequisiteError('请先选择质控模式')
      let value: QualityControlResult | DynamicQualityControlResult
      let userMergeResult: UserHourlyMergeResult | null = null
      if (mode === 'merged') {
        const userDataset = parsedUserDatasetRef.current
        if (!userDataset || userDataset.mappingRequired) {
          throw new PipelinePrerequisiteError('\u8bf7\u5148\u5bfc\u5165\u5e76\u5b8c\u6210\u7528\u6237\u6570\u636e\u5b57\u6bb5\u6620\u5c04')
        }
        userMergeResult = mergeUserHourly(resultsRef.current.stationSeries!.rows, userDataset)
        if (run.controller.signal.aborted) return false
        const dynamicResult = qualityControlDynamic(userMergeResult.rows, userMergeResult.variables)
        value = dynamicResult
        warningBucketsRef.current['qc:merged'] = [
          ...userDataset.warnings,
          ...userMergeResult.warnings,
          ...dynamicResult.warnings,
        ]
        publishWarnings()
      } else {
        if (!services.runQcMode) throw new PipelinePrerequisiteError(unsupportedQcMessage(mode))
        value = await services.runQcMode(mode, {
          stationRows: resultsRef.current.stationSeries!.rows,
          ionFile: current.ionFile,
          signal: run.controller.signal,
        })
      }
      if (!isCurrent(run.id)) return false
      publishResults({
        ...resultsRef.current,
        ...(mode === 'station'
          ? { stationQcResult: value as QualityControlResult }
          : { mergedQcResult: value as DynamicQualityControlResult, userMergeResult }),
      })
    } else {
      if (mode === null) throw new PipelinePrerequisiteError('请先选择质控模式')
      const qcResult = mode === 'merged'
        ? resultsRef.current.mergedQcResult
        : resultsRef.current.stationQcResult
      if (!qcResult) throw new PipelinePrerequisiteError(
        mode === 'station' ? '请先完成“站点数据质控”' : '请先完成“用户数据合并质控”',
      )
      if (!services.createExportArtifacts) throw new PipelinePrerequisiteError('当前版本尚未提供结果导出服务')
      const allWarnings = Object.values(warningBucketsRef.current).flatMap((items) => items ?? [])
      const metadata = sanitizeQcWorkbookMetadata({
        processingTime: now().toISOString(),
        stationId: current.stationId.trim(),
        inputFiles: current.stationFiles.map((file) => safeFilename(file.name)),
        inputCounts: {
          startDate: current.startDate,
          endDate: current.endDate,
          stationFiles: current.stationFiles.length,
        },
        rowCounts: {
          parsedStationRows: resultsRef.current.parsedStationFiles.reduce((total, file) => total + file.rows.length, 0),
          stationRows: resultsRef.current.stationSeries?.rows.length ?? 0,
          qcRows: qcResult.rows.length,
        },
        warnings: allWarnings.map((warning) => sanitizeLogText(warning)).slice(0, warningLimit),
        version,
        logicNotes: ['上一步结果直接进入下一阶段；所有处理保留可审计警告。'],
      })
      const value = await services.createExportArtifacts({
        mode,
        stationRows: resultsRef.current.stationSeries!.rows,
        qcResult: qcResult as QualityControlResult,
        metadata,
        startDate: current.startDate || resultsRef.current.stationSeries!.rows[0]?.timestamp.slice(0, 10) || '1970-01-01',
        endDate: current.endDate || resultsRef.current.stationSeries!.rows.at(-1)?.timestamp.slice(0, 10) || '1970-01-01',
        signal: run.controller.signal,
        parsedUserDataset: parsedUserDatasetRef.current,
        userMergeResult: resultsRef.current.userMergeResult,
      })
      if (!isCurrent(run.id)) return false
      publishResults({
        ...resultsRef.current,
        exportArtifactsByMode: { ...resultsRef.current.exportArtifactsByMode, [mode]: value },
      })
    }
    if (!isCurrent(run.id)) return false
    const key = completionKey(stage, mode)
    if (key) completionVersionsRef.current[key] = version
    setProgress(((PIPELINE_STEPS.indexOf(stage) + 1) / PIPELINE_STEPS.length) * 100)
    setMessage(messageFor(stage, false))
    return true
  }, [canRun, executeOnlineStation, guidanceFor, isCurrent, now, publishResults, publishSourceFiles, publishSourceStatus, publishWarnings, services, version, warningLimit])

  const runQcMode = useCallback(async (mode: QcMode) => {
    const nextInputs = { ...inputsRef.current, qcMode: mode }
    inputsRef.current = nextInputs
    setInputs(nextInputs)
    const run = begin('quality-control', true, mode)
    try {
      const completed = await executeStage('quality-control', run, mode)
      if (completed) finish('quality-control', run.id)
    } catch (cause) {
      fail('quality-control', cause, run.id)
    } finally {
      if (isCurrent(run.id)) controllerRef.current = null
    }
  }, [begin, executeStage, fail, finish, isCurrent])

  const runStep = useCallback(async (step: PipelineStep) => {
    if (!isPipelineStage(step)) {
      const text = `未知处理阶段：${sanitizeLogText(step)}`
      publishStatus('error')
      setMessage(text)
      setError(text)
      return
    }
    if (step === 'data-source' && inputsRef.current.sourceMode === 'online-station') {
      await downloadAndUseStationData()
      return
    }
    if (step === 'quality-control') {
      const mode = inputsRef.current.qcMode
      if (mode !== null) {
        await runQcMode(mode)
        return
      }
      const run = begin(step, false)
      try {
        const completed = await executeStage(step, run, null)
        if (completed) finish(step, run.id)
      } catch (cause) {
        fail(step, cause, run.id)
      } finally {
        if (isCurrent(run.id)) controllerRef.current = null
      }
      return
    }
    const run = begin(step, true, inputsRef.current.qcMode)
    try {
      const completed = await executeStage(step, run, inputsRef.current.qcMode)
      if (completed) finish(step, run.id)
    } catch (cause) {
      fail(step, cause, run.id, step === 'data-source')
    } finally {
      if (isCurrent(run.id)) controllerRef.current = null
    }
  }, [begin, downloadAndUseStationData, executeStage, fail, finish, isCurrent, publishStatus, runQcMode])

  const runAll = useCallback(async () => {
    const startIndex = PIPELINE_STEPS.indexOf(activeStepRef.current)
    const runMode = inputsRef.current.qcMode
    const run = begin(activeStepRef.current, false, runMode, 'run-all')
    let stage = activeStepRef.current
    let started = false
    try {
      for (let index = startIndex; index < PIPELINE_STEPS.length; index += 1) {
        stage = PIPELINE_STEPS[index]
        const mode = runMode
        if (!started && isStageComplete(stage, mode)) continue
        started = true
        clearDownstream(stage, mode)
        const completed = await executeStage(stage, run, mode)
        if (!completed) return
      }
      if (isCurrent(run.id)) {
        activeRunRef.current = null
        publishStatus('complete')
        setMessage('全部处理完成')
        setProgress(100)
      }
    } catch (cause) {
      fail(stage, cause, run.id, stage === 'data-source')
    } finally {
      if (isCurrent(run.id)) controllerRef.current = null
    }
  }, [begin, clearDownstream, executeStage, fail, isCurrent, isStageComplete, publishStatus])

  const setActiveStep = useCallback((value: PipelineStep) => {
    if (!isPipelineStage(value)) return
    activeStepRef.current = value
    setActiveStepState(value)
    setError(null)
    setMessage(canRun(value) ? '' : guidanceFor(value))
  }, [canRun, guidanceFor])

  const setParsedUserDataset = useCallback((value: ParsedUserDataset | null) => {
    supersedeMergedRun()
    supersedeUser()
    clearDownstream('quality-control', 'merged')
    const safe = value === null ? null : cloneParsedUserDataset(value)
    parsedUserDatasetRef.current = safe
    setParsedUserDatasetState(safe)
    setUserDataStatus(safe === null ? 'empty' : safe.mappingRequired ? 'mapping-required' : 'ready')
    setUserDataError(null)
    warningBucketsRef.current['user-data'] = safe?.warnings ?? []
    publishWarnings()
  }, [clearDownstream, publishWarnings, supersedeMergedRun, supersedeUser])

  const setUserDataFile = useCallback((value: File | null, mapping?: UserDataMapping) => {
    supersedeMergedRun()
    const id = supersedeUser()
    const nextInputs = { ...inputsRef.current, userDataFile: value }
    inputsRef.current = nextInputs
    setInputs(nextInputs)
    clearDownstream('quality-control', 'merged')
    parsedUserDatasetRef.current = null
    setParsedUserDatasetState(null)
    setUserDataError(null)
    warningBucketsRef.current['user-data'] = []
    publishWarnings()
    if (value === null) {
      setUserDataStatus('empty')
      return
    }
    const controller = new AbortController()
    userControllerRef.current = controller
    setUserDataStatus('parsing')
    const parser = services.parseUserDataFile ?? parseUserDataFileDefault
    void parser(value, mapping, controller.signal).then((parsed) => {
      if (!mountedRef.current || userRunIdRef.current !== id) return
      const safe = cloneParsedUserDataset(parsed)
      parsedUserDatasetRef.current = safe
      setParsedUserDatasetState(safe)
      setUserDataStatus(safe.mappingRequired ? 'mapping-required' : 'ready')
      warningBucketsRef.current['user-data'] = safe.warnings
      publishWarnings()
      userControllerRef.current = null
    }, (cause: unknown) => {
      if (!mountedRef.current || userRunIdRef.current !== id || (cause instanceof DOMException && cause.name === 'AbortError')) return
      const detail = sanitizeLogText(errorText(cause)) || 'User data parsing failed.'
      setUserDataStatus('error')
      setUserDataError(detail)
      userControllerRef.current = null
    })
  }, [clearDownstream, publishWarnings, services, supersedeMergedRun, supersedeUser])

  const setQcMode = useCallback((value: QcMode | null) => {
    const current = inputsRef.current
    if (value !== current.qcMode) {
      const active = activeRunRef.current
      if (active && (active.kind === 'run-all' || active.stage === 'quality-control' || active.stage === 'exports')) {
        supersede()
        publishStatus('idle')
      }
    }
    const next = { ...current, qcMode: value }
    inputsRef.current = next
    setInputs(next)
  }, [publishStatus, supersede])

  const cancel = useCallback(() => {
    const userParsing = userControllerRef.current !== null
    if (statusRef.current !== 'running' && sourceStatusRef.current !== 'parsing' && !userParsing) return
    supersede()
    supersedeUser()
    publishStatus('cancelled')
    if (sourceStatusRef.current === 'parsing') publishSourceStatus('empty')
    if (userParsing) setUserDataStatus('empty')
    setMessage('处理已取消，可以修改输入后重试')
    setError(null)
  }, [publishSourceStatus, publishStatus, supersede, supersedeUser])

  const resetResults = useCallback(() => {
    supersede()
    clearSourceAndDownstream()
    publishStatus('idle')
    activeStepRef.current = 'data-source'
    setActiveStepState('data-source')
    setMessage('')
    setError(null)
  }, [clearSourceAndDownstream, publishStatus, supersede])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runIdRef.current += 1
      controllerRef.current?.abort()
      controllerRef.current = null
      activeRunRef.current = null
      userRunIdRef.current += 1
      userControllerRef.current?.abort()
      userControllerRef.current = null
    }
  }, [])

  const selectedQc = inputs.qcMode === 'station'
    ? results.stationQcResult
    : inputs.qcMode === 'merged' ? results.mergedQcResult : null
  const selectedExport = inputs.qcMode === null ? null : results.exportArtifactsByMode[inputs.qcMode]

  return {
    ...inputs,
    ...results,
    userDataStatus,
    userDataError,
    parsedUserDataset,
    userMappingRequired: parsedUserDataset?.mappingRequired ?? null,
    sourceStatus,
    downloadProgress,
    activeStep,
    status,
    progress,
    message,
    error,
    warnings,
    stationSeriesResult: results.stationSeries,
    stationRows: results.stationSeries?.rows ?? [],
    qcResult: selectedQc,
    exportArtifacts: selectedExport,
    setStartDate: (value) => updateSimpleInput('startDate', value),
    setEndDate: (value) => updateSimpleInput('endDate', value),
    setStationId,
    setSourceMode,
    setStationFiles,
    setIonFile: (value) => {
      const next = { ...inputsRef.current, ionFile: value }
      inputsRef.current = next
      setInputs(next)
      clearDownstream('quality-control', 'merged')
    },
    setUserDataFile,
    setParsedUserDataset,
    setQcMode,
    setActiveStep,
    downloadAndUseStationData,
    runQcMode,
    canRun,
    runStep,
    runAll,
    cancel,
    resetResults,
  }
}
