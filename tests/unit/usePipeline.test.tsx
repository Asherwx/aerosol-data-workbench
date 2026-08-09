import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, type PropsWithChildren } from 'react'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { ResultArtifacts } from '../../src/core/exports'
import type { QualityControlResult } from '../../src/core/qualityControl'
import type { ParsedStationFile } from '../../src/core/stationCsv'
import type { HourlySeriesResult } from '../../src/core/stationSeries'
import type { ParsedUserDataset, UserDataMapping } from '../../src/core/userDataset'
import type { DownloadedStationRange, HourlyStationRow } from '../../src/core/types'
import { downloadStationRange } from '../../src/core/onlineStationDownload'
import { defaultStationEndpoint } from '../../src/pipeline/defaultPipelineServices'
import { parseStationInputs } from '../../src/workers/workerClient'
import {
  PIPELINE_STEPS,
  defaultPipelineServices,
  type PipelineStep,
  type PipelineServices,
  usePipeline,
} from '../../src/pipeline/usePipeline'

function StrictWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>
}

const sourceRows: HourlyStationRow[] = [
  { timestamp: '2024-11-01 00:00:00', SO2: 1 },
]
const parsedFiles: ParsedStationFile[] = [{
  filename: 'china_sites_20241101.csv',
  rows: sourceRows,
  warnings: ['local warning'],
}]
const stationSeries: HourlySeriesResult = {
  rows: [{
    timestamp: '2024-11-01 00:00:00',
    SO2: 1,
    missing: ['NO2', 'O3', 'CO', 'PM10', 'PM2.5'],
    status: '存在缺测',
  }],
  duplicateTimes: [],
  warnings: ['series warning'],
}
const qcResult: QualityControlResult = {
  rows: [],
  counts: { 正常: 0 },
  keptRows: [],
  rejectedRows: [],
}
const artifacts = {
  stationCsv: { name: 'station.csv', content: 'station' },
  mergedCsv: { name: 'merged.csv', content: 'merged' },
  qcWorkbook: { name: 'qc.xlsx', content: new Blob(['xlsx']) },
  processingLog: { name: 'log.json', content: '{}' },
  zip: { name: 'results.zip', content: new Blob(['zip']) },
} satisfies ResultArtifacts
const mergedArtifacts = {
  ...artifacts,
  zip: { name: 'merged-results.zip', content: new Blob(['merged zip']) },
} satisfies ResultArtifacts
const downloaded: DownloadedStationRange = {
  filename: '3329A_20241101_20241101.csv',
  csvText: 'station csv',
  rows: sourceRows,
  allRows: [{ timestamp: sourceRows[0].timestamp, values: { SO2: 1 } }],
  failedDates: [],
  warnings: ['online warning'],
  warningTotal: 1,
}
const userDataset: ParsedUserDataset = {
  rows: [{ timestamp: '2024-11-01 00:00:00', values: { dust: 2 } }],
  variables: [{ key: 'dust', label: 'Dust', unit: 'ug/m3', nonNegative: true, sourceColumn: 1 }],
  mapping: {
    timestampColumn: 0,
    variables: [{ key: 'dust', label: 'Dust', unit: 'ug/m3', nonNegative: true, sourceColumn: 1 }],
  },
  warnings: ['user warning'], warningTotal: 1, sheetName: 'Data',
}

function services(overrides: Partial<PipelineServices> = {}): PipelineServices {
  return {
    buildDownloadLinks: vi.fn(() => [{ date: '2024-11-01', filename: 'china_sites_20241101.csv', url: 'https://example.test/file' }]),
    downloadStationRange: vi.fn(async () => downloaded),
    parseStationInputs: vi.fn(async () => parsedFiles),
    buildHourlySeries: vi.fn(() => stationSeries),
    runQcMode: vi.fn(async () => qcResult),
    createExportArtifacts: vi.fn(async () => artifacts),
    ...overrides,
  }
}

async function configureOnlineStation(result: ReturnType<typeof usePipeline>) {
  act(() => {
    result.setStartDate('2024-11-01')
    result.setEndDate('2024-11-01')
    result.setStationId('3329A')
    result.setSourceMode('online-station')
  })
}

describe('usePipeline continuous orchestration', () => {
  it('reads the canonical station API URL and trims surrounding whitespace', () => {
    vi.stubEnv('VITE_STATION_API_URL', '  https://station.example.test/v1/station-day  ')
    vi.stubEnv('VITE_STATION_DATA_ENDPOINT', 'https://legacy.example.test/v1/station-day')
    try {
      expect(defaultStationEndpoint()).toBe('https://station.example.test/v1/station-day')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('exposes only the exact four-stage PipelineStep type', () => {
    expectTypeOf<PipelineStep>().toEqualTypeOf<
      'data-source' | 'station-series' | 'quality-control' | 'exports'
    >()
    // @ts-expect-error legacy step names must not be assignable to the public contract
    const legacyStep: PipelineStep = 'download-links'
    expect(legacyStep).toBe('download-links')
  })

  it('rejects legacy step names at runtime without invoking a service', async () => {
    const injected = services()
    const { result } = renderHook(() => usePipeline({ services: injected }))
    const unsafeModel = result.current as unknown as {
      activeStep: string
      canRun(step: string): boolean
      setActiveStep(step: string): void
      runStep(step: string): Promise<void>
    }

    expect(unsafeModel.canRun('download-links')).toBe(false)
    act(() => unsafeModel.setActiveStep('download-links'))
    expect(result.current.activeStep).toBe('data-source')
    await act(() => unsafeModel.runStep('download-links'))
    expect(result.current.error).toBe('未知处理阶段：download-links')
    expect(injected.buildDownloadLinks).not.toHaveBeenCalled()
  })

  it('exports the exact four stages and production Task 2-4 services', () => {
    expect(PIPELINE_STEPS).toEqual([
      'data-source', 'station-series', 'quality-control', 'exports',
    ])
    expect(defaultPipelineServices.downloadStationRange).toBe(downloadStationRange)
    expect(defaultPipelineServices.parseStationInputs).toBe(parseStationInputs)
  })

  it('publishes online station rows directly, downloads one CSV, and feeds those rows to stage two', async () => {
    const injected = services()
    const download = vi.fn()
    const { result } = renderHook(() => usePipeline({
      services: injected,
      stationEndpoint: 'https://worker.example.test/v1/station-day',
      download,
    }))
    await configureOnlineStation(result.current)

    await act(() => result.current.downloadAndUseStationData())

    expect(injected.downloadStationRange).toHaveBeenCalledOnce()
    expect(injected.parseStationInputs).not.toHaveBeenCalled()
    expect(result.current.sourceStatus).toBe('ready')
    expect(result.current.parsedStationFiles[0]?.rows).toEqual(sourceRows)
    expect(download).toHaveBeenCalledOnce()
    expect(download).toHaveBeenCalledWith(expect.any(Blob), downloaded.filename)

    await act(() => result.current.runStep('station-series'))
    expect(injected.buildHourlySeries).toHaveBeenCalledWith(sourceRows)
    expect(result.current.stationSeries).toEqual(stationSeries)
  })

  it('reports cumulative online progress and keeps partial-range failures ready as warnings', async () => {
    const injected = services({
      downloadStationRange: vi.fn(async (options) => {
        options.onProgress?.({ completed: 1, total: 2, failed: 0 })
        options.onProgress?.({ completed: 2, total: 2, failed: 1 })
        return {
          ...downloaded,
          failedDates: ['2024-11-02'],
          warnings: ['2024-11-02: download failed (HTTP 404).'],
        }
      }),
    })
    const { result } = renderHook(() => usePipeline({
      services: injected,
      stationEndpoint: 'https://worker.example.test/v1/station-day',
      download: vi.fn(),
    }))
    await configureOnlineStation(result.current)
    await act(() => result.current.downloadAndUseStationData())

    expect(result.current.downloadProgress).toEqual({ completed: 2, total: 2, failed: 1 })
    expect(result.current.sourceStatus).toBe('ready')
    expect(result.current.warnings.join(' ')).toContain('2024-11-02')
  })

  it('builds links without making station input ready', async () => {
    const injected = services()
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => {
      result.current.setStartDate('2024-11-01')
      result.current.setEndDate('2024-11-01')
      result.current.setSourceMode('online-links')
    })

    await act(() => result.current.runStep('data-source'))

    expect(result.current.downloadLinks).toHaveLength(1)
    expect(result.current.sourceStatus).toBe('empty')
    expect(result.current.canRun('station-series')).toBe(false)
    expect(injected.downloadStationRange).not.toHaveBeenCalled()
  })

  it('automatically parses local files and enables stage two', async () => {
    const injected = services()
    const file = new File(['csv'], 'china_sites_20241101.csv')
    const { result } = renderHook(() => usePipeline({ services: injected }))

    act(() => result.current.setStationFiles([file]))

    expect(result.current.sourceMode).toBe('local-import')
    expect(result.current.sourceStatus).toBe('parsing')
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    expect(injected.parseStationInputs).toHaveBeenCalledWith([file], '3329A', expect.any(AbortSignal))
    expect(result.current.parsedStationFiles).toEqual(parsedFiles)
    expect(result.current.canRun('station-series')).toBe(true)
  })

  it('invalidates all derived data when switching from ready local input to public links', async () => {
    const injected = services()
    const file = new File(['csv'], 'china_sites_20241101.csv')
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([file]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    await act(() => result.current.runQcMode('station'))
    await act(() => result.current.runStep('exports'))
    act(() => result.current.setParsedUserDataset(userDataset))
    await act(() => result.current.runQcMode('merged'))
    await act(() => result.current.runStep('exports'))
    expect(result.current.exportArtifactsByMode.station).not.toBeNull()
    expect(result.current.exportArtifactsByMode.merged).not.toBeNull()

    act(() => result.current.setSourceMode('online-links'))

    expect(result.current.stationFiles).toEqual([file])
    expect(result.current.sourceStatus).toBe('empty')
    expect(result.current.parsedStationFiles).toEqual([])
    expect(result.current.stationSeries).toBeNull()
    expect(result.current.stationQcResult).toBeNull()
    expect(result.current.mergedQcResult).toBeNull()
    expect(result.current.exportArtifactsByMode).toEqual({ station: null, merged: null })
    expect(result.current.canRun('station-series')).toBe(false)
  })

  it('does not invalidate ready data when selecting the already active source mode', async () => {
    const injected = services()
    const file = new File(['csv'], 'china_sites_20241101.csv')
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([file]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))

    act(() => result.current.setSourceMode('local-import'))

    expect(result.current.sourceStatus).toBe('ready')
    expect(result.current.parsedStationFiles).toEqual(parsedFiles)
    expect(injected.parseStationInputs).toHaveBeenCalledOnce()
  })

  it('aborts user parsing on an actual source switch and ignores the late dataset', async () => {
    let resolveUser!: (value: ParsedUserDataset) => void
    let userSignal!: AbortSignal
    const injected = services({
      parseUserDataFile: vi.fn((_file, _mapping, signal) => {
        userSignal = signal
        return new Promise<ParsedUserDataset>((resolve) => { resolveUser = resolve })
      }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setUserDataFile(new File(['user'], 'user.csv')))
    await waitFor(() => expect(userSignal).toBeDefined())

    act(() => result.current.setSourceMode('online-links'))
    expect(userSignal.aborted).toBe(true)
    expect(result.current.userDataStatus).toBe('empty')
    act(() => resolveUser(userDataset))
    await Promise.resolve()
    expect(result.current.parsedUserDataset).toBeNull()
    expect(result.current.userDataStatus).toBe('empty')
  })

  it('reparses preserved local files after direct data and suppresses a late direct response', async () => {
    let resolveLate!: (value: DownloadedStationRange) => void
    let lateSignal!: AbortSignal
    const onlineReady = { ...downloaded, rows: [{ ...sourceRows[0], SO2: 99 }] }
    const injected = services({
      downloadStationRange: vi.fn()
        .mockResolvedValueOnce(onlineReady)
        .mockImplementationOnce((options) => {
          lateSignal = options.signal
          return new Promise<DownloadedStationRange>((resolve) => { resolveLate = resolve })
        }),
    })
    const download = vi.fn()
    const file = new File(['local'], 'china_sites_20241101.csv')
    const { result } = renderHook(() => usePipeline({
      services: injected,
      stationEndpoint: 'https://worker.example.test/v1/station-day',
      download,
    }))
    act(() => result.current.setStationFiles([file]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await configureOnlineStation(result.current)
    await act(() => result.current.downloadAndUseStationData())
    expect(result.current.parsedStationFiles[0]?.rows[0]?.SO2).toBe(99)

    act(() => result.current.setSourceMode('local-import'))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    expect(result.current.parsedStationFiles).toEqual(parsedFiles)

    await configureOnlineStation(result.current)
    let pending!: Promise<void>
    act(() => { pending = result.current.downloadAndUseStationData() })
    await waitFor(() => expect(lateSignal).toBeDefined())
    act(() => result.current.setSourceMode('local-import'))
    expect(lateSignal.aborted).toBe(true)
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    act(() => resolveLate({ ...downloaded, rows: [{ ...sourceRows[0], SO2: 77 }] }))
    await act(() => pending)
    expect(result.current.sourceMode).toBe('local-import')
    expect(result.current.parsedStationFiles).toEqual(parsedFiles)
    expect(download).toHaveBeenCalledOnce()
  })

  it('clears downstream state on empty or replacement files and suppresses stale local responses', async () => {
    let resolveFirst!: (value: ParsedStationFile[]) => void
    const first = new File(['first'], 'china_sites_20241101.csv')
    const second = new File(['second'], 'china_sites_20241102.csv')
    const replacement = [{ ...parsedFiles[0], filename: second.name }]
    const injected = services()
    vi.mocked(injected.parseStationInputs!)
      .mockImplementationOnce((_files, _station, signal) => new Promise((resolve, reject) => {
        resolveFirst = resolve
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
      .mockResolvedValueOnce(replacement)
    const { result } = renderHook(() => usePipeline({ services: injected }))

    act(() => result.current.setStationFiles([first]))
    await waitFor(() => expect(injected.parseStationInputs).toHaveBeenCalledTimes(1))
    act(() => result.current.setStationFiles([second]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    act(() => resolveFirst(parsedFiles))
    await Promise.resolve()
    expect(result.current.parsedStationFiles[0]?.filename).toBe(second.name)

    await act(() => result.current.runStep('station-series'))
    expect(result.current.stationSeries).not.toBeNull()
    act(() => result.current.setStationFiles([]))
    expect(result.current.sourceStatus).toBe('empty')
    expect(result.current.parsedStationFiles).toEqual([])
    expect(result.current.stationSeries).toBeNull()
    expect(result.current.stationQcResult).toBeNull()
    expect(result.current.mergedQcResult).toBeNull()
  })

  it('sanitizes and bounds local parse failures', async () => {
    const injected = services({
      parseStationInputs: vi.fn(async () => {
        throw new Error(`C:\\Private Folder\\secret.csv\u0007 ${'detail'.repeat(300)}`)
      }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['bad'], 'bad.csv')]))

    await waitFor(() => expect(result.current.sourceStatus).toBe('error'))
    expect(result.current.error).toContain('数据来源失败：')
    expect(result.current.error).not.toMatch(/Private Folder|secret\.csv|\u0007/)
    expect(result.current.error!.length).toBeLessThan(600)
  })

  it('switching source mode aborts an online run and prevents late state, progress, or downloads', async () => {
    let resolve!: (value: DownloadedStationRange) => void
    let signal!: AbortSignal
    let lateProgress!: (progress: { completed: number; total: number; failed: number }) => void
    const injected = services({
      downloadStationRange: vi.fn((options) => {
        signal = options.signal
        lateProgress = options.onProgress!
        return new Promise<DownloadedStationRange>((done) => { resolve = done })
      }),
    })
    const download = vi.fn()
    const { result } = renderHook(() => usePipeline({
      services: injected,
      stationEndpoint: 'https://worker.example.test/v1/station-day',
      download,
    }))
    await configureOnlineStation(result.current)
    let pending!: Promise<void>
    act(() => { pending = result.current.downloadAndUseStationData() })
    await waitFor(() => expect(signal).toBeDefined())

    act(() => result.current.setSourceMode('online-links'))
    expect(signal.aborted).toBe(true)
    act(() => {
      lateProgress({ completed: 1, total: 1, failed: 0 })
      resolve(downloaded)
    })
    await act(() => pending)
    expect(result.current.sourceMode).toBe('online-links')
    expect(result.current.downloadProgress).toBeNull()
    expect(result.current.parsedStationFiles).toEqual([])
    expect(download).not.toHaveBeenCalled()
  })

  it('preserves independent QC modes and invalidates only downstream results on rerun', async () => {
    const stationQc = { ...qcResult, counts: { station: 1 } }
    const mergedQc = { ...qcResult, counts: { merged: 1 } }
    const injected = services({
      runQcMode: vi.fn(async (mode) => mode === 'station' ? stationQc : mergedQc),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'china_sites_20241101.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    await act(() => result.current.runQcMode('station'))
    act(() => result.current.setParsedUserDataset(userDataset))
    await act(() => result.current.runQcMode('merged'))
    expect(result.current.stationQcResult).toEqual(stationQc)
    expect(result.current.mergedQcResult).not.toBeNull()
    const completedMergedQc = result.current.mergedQcResult

    await act(() => result.current.runQcMode('station'))
    expect(result.current.mergedQcResult).toBe(completedMergedQc)
    await act(() => result.current.runStep('station-series'))
    expect(result.current.parsedStationFiles).toEqual(parsedFiles)
    expect(result.current.stationQcResult).toBeNull()
    expect(result.current.mergedQcResult).toBeNull()
    expect(result.current.exportArtifacts).toBeNull()
  })

  it('requires the selected QC mode result before exports', async () => {
    const stationQc = { ...qcResult, counts: { station: 1 } }
    const injected = services({ runQcMode: vi.fn(async () => stationQc) })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'china_sites_20241101.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    await act(() => result.current.runQcMode('station'))
    expect(result.current.canRun('exports')).toBe(true)
    await act(() => result.current.runStep('exports'))
    expect(result.current.exportArtifacts).toEqual(artifacts)

    act(() => result.current.setQcMode('merged'))
    expect(result.current.stationQcResult).toEqual(stationQc)
    expect(result.current.mergedQcResult).toBeNull()
    expect(result.current.exportArtifacts).toBeNull()
    expect(result.current.canRun('exports')).toBe(false)
    await act(() => result.current.runStep('exports'))
    expect(result.current.error).toBe('请先完成“用户数据合并质控”')
    expect(injected.createExportArtifacts).toHaveBeenCalledTimes(1)
  })

  it('cannot export without an explicitly selected QC mode', async () => {
    const { result } = renderHook(() => usePipeline({ services: services() }))
    act(() => result.current.setQcMode(null))
    expect(result.current.canRun('exports')).toBe(false)
    await act(() => result.current.runStep('exports'))
    expect(result.current.error).toBe('请先选择质控模式')
  })

  it('keeps exports for both QC modes and invalidates only the rerun mode package', async () => {
    const injected = services({
      createExportArtifacts: vi.fn()
        .mockResolvedValueOnce(artifacts)
        .mockResolvedValueOnce(mergedArtifacts),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'china_sites_20241101.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    await act(() => result.current.runQcMode('station'))
    await act(() => result.current.runStep('exports'))
    act(() => result.current.setParsedUserDataset(userDataset))
    await act(() => result.current.runQcMode('merged'))
    await act(() => result.current.runStep('exports'))

    const modeExports = () => result.current.exportArtifactsByMode
    expect(modeExports()).toEqual({ station: artifacts, merged: mergedArtifacts })
    expect(result.current.exportArtifacts).toEqual(mergedArtifacts)

    act(() => result.current.setQcMode('station'))
    expect(result.current.exportArtifacts).toEqual(artifacts)
    await act(() => result.current.runQcMode('station'))
    expect(modeExports().station).toBeNull()
    expect(modeExports().merged).toEqual(mergedArtifacts)
    expect(result.current.exportArtifacts).toBeNull()
    act(() => result.current.setQcMode('merged'))
    expect(result.current.exportArtifacts).toEqual(mergedArtifacts)
  })

  it('validates the complete source configuration before enabling data-source', () => {
    const { result, rerender } = renderHook(
      ({ endpoint }) => usePipeline({ services: services(), stationEndpoint: endpoint }),
      { initialProps: { endpoint: 'https://worker.example.test/v1/station-day' } },
    )
    act(() => {
      result.current.setSourceMode('online-links')
      result.current.setStartDate('2024-01-01')
      result.current.setEndDate('2024-12-31')
    })
    expect(result.current.canRun('data-source')).toBe(true)
    act(() => result.current.setEndDate('2025-01-01'))
    expect(result.current.canRun('data-source')).toBe(false)

    act(() => {
      result.current.setEndDate('2024-12-31')
      result.current.setSourceMode('online-station')
    })
    expect(result.current.canRun('data-source')).toBe(true)
    act(() => result.current.setStationId('abc'))
    expect(result.current.canRun('data-source')).toBe(false)
    act(() => result.current.setStationId('3329A'))
    for (const endpoint of [
      'http://example.test/v1/station-day',
      'https://user@example.test/v1/station-day',
      'https://example.test/v1/station-day#fragment',
      'not a url',
    ]) {
      rerender({ endpoint })
      expect(result.current.canRun('data-source')).toBe(false)
    }
    rerender({ endpoint: 'http://127.0.0.1:8787/v1/station-day' })
    expect(result.current.canRun('data-source')).toBe(true)
  })

  it('does not enable a local source action while its automatic parse is running', () => {
    let resolve!: (value: ParsedStationFile[]) => void
    const injected = services({
      parseStationInputs: vi.fn(() => new Promise<ParsedStationFile[]>((done) => { resolve = done })),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    expect(result.current.sourceStatus).toBe('parsing')
    expect(result.current.canRun('data-source')).toBe(false)
    act(() => result.current.cancel())
    expect(result.current.canRun('data-source')).toBe(true)
    act(() => resolve(parsedFiles))
  })

  it('opens future stages without auto-running and gives exact prerequisite guidance', () => {
    const injected = services()
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setActiveStep('quality-control'))

    expect(result.current.activeStep).toBe('quality-control')
    expect(result.current.canRun('quality-control')).toBe(false)
    expect(result.current.message).toBe('请先获取或导入站点数据，并构建逐时序列')
    expect(injected.buildHourlySeries).not.toHaveBeenCalled()
    expect(injected.runQcMode).not.toHaveBeenCalled()
  })

  it('cancels physical work, stays actionable, and ignores a late online response', async () => {
    let resolve!: (value: DownloadedStationRange) => void
    let signal!: AbortSignal
    const injected = services({
      downloadStationRange: vi.fn((options) => {
        signal = options.signal
        return new Promise<DownloadedStationRange>((done) => { resolve = done })
      }),
    })
    const download = vi.fn()
    const { result } = renderHook(() => usePipeline({
      services: injected,
      stationEndpoint: 'https://worker.example.test/v1/station-day',
      download,
    }))
    await configureOnlineStation(result.current)
    let pending!: Promise<void>
    act(() => { pending = result.current.downloadAndUseStationData() })
    await waitFor(() => expect(result.current.status).toBe('running'))
    act(() => result.current.cancel())
    expect(signal.aborted).toBe(true)
    expect(result.current.status).toBe('cancelled')
    expect(result.current.canRun('data-source')).toBe(true)
    act(() => resolve(downloaded))
    await act(() => pending)
    expect(result.current.sourceStatus).toBe('empty')
    expect(download).not.toHaveBeenCalled()
  })

  it('aborts local parsing on unmount and survives StrictMode effect replay', async () => {
    let signal!: AbortSignal
    const injected = services({
      parseStationInputs: vi.fn((_files, _station, observed) => {
        signal = observed!
        return new Promise<ParsedStationFile[]>(() => undefined)
      }),
    })
    const { result, unmount } = renderHook(() => usePipeline({ services: injected }), {
      wrapper: StrictWrapper,
    })
    act(() => result.current.setStationFiles([new File(['csv'], 'china_sites_20241101.csv')]))
    await waitFor(() => expect(signal).toBeDefined())
    unmount()
    expect(signal.aborted).toBe(true)
  })

  it('runs sequentially from the current stage instead of restarting the source', async () => {
    const order: string[] = []
    const injected = services({
      buildHourlySeries: vi.fn((rows) => { order.push('series'); expect(rows).toEqual(sourceRows); return stationSeries }),
      runQcMode: vi.fn(async () => { order.push('qc'); return qcResult }),
      createExportArtifacts: vi.fn(async () => { order.push('exports'); return artifacts }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'china_sites_20241101.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    act(() => result.current.setActiveStep('station-series'))

    await act(() => result.current.runAll())

    expect(order).toEqual(['series', 'qc', 'exports'])
    expect(injected.buildDownloadLinks).not.toHaveBeenCalled()
    expect(injected.downloadStationRange).not.toHaveBeenCalled()
    expect(injected.parseStationInputs).toHaveBeenCalledOnce()
    expect(result.current.activeStep).toBe('exports')
    expect(result.current.status).toBe('complete')
    expect(result.current.progress).toBe(100)
  })

  it('runAll skips completed stages and resumes at the first incomplete stage', async () => {
    const order: string[] = []
    const injected = services({
      buildHourlySeries: vi.fn(() => { order.push('series'); return stationSeries }),
      runQcMode: vi.fn(async () => { order.push('qc'); return qcResult }),
      createExportArtifacts: vi.fn(async () => { order.push('exports'); return artifacts }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    const completedSeries = result.current.stationSeries
    act(() => result.current.setActiveStep('station-series'))

    await act(() => result.current.runAll())
    expect(order).toEqual(['series', 'qc', 'exports'])
    expect(result.current.stationSeries).toBe(completedSeries)
    expect(result.current.stationQcResult).toEqual(qcResult)
    expect(result.current.exportArtifacts).toEqual(artifacts)

    await act(() => result.current.runAll())
    expect(order).toEqual(['series', 'qc', 'exports'])
    expect(result.current.stationSeries).toBe(completedSeries)
    expect(result.current.exportArtifacts).toEqual(artifacts)
  })

  it('runAll failure preserves successful earlier stages', async () => {
    const injected = services({
      runQcMode: vi.fn(async () => { throw new Error('qc unavailable') }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    const completedSeries = result.current.stationSeries
    act(() => result.current.setActiveStep('station-series'))

    await act(() => result.current.runAll())
    expect(injected.buildHourlySeries).toHaveBeenCalledOnce()
    expect(result.current.parsedStationFiles).toEqual(parsedFiles)
    expect(result.current.stationSeries).toBe(completedSeries)
    expect(result.current.stationQcResult).toBeNull()
    expect(result.current.error).toContain('qc unavailable')
    expect(injected.createExportArtifacts).not.toHaveBeenCalled()
  })

  it('reruns a completed active stage when the pipeline version changes', async () => {
    const injected = services()
    const { result, rerender } = renderHook(
      ({ version }) => usePipeline({ services: injected, version }),
      { initialProps: { version: '1.0.0' } },
    )
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    await act(() => result.current.runQcMode('station'))
    await act(() => result.current.runStep('exports'))
    act(() => result.current.setActiveStep('station-series'))
    rerender({ version: '2.0.0' })

    await act(() => result.current.runAll())
    expect(injected.buildHourlySeries).toHaveBeenCalledTimes(2)
    expect(injected.runQcMode).toHaveBeenCalledTimes(2)
    expect(injected.createExportArtifacts).toHaveBeenCalledTimes(2)
  })

  it('runs an online station source and every downstream stage in one runAll token', async () => {
    const order: string[] = []
    const injected = services({
      downloadStationRange: vi.fn(async () => { order.push('download'); return downloaded }),
      buildHourlySeries: vi.fn(() => { order.push('series'); return stationSeries }),
      runQcMode: vi.fn(async () => { order.push('qc'); return qcResult }),
      createExportArtifacts: vi.fn(async () => { order.push('exports'); return artifacts }),
    })
    const download = vi.fn()
    const { result } = renderHook(() => usePipeline({
      services: injected,
      stationEndpoint: 'https://worker.example.test/v1/station-day',
      download,
    }))
    await configureOnlineStation(result.current)

    await act(() => result.current.runAll())

    expect(order).toEqual(['download', 'series', 'qc', 'exports'])
    expect(download).toHaveBeenCalledOnce()
    expect(result.current.sourceStatus).toBe('ready')
    expect(result.current.status).toBe('complete')
  })

  it('reports unsupported QC honestly when no implementation service is injected', async () => {
    const injected = services({ runQcMode: undefined })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'china_sites_20241101.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    await act(() => result.current.runQcMode('station'))

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('当前版本尚未提供站点数据质控服务')
    expect(result.current.stationQcResult).toBeNull()
  })

  it('uses selected-mode prerequisites and lets station QC run without user data', async () => {
    const injected = services()
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))

    expect(result.current.canRun('quality-control')).toBe(true)
    await act(() => result.current.runQcMode('station'))
    expect(injected.runQcMode).toHaveBeenCalledWith('station', expect.objectContaining({
      stationRows: stationSeries.rows, signal: expect.any(AbortSignal),
    }))

    act(() => result.current.setQcMode('merged'))
    expect(result.current.canRun('quality-control')).toBe(false)
    act(() => result.current.setActiveStep('quality-control'))
    expect(result.current.message).toBe('\u8bf7\u5148\u5bfc\u5165\u5e76\u5b8c\u6210\u7528\u6237\u6570\u636e\u5b57\u6bb5\u6620\u5c04')
  })

  it('accepts a canonical user dataset and runs merge plus dynamic QC without the legacy ion service', async () => {
    const injected = services()
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    act(() => result.current.setParsedUserDataset(userDataset))

    expect(result.current.userDataStatus).toBe('ready')
    expect(result.current.parsedUserDataset).toEqual(userDataset)
    expect(result.current.canRun('quality-control')).toBe(true)
    await act(() => result.current.runQcMode('merged'))

    expect(injected.runQcMode).not.toHaveBeenCalled()
    expect(result.current.userMergeResult?.rows[0]?.userValues).toEqual({ dust: 2 })
    expect(result.current.mergedQcResult?.rows[0]).toMatchObject({
      userValues: { dust: 2 }, QC_keep: false,
    })
  })

  it('invalidates only merged QC/export when canonical user data changes and keeps both modes coexisting', async () => {
    const injected = services({
      createExportArtifacts: vi.fn()
        .mockResolvedValueOnce(artifacts)
        .mockResolvedValueOnce(mergedArtifacts),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    await act(() => result.current.runQcMode('station'))
    await act(() => result.current.runStep('exports'))
    act(() => result.current.setParsedUserDataset(userDataset))
    await act(() => result.current.runQcMode('merged'))
    await act(() => result.current.runStep('exports'))
    expect(result.current.stationQcResult).not.toBeNull()
    expect(result.current.mergedQcResult).not.toBeNull()
    expect(result.current.exportArtifactsByMode).toEqual({ station: artifacts, merged: mergedArtifacts })

    act(() => result.current.setParsedUserDataset({
      ...userDataset,
      rows: [{ timestamp: '2024-11-01 00:00:00', values: { dust: 3 } }],
    }))
    expect(result.current.stationQcResult).not.toBeNull()
    expect(result.current.exportArtifactsByMode.station).toEqual(artifacts)
    expect(result.current.mergedQcResult).toBeNull()
    expect(result.current.exportArtifactsByMode.merged).toBeNull()
  })

  it('aborts and suppresses a stale merged export after switching modes before user data changes', async () => {
    let resolveExport!: (value: ResultArtifacts) => void
    let exportSignal!: AbortSignal
    let abortCalls = 0
    const injected = services({
      createExportArtifacts: vi.fn((input) => {
        exportSignal = input.signal
        input.signal.addEventListener('abort', () => { abortCalls += 1 })
        return new Promise<ResultArtifacts>((resolve) => { resolveExport = resolve })
      }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    act(() => result.current.setParsedUserDataset(userDataset))
    await act(() => result.current.runQcMode('merged'))
    let pending!: Promise<void>
    act(() => { pending = result.current.runStep('exports') })
    await waitFor(() => expect(exportSignal).toBeDefined())
    expect(injected.createExportArtifacts).toHaveBeenCalledOnce()

    act(() => result.current.setQcMode('station'))
    act(() => result.current.setParsedUserDataset({
      ...userDataset,
      rows: [{ timestamp: '2024-11-01 00:00:00', values: { dust: 4 } }],
    }))
    expect(exportSignal.aborted).toBe(true)
    expect(abortCalls).toBe(1)
    act(() => resolveExport(mergedArtifacts))
    await act(() => pending)
    expect(result.current.exportArtifactsByMode.merged).toBeNull()
    expect(result.current.status).toBe('idle')
  })

  it('does not cancel active station QC when user data changes', async () => {
    let resolveStationQc!: (value: QualityControlResult) => void
    let stationSignal!: AbortSignal
    const injected = services({
      runQcMode: vi.fn((_mode, input) => {
        stationSignal = input.signal
        return new Promise<QualityControlResult>((resolve) => { resolveStationQc = resolve })
      }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    let pending!: Promise<void>
    act(() => { pending = result.current.runQcMode('station') })
    await waitFor(() => expect(stationSignal).toBeDefined())

    act(() => result.current.setParsedUserDataset(userDataset))
    expect(stationSignal.aborted).toBe(false)
    act(() => resolveStationQc(qcResult))
    await act(() => pending)
    expect(result.current.stationQcResult).toEqual(qcResult)
  })

  it('cancels a pending merged export on an actual mode switch without clearing completed QC', async () => {
    let resolveExport!: (value: ResultArtifacts) => void
    let signal!: AbortSignal
    let abortCalls = 0
    const injected = services({
      createExportArtifacts: vi.fn((input) => {
        signal = input.signal
        signal.addEventListener('abort', () => { abortCalls += 1 })
        return new Promise<ResultArtifacts>((resolve) => { resolveExport = resolve })
      }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    act(() => result.current.setParsedUserDataset(userDataset))
    await act(() => result.current.runQcMode('merged'))
    const completedMergedQc = result.current.mergedQcResult
    let pending!: Promise<void>
    act(() => { pending = result.current.runStep('exports') })
    await waitFor(() => expect(signal).toBeDefined())

    act(() => result.current.setQcMode('station'))
    expect(signal.aborted).toBe(true)
    expect(abortCalls).toBe(1)
    expect(result.current.mergedQcResult).toBe(completedMergedQc)
    expect(result.current.canRun('exports')).toBe(false)
    act(() => resolveExport(mergedArtifacts))
    await act(() => pending)
    expect(result.current.exportArtifactsByMode.merged).toBeNull()
    expect(result.current.status).toBe('idle')
  })

  it('cancels runAll on a mode switch and never publishes late completion or artifacts', async () => {
    let resolveExport!: (value: ResultArtifacts) => void
    let signal!: AbortSignal
    const injected = services({
      createExportArtifacts: vi.fn((input) => {
        signal = input.signal
        return new Promise<ResultArtifacts>((resolve) => { resolveExport = resolve })
      }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    act(() => {
      result.current.setParsedUserDataset(userDataset)
      result.current.setQcMode('merged')
      result.current.setActiveStep('quality-control')
    })
    let pending!: Promise<void>
    act(() => { pending = result.current.runAll() })
    await waitFor(() => expect(signal).toBeDefined())

    act(() => result.current.setQcMode('station'))
    expect(signal.aborted).toBe(true)
    act(() => resolveExport(mergedArtifacts))
    await act(() => pending)
    expect(result.current.status).toBe('idle')
    expect(result.current.progress).not.toBe(100)
    expect(result.current.exportArtifactsByMode.merged).toBeNull()
  })

  it('does not cancel a pending export when the same mode is selected again', async () => {
    let resolveExport!: (value: ResultArtifacts) => void
    let signal!: AbortSignal
    const injected = services({
      createExportArtifacts: vi.fn((input) => {
        signal = input.signal
        return new Promise<ResultArtifacts>((resolve) => { resolveExport = resolve })
      }),
    })
    const { result } = renderHook(() => usePipeline({ services: injected }))
    act(() => result.current.setStationFiles([new File(['csv'], 'station.csv')]))
    await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
    await act(() => result.current.runStep('station-series'))
    act(() => result.current.setParsedUserDataset(userDataset))
    await act(() => result.current.runQcMode('merged'))
    let pending!: Promise<void>
    act(() => { pending = result.current.runStep('exports') })
    await waitFor(() => expect(signal).toBeDefined())

    act(() => result.current.setQcMode('merged'))
    expect(signal.aborted).toBe(false)
    act(() => resolveExport(mergedArtifacts))
    await act(() => pending)
    expect(result.current.exportArtifactsByMode.merged).toEqual(mergedArtifacts)
    expect(result.current.status).toBe('complete')
  })

  it('automatically parses user files, exposes mapping-required state, and accepts a mapping retry', async () => {
    const mapping: UserDataMapping = userDataset.mapping!
    const mappingRequired: ParsedUserDataset = {
      rows: [], variables: [], warnings: [], warningTotal: 0, sheetName: 'Data',
      mappingRequired: { reason: 'missing-time', timeCandidates: [], columns: [{ sourceColumn: 0, label: 'when' }] },
    }
    const parseUserDataFile = vi.fn()
      .mockResolvedValueOnce(mappingRequired)
      .mockResolvedValueOnce(userDataset)
    const { result } = renderHook(() => usePipeline({ services: services({ parseUserDataFile }) }))
    const file = new File(['time,dust'], 'custom.xlsx')

    act(() => result.current.setUserDataFile(file))
    expect(result.current.userDataStatus).toBe('parsing')
    await waitFor(() => expect(result.current.userDataStatus).toBe('mapping-required'))
    expect(result.current.userMappingRequired).toEqual(mappingRequired.mappingRequired)

    act(() => result.current.setUserDataFile(file, mapping))
    await waitFor(() => expect(result.current.userDataStatus).toBe('ready'))
    expect(parseUserDataFile).toHaveBeenLastCalledWith(file, mapping, expect.any(AbortSignal))
    expect(result.current.parsedUserDataset).toEqual(userDataset)
  })

  it('uses the worker-backed default CSV client without reading text on the hook thread', async () => {
    const instances: Array<{
      onmessage: ((event: MessageEvent) => void) | null
      posted: unknown[]
      terminateCalls: number
    }> = []
    class CsvWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      onmessageerror: ((event: MessageEvent) => void) | null = null
      posted: unknown[] = []
      terminateCalls = 0
      constructor() { instances.push(this) }
      postMessage(message: unknown): void { this.posted.push(message) }
      terminate(): void { this.terminateCalls += 1 }
    }
    vi.stubGlobal('Worker', CsvWorker)
    const bytes = new TextEncoder().encode('time,dust\n2024-11-01 00:00,2').buffer
    const text = vi.fn(async () => 'must not run')
    const arrayBuffer = vi.fn(async () => bytes)
    const file = { name: 'user.csv', size: bytes.byteLength, text, arrayBuffer } as unknown as File
    const { result, unmount } = renderHook(() => usePipeline({ services: services({ parseUserDataFile: undefined }) }))
    try {
      act(() => result.current.setUserDataFile(file))
      await waitFor(() => expect(instances).toHaveLength(1))
      expect(text).not.toHaveBeenCalled()
      expect(arrayBuffer).toHaveBeenCalledOnce()
      expect(instances[0]?.posted[0]).toMatchObject({ kind: 'csv' })
      act(() => instances[0]?.onmessage?.(new MessageEvent('message', { data: { ok: true, result: userDataset } })))
      await waitFor(() => expect(result.current.userDataStatus).toBe('ready'))
      expect(result.current.parsedUserDataset).toEqual(userDataset)
      expect(instances[0]?.terminateCalls).toBe(1)
    } finally {
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('keeps user parsing source-specific, cancels stale responses, and aborts it on unmount', async () => {
    let firstResolve!: (value: ParsedUserDataset) => void
    const signals: AbortSignal[] = []
    const parseUserDataFile = vi.fn((_file: File, _mapping: UserDataMapping | undefined, signal: AbortSignal) => {
      signals.push(signal)
      if (signals.length === 1) return new Promise<ParsedUserDataset>((resolve) => { firstResolve = resolve })
      if (signals.length === 3) return new Promise<ParsedUserDataset>(() => undefined)
      return Promise.resolve(userDataset)
    })
    const injected = services({ parseUserDataFile })
    const { result, unmount } = renderHook(() => usePipeline({ services: injected }))
    const first = new File(['a'], 'first.csv')
    const second = new File(['b'], 'second.csv')

    act(() => result.current.setUserDataFile(first))
    await waitFor(() => expect(signals).toHaveLength(1))
    act(() => result.current.setUserDataFile(second))
    expect(signals[0]?.aborted).toBe(true)
    await waitFor(() => expect(result.current.userDataStatus).toBe('ready'))
    act(() => firstResolve({ ...userDataset, sheetName: 'stale' }))
    await Promise.resolve()
    expect(result.current.parsedUserDataset?.sheetName).toBe('Data')

    act(() => result.current.setUserDataFile(first))
    await waitFor(() => expect(signals).toHaveLength(3))
    unmount()
    expect(signals[2]?.aborted).toBe(true)
  })
})
