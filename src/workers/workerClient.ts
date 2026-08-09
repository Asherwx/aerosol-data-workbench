import { POLLUTANTS } from '../core/types'
import type { ParsedStationFile } from '../core/stationCsv'
import type {
  StationCsvWorkerRequest,
  StationCsvWorkerResponse,
} from './stationCsv.worker'
import {
  assertStationFileSize,
  detectStationFileKind,
  MAX_NATIONAL_DAILY_FILE_BYTES,
  MAX_STATION_INPUT_BATCH_BYTES,
  MAX_STATION_INPUT_FILES,
  type StationFileKind,
} from '../core/stationFileDetection'
import { assertCanonicalStationId } from '../core/types'

export const DEFAULT_STATION_CSV_CONCURRENCY = 3
export const MAX_STATION_CSV_CONCURRENCY = 4
export const MAX_STATION_CSV_FILE_BYTES = MAX_NATIONAL_DAILY_FILE_BYTES

type WorkerTask = {
  promise: Promise<ParsedStationFile>
  cancel: () => void
}

function abortError(): DOMException {
  return new DOMException('已取消解析国控站 CSV 文件', 'AbortError')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isParsedStationFile(value: unknown): value is ParsedStationFile {
  if (
    !isObject(value) ||
    typeof value.filename !== 'string' ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === 'string')
  ) {
    return false
  }

  return value.rows.every((row) => {
    if (!isObject(row) || typeof row.timestamp !== 'string') return false
    return POLLUTANTS.every(
      (pollutant) =>
        row[pollutant] === undefined ||
        (typeof row[pollutant] === 'number' && Number.isFinite(row[pollutant])),
    )
  })
}

function isWorkerResponse(value: unknown): value is StationCsvWorkerResponse {
  if (!isObject(value) || typeof value.ok !== 'boolean') return false
  return value.ok
    ? isParsedStationFile(value.result)
    : typeof value.error === 'string'
}

function toError(error: unknown): Error {
  return error instanceof Error || error instanceof DOMException
    ? error
    : new Error(String(error))
}

function createStationWorkerTask(
  file: File,
  station: string,
  signal?: AbortSignal,
  kind: StationFileKind = 'national-daily',
  identityPolicy: 'strict' | 'legacy' = 'legacy',
): WorkerTask {
  try {
    assertStationFileSize(file, kind)
  } catch (error) {
    return { promise: Promise.reject(toError(error)), cancel: () => undefined }
  }
  if (signal?.aborted) {
    return { promise: Promise.reject(abortError()), cancel: () => undefined }
  }
  let cancel = () => {}

  const promise = new Promise<ParsedStationFile>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./stationCsv.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch (error) {
      reject(toError(error))
      return
    }

    let settled = false

    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      settle()
    }

    const fail = (error: unknown): void => finish(() => reject(toError(error)))

    const onAbort = () => fail(abortError())
    cancel = onAbort

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const response = event.data
      if (!isWorkerResponse(response)) {
        fail(new Error('工作线程返回格式无效'))
        return
      }

      if (response.ok) {
        finish(() => resolve(response.result))
      } else {
        fail(new Error(response.error))
      }
    }

    worker.onerror = (event: ErrorEvent) => {
      fail(new Error(event.message || '站点 CSV 工作线程失败'))
    }

    worker.onmessageerror = () => {
      fail(new Error('工作线程消息无法解析'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    const request: StationCsvWorkerRequest = kind === 'station-wide'
      ? { kind, identityPolicy: 'strict', file, stationId: station }
      : { kind, identityPolicy, file, stationId: station }
    try {
      worker.postMessage(request)
    } catch (error) {
      fail(error)
    }
  })

  return { promise, cancel: () => cancel() }
}

const STATION_FILE_PREVIEW_BYTES = 64 * 1024

function readPreview(file: File): Promise<string> {
  const blob = file.slice(0, STATION_FILE_PREVIEW_BYTES)
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('无法读取文件预览'))
    reader.readAsText(blob)
  })
}

async function detectInputKinds(files: readonly File[], signal?: AbortSignal): Promise<StationFileKind[]> {
  const kinds: StationFileKind[] = []
  for (const file of files) {
    if (signal?.aborted) throw abortError()
    const preview = await readPreview(file)
    if (signal?.aborted) throw abortError()
    kinds.push(detectStationFileKind(preview, file.name).kind)
  }
  return kinds
}

export async function parseStationInputs(
  files: readonly File[],
  stationId: string,
  signal?: AbortSignal,
): Promise<ParsedStationFile[]> {
  if (signal?.aborted) throw abortError()
  assertCanonicalStationId(stationId)
  const inputFiles = [...files]
  if (inputFiles.length === 0) return []
  if (inputFiles.length > MAX_STATION_INPUT_FILES) throw new Error(`一次最多导入 ${MAX_STATION_INPUT_FILES} 个文件`)
  const totalBytes = inputFiles.reduce((total, file) => total + file.size, 0)
  if (totalBytes > MAX_STATION_INPUT_BATCH_BYTES) throw new Error('导入文件总大小超过 32 MiB 限制')
  for (const file of inputFiles) assertStationFileSize(file, 'national-daily')
  const kinds = await detectInputKinds(inputFiles, signal)
  for (const [index, kind] of kinds.entries()) assertStationFileSize(inputFiles[index], kind)
  const hasWide = kinds.includes('station-wide')
  if (hasWide && kinds.length > 1) {
    throw new Error('不能混合导入国控日文件和站点宽表；站点宽表一次只能导入一个文件。')
  }
  if (hasWide) return [await createStationWorkerTask(inputFiles[0], stationId, signal, 'station-wide', 'strict').promise]
  return parseStationFiles(inputFiles, stationId, DEFAULT_STATION_CSV_CONCURRENCY, signal, 'strict')
}

export function parseStationFile(
  file: File,
  station: string,
  signal?: AbortSignal,
): Promise<ParsedStationFile> {
  return createStationWorkerTask(file, station, signal).promise
}

export function parseStationFiles(
  files: readonly File[],
  station: string,
  signal?: AbortSignal,
): Promise<ParsedStationFile[]>
export function parseStationFiles(
  files: readonly File[],
  station: string,
  concurrency?: number,
  signal?: AbortSignal,
  identityPolicy?: 'strict' | 'legacy',
): Promise<ParsedStationFile[]>
export function parseStationFiles(
  files: readonly File[],
  station: string,
  concurrencyOrSignal: number | AbortSignal = DEFAULT_STATION_CSV_CONCURRENCY,
  explicitSignal?: AbortSignal,
  identityPolicy: 'strict' | 'legacy' = 'legacy',
): Promise<ParsedStationFile[]> {
  const concurrency = typeof concurrencyOrSignal === 'number'
    ? concurrencyOrSignal
    : DEFAULT_STATION_CSV_CONCURRENCY
  const signal = typeof concurrencyOrSignal === 'number' ? explicitSignal : concurrencyOrSignal
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_STATION_CSV_CONCURRENCY
  ) {
    throw new Error(
      `并发数必须是 1 到 ${MAX_STATION_CSV_CONCURRENCY} 之间的整数`,
    )
  }

  const inputFiles = [...files]
  for (const file of inputFiles) {
    if (file.size > MAX_NATIONAL_DAILY_FILE_BYTES) return Promise.reject(new Error(`${file.name} 大小超过 8 MiB 限制`))
  }
  if (signal?.aborted) return Promise.reject(abortError())
  if (inputFiles.length === 0) return Promise.resolve([])

  return new Promise((resolve, reject) => {
    const results = new Array<ParsedStationFile>(inputFiles.length)
    const activeTasks = new Set<WorkerTask>()
    let nextIndex = 0
    let completed = 0
    let settled = false

    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const cancelActive = (): void => {
      for (const activeTask of activeTasks) activeTask.cancel()
    }
    const onAbort = (): void => finish(() => {
      cancelActive()
      reject(abortError())
    })

    const launch = (): void => {
      while (
        !settled &&
        activeTasks.size < concurrency &&
        nextIndex < inputFiles.length
      ) {
        const index = nextIndex
        nextIndex += 1
        const task = createStationWorkerTask(inputFiles[index], station, undefined, 'national-daily', identityPolicy)
        activeTasks.add(task)

        task.promise.then(
          (result) => {
            activeTasks.delete(task)
            if (settled) return

            results[index] = result
            completed += 1
            if (completed === inputFiles.length) {
              finish(() => resolve(results))
            } else {
              launch()
            }
          },
          (error: unknown) => {
            activeTasks.delete(task)
            if (settled) return

            finish(() => {
              cancelActive()
              reject(toError(error))
            })
          },
        )
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else launch()
  })
}
