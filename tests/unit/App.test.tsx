import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from '../../src/app/App'
import { Workbench } from '../../src/components/Workbench'
import type { QualityControlResult } from '../../src/core/qualityControl'
import type { HourlySeriesResult } from '../../src/core/stationSeries'
import type { PipelineModel, PipelineServices } from '../../src/pipeline/usePipeline'

const parsedFile = {
  filename: 'china_sites_20241101.csv',
  rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 1 }],
  warnings: [],
}
const stationSeries: HourlySeriesResult = {
  rows: [{
    timestamp: '2024-11-01 00:00:00', SO2: 1,
    missing: ['NO2', 'O3', 'CO', 'PM10', 'PM2.5'], status: '存在缺测',
  }],
  duplicateTimes: [], warnings: [],
}
const qcResult: QualityControlResult = {
  rows: [], counts: { 正常: 0 }, keptRows: [], rejectedRows: [],
}
const artifacts = {
  stationCsv: { name: 'station.csv', content: 'station' },
  mergedCsv: { name: 'merged.csv', content: 'merged' },
  qcWorkbook: { name: 'qc.xlsx', content: new Blob(['xlsx']) },
  processingLog: { name: 'log.json', content: '{}' },
  zip: { name: 'results.zip', content: new Blob(['zip']) },
}

function services(overrides: Partial<PipelineServices> = {}): PipelineServices {
  return {
    buildDownloadLinks: (start) => [{
      date: start,
      filename: `china_sites_${start.replaceAll('-', '')}.csv`,
      url: `https://quotsoft.net/air/data/china_sites_${start.replaceAll('-', '')}.csv`,
    }],
    downloadStationRange: vi.fn(async () => ({
      filename: '3329A_20241101_20241101.csv', csvText: 'csv',
      rows: parsedFile.rows, failedDates: [], warnings: [], warningTotal: 0,
      allRows: [{ timestamp: parsedFile.rows[0].timestamp, values: { SO2: 1 } }],
    })),
    parseStationInputs: vi.fn(async () => [parsedFile]),
    buildHourlySeries: vi.fn(() => stationSeries),
    runQcMode: vi.fn(async () => qcResult),
    createExportArtifacts: vi.fn(async () => artifacts),
    ...overrides,
  }
}

function stepButton(name: string) {
  return within(screen.getByRole('navigation', { name: '处理步骤' }))
    .getByRole('button', { name: new RegExp(name) })
}

function exportPipeline(overrides: Partial<PipelineModel> = {}): PipelineModel {
  return {
    startDate: '', endDate: '', stationId: '', stationFiles: [], ionFile: null, userDataFile: null,
    userDataStatus: 'empty', userDataError: null, parsedUserDataset: null, userMappingRequired: null,
    sourceMode: null, sourceStatus: 'ready', downloadProgress: null, activeStep: 'exports', qcMode: 'merged',
    status: 'complete', progress: 100, message: '处理完成', error: null, warnings: [], downloadLinks: [],
    parsedStationFiles: [], stationSeries: null, stationSeriesResult: null, stationRows: [],
    stationQcResult: null, mergedQcResult: null, qcResult: null,
    exportArtifactsByMode: { station: artifacts, merged: artifacts }, exportArtifacts: artifacts,
    ionWorkbook: null, ionRows: [], mergeResult: null, userMergeResult: null,
    setStartDate: vi.fn(), setEndDate: vi.fn(), setStationId: vi.fn(), setSourceMode: vi.fn(),
    setStationFiles: vi.fn(), setIonFile: vi.fn(), setUserDataFile: vi.fn(), setParsedUserDataset: vi.fn(),
    setQcMode: vi.fn(), setActiveStep: vi.fn(), downloadAndUseStationData: vi.fn(async () => undefined),
    runQcMode: vi.fn(async () => undefined), canRun: vi.fn(() => true), runStep: vi.fn(async () => undefined),
    runAll: vi.fn(async () => undefined), cancel: vi.fn(), resetResults: vi.fn(),
    ...overrides,
  }
}

async function prepareStationQc() {
  fireEvent.click(screen.getByRole('button', { name: '本地导入 CSV' }))
  fireEvent.change(screen.getByLabelText('选择 CSV 文件'), {
    target: { files: [new File(['csv'], 'station.csv', { type: 'text/csv' })] },
  })
  await waitFor(() => expect(screen.getByText('已准备 1 个站点文件')).toBeInTheDocument())
  fireEvent.click(stepButton('构建逐时序列'))
  fireEvent.click(within(screen.getByRole('article', { name: '构建逐时序列' })).getByRole('button', { name: '构建逐时序列' }))
  await waitFor(() => expect(screen.getByText('当前序列 1 行')).toBeInTheDocument())
  fireEvent.click(stepButton('数据质控'))
  fireEvent.click(screen.getByLabelText('站点数据质控'))
  fireEvent.click(screen.getByRole('button', { name: '运行当前质控' }))
  await waitFor(() => expect(screen.getByRole('region', { name: '站点质控结果' })).toBeInTheDocument())
}

describe('App four-stage shell', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders the exact approved identity and static hero copy', () => {
    render(<App services={services()} />)
    expect(screen.getByText('江峰课题组')).toBeInTheDocument()
    expect(screen.getByText('MAKING INVISIBLE ATMOSPHERIC PROCESSES ANALYZABLE')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '让不可见的 大气过程可分析' })).toBeInTheDocument()
    expect(screen.queryByText('安徽理工大学课题组')).not.toBeInTheDocument()
    expect(screen.queryByText(/本地处理|数据不离开浏览器/)).not.toBeInTheDocument()
  })

  it('renders the native static hero without an overlay layer or picture-wide gradient', () => {
    render(<App services={services()} />)
    expect(document.querySelector('.hero-edge-fade')).not.toBeInTheDocument()
    const heroSource = readFileSync(resolve('src/components/Hero.tsx'), 'utf8')
    const css = readFileSync(resolve('src/app/app.css'), 'utf8')
    expect(heroSource).not.toContain('hero-edge-fade')
    expect(css).not.toMatch(/\.hero-edge-fade/)
    expect(css).not.toMatch(/\.hero(?:-photo)?[^{}]*\{[^}]*linear-gradient/is)
    expect(css).toMatch(/\.hero-kicker[^{}]*\{[^}]*text-shadow:/is)
  })

  it('uses four hero stage buttons and transfers keyboard or pointer activation focus to the active panel', async () => {
    let reducedMotion = true
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reducedMotion })))
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    render(<App services={services()} />)
    const hero = screen.getByRole('region', { name: '让不可见的 大气过程可分析' })
    const buttons = within(hero).getAllByRole('button')
    expect(buttons).toHaveLength(4)
    const qcButton = within(hero).getByRole('button', { name: '数据质控' })
    qcButton.focus()
    fireEvent.click(qcButton, { detail: 0 })
    const qcPanel = await screen.findByRole('article', { name: '数据质控' })
    await waitFor(() => expect(qcPanel).toHaveFocus())
    expect(qcPanel).toHaveAttribute('id', 'workbench-panel-quality-control')
    expect(qcPanel).toHaveAttribute('tabindex', '-1')
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'start' })

    reducedMotion = false
    const exportButton = within(hero).getByRole('button', { name: '导出结果' })
    fireEvent.click(exportButton)
    const exportPanel = await screen.findByRole('article', { name: '导出结果' })
    await waitFor(() => expect(exportPanel).toHaveFocus())
    expect(exportButton).toHaveAttribute('aria-current', 'step')
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' })
    expect(document.querySelectorAll('.active-panel')).toHaveLength(1)
  })

  it('renders exactly four semantic stages and switches the active panel', () => {
    render(<App services={services()} />)
    const labels = ['获取或导入数据', '构建逐时序列', '数据质控', '导出结果']
    for (const label of labels) {
      const button = stepButton(label)
      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-current', 'step')
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument()
      expect(document.querySelectorAll('.active-panel')).toHaveLength(1)
    }
    expect(within(screen.getByRole('navigation', { name: '处理步骤' })).getAllByRole('button')).toHaveLength(4)
  })

  it('opens a future stage with guidance and no hidden execution', () => {
    const injected = services()
    render(<App services={injected} />)
    fireEvent.click(stepButton('数据质控'))
    expect(within(screen.getByRole('article', { name: '数据质控' })).getByText('请先获取或导入站点数据，并构建逐时序列')).toBeInTheDocument()
    expect(injected.runQcMode).not.toHaveBeenCalled()
  })

  it('exposes one keyboard-operable pipeline action and invokes runAll once', () => {
    const runAll = vi.fn(async () => undefined)
    const download = vi.fn()
    const pipeline = exportPipeline({
      activeStep: 'data-source',
      status: 'idle',
      progress: 0,
      message: '',
      sourceStatus: 'empty',
      exportArtifactsByMode: { station: null, merged: null },
      exportArtifacts: null,
      runAll,
    })
    render(<Workbench pipeline={pipeline} download={download} />)

    const actions = screen.getAllByRole('button', { name: '一键完成全部' })
    expect(actions).toHaveLength(1)
    actions[0].focus()
    expect(actions[0]).toHaveFocus()
    fireEvent.click(actions[0], { detail: 0 })
    expect(runAll).toHaveBeenCalledOnce()
    expect(download).not.toHaveBeenCalled()
  })

  it('offers to continue from the current stage when earlier work exists', () => {
    const runAll = vi.fn(async () => undefined)
    render(<Workbench pipeline={exportPipeline({
      activeStep: 'quality-control',
      status: 'idle',
      progress: 50,
      message: '',
      stationSeries,
      stationSeriesResult: stationSeries,
      stationRows: stationSeries.rows,
      exportArtifactsByMode: { station: null, merged: null },
      exportArtifacts: null,
      runAll,
    })} download={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '从当前步骤继续' }))
    expect(runAll).toHaveBeenCalledOnce()
  })

  it('leaves only cancellation enabled while the pipeline is busy', () => {
    const pipeline = exportPipeline({
      activeStep: 'quality-control',
      status: 'running',
      message: '正在执行数据质控…',
      stationSeries,
      stationSeriesResult: stationSeries,
      stationRows: stationSeries.rows,
      exportArtifactsByMode: { station: null, merged: null },
      exportArtifacts: null,
    })
    render(<Workbench pipeline={pipeline} download={vi.fn()} />)

    const workbench = screen.getByRole('region', { name: '数据工作台' })
    expect(workbench).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: '从当前步骤继续' })).toBeDisabled()
    const cancel = screen.getByRole('button', { name: '取消处理' })
    expect(cancel).toBeEnabled()
    expect(within(workbench).getAllByRole('button').filter((button) => !button.hasAttribute('disabled'))).toEqual([cancel])
    fireEvent.click(cancel)
    expect(pipeline.cancel).toHaveBeenCalledOnce()
  })

  it('shows precise source guidance and creates artifacts without downloading automatically', async () => {
    const download = vi.fn()
    render(<App services={services()} download={download} />)

    fireEvent.click(screen.getByRole('button', { name: '一键完成全部' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请先选择在线获取或本地导入')

    fireEvent.click(screen.getByRole('button', { name: '本地导入 CSV' }))
    fireEvent.change(screen.getByLabelText('选择 CSV 文件'), {
      target: { files: [new File(['csv'], 'station.csv', { type: 'text/csv' })] },
    })
    await waitFor(() => expect(screen.getByText('已准备 1 个站点文件')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '从当前步骤继续' }))
    expect(await screen.findByRole('region', { name: '站点质控结果文件' })).toBeInTheDocument()
    expect(download).not.toHaveBeenCalled()
  })

  it('builds public links without requiring a station or enabling stage two', async () => {
    render(<App services={services()} />)
    fireEvent.click(screen.getByRole('button', { name: '生成公开链接' }))
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2024-11-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2024-11-01' } })
    fireEvent.click(screen.getByRole('button', { name: '生成下载链接' }))
    expect(await screen.findByRole('link', { name: 'china_sites_20241101.csv' })).toHaveAttribute(
      'href', 'https://quotsoft.net/air/data/china_sites_20241101.csv',
    )
    fireEvent.click(stepButton('构建逐时序列'))
    expect(within(screen.getByRole('article', { name: '构建逐时序列' })).getByText('请先获取或导入站点数据')).toBeInTheDocument()
  })

  it('auto-parses local CSV and keeps cancellation actionable', async () => {
    let resolve!: (value: typeof parsedFile[]) => void
    render(<App services={services({
      parseStationInputs: vi.fn(() => new Promise<typeof parsedFile[]>((done) => { resolve = done })),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '本地导入 CSV' }))
    fireEvent.change(screen.getByLabelText('选择 CSV 文件'), {
      target: { files: [new File(['csv'], 'station.csv', { type: 'text/csv' })] },
    })
    const cancel = await screen.findByRole('button', { name: '取消处理' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    resolve([parsedFile])
    await waitFor(() => expect(screen.queryByRole('button', { name: '取消处理' })).not.toBeInTheDocument())
  })

  it('downloads and immediately uses station data from the online direct path', async () => {
    const download = vi.fn()
    const injected = services()
    render(<App services={injected} stationEndpoint="https://worker.example.test/v1/station-day" download={download} />)
    fireEvent.click(screen.getByRole('button', { name: '站点直连下载' }))
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2024-11-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2024-11-01' } })
    fireEvent.change(screen.getByLabelText('站点编号'), { target: { value: '3329A' } })
    fireEvent.click(screen.getByRole('button', { name: '下载并使用站点数据' }))
    await waitFor(() => expect(injected.downloadStationRange).toHaveBeenCalledOnce())
    expect(download).toHaveBeenCalledWith(expect.any(Blob), '3329A_20241101_20241101.csv')
    expect(screen.getByText('已准备 1 个站点文件')).toBeInTheDocument()
  })

  it('shows column mapping only when merged input requires it and blocks an invalid mapping', async () => {
    const mappingRequired = {
      rows: [], variables: [], warnings: [], warningTotal: 0, sheetName: 'CSV',
      mappingRequired: {
        reason: 'ambiguous-time' as const,
        timeCandidates: [0, 1],
        columns: [
          { sourceColumn: 0, label: '开始时间' },
          { sourceColumn: 1, label: '结束时间' },
          { sourceColumn: 2, label: '硫酸根' },
        ],
      },
    }
    render(<App services={services({ parseUserDataFile: vi.fn(async () => mappingRequired) })} />)
    fireEvent.click(stepButton('数据质控'))
    expect(screen.queryByRole('group', { name: '字段映射' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('用户数据合并质控'))
    fireEvent.change(screen.getByLabelText('选择 CSV 或 XLSX 文件'), {
      target: { files: [new File(['time,value'], 'user.csv', { type: 'text/csv' })] },
    })
    const mapping = await screen.findByRole('group', { name: '字段映射' })
    const submit = within(mapping).getByRole('button', { name: '应用字段映射' })
    expect(submit).toBeDisabled()
    fireEvent.change(within(mapping).getByLabelText('时间列'), { target: { value: '0' } })
    fireEvent.click(within(mapping).getByLabelText('选择变量 硫酸根'))
    expect(submit).toBeEnabled()
  })

  it('requires the selected QC mode result before exports', async () => {
    render(<App services={services()} />)
    await prepareStationQc()
    fireEvent.click(screen.getByLabelText('用户数据合并质控'))
    fireEvent.click(stepButton('导出结果'))
    expect(within(screen.getByRole('article', { name: '导出结果' })).getByText('请先完成“用户数据合并质控”')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成合并质控导出文件' })).toBeDisabled()
  })

  it('exports and downloads the selected mode artifacts', async () => {
    const download = vi.fn()
    render(<App services={services()} download={download} />)
    await prepareStationQc()
    fireEvent.click(stepButton('导出结果'))
    fireEvent.click(screen.getByRole('button', { name: '生成站点质控导出文件' }))
    const zip = await screen.findByRole('button', { name: '下载 results.zip' })
    fireEvent.click(zip)
    expect(download).toHaveBeenCalledWith(artifacts.zip.content, 'results.zip')
  })

  it('cancels one in-flight combined export with AbortError and never downloads it', async () => {
    const pipeline = exportPipeline()
    const download = vi.fn()
    let abortEvents = 0
    const buildCombinedDownload = vi.fn((_input, options: { signal?: AbortSignal } = {}) => new Promise<never>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        abortEvents += 1
        reject(new DOMException('cancelled', 'AbortError'))
      })
    }))
    render(<Workbench pipeline={pipeline} download={download} buildCombinedDownload={buildCombinedDownload} />)

    const combine = screen.getByRole('button', { name: '下载全部结果' })
    fireEvent.click(combine)
    fireEvent.click(combine)
    expect(buildCombinedDownload).toHaveBeenCalledOnce()
    expect(buildCombinedDownload.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) })
    const panel = screen.getByRole('article', { name: '导出结果' })
    expect(panel).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: '生成合并质控导出文件' })).toBeDisabled()
    for (const artifactDownload of within(panel).getAllByRole('button', { name: /^下载 / })) {
      expect(artifactDownload).toBeDisabled()
    }
    const cancel = screen.getByRole('button', { name: '取消处理' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('全部结果打包已取消'))
    expect(pipeline.cancel).toHaveBeenCalledOnce()
    expect(abortEvents).toBe(1)
    expect(download).not.toHaveBeenCalled()
  })

  it('ignores a combined export that resolves after cancellation and does not update late state', async () => {
    const pipeline = exportPipeline()
    const download = vi.fn()
    let resolveCombined!: (value: { name: string; content: Blob }) => void
    const buildCombinedDownload = vi.fn(() => new Promise<{ name: string; content: Blob }>((resolvePromise) => {
      resolveCombined = resolvePromise
    }))
    const { unmount } = render(
      <Workbench pipeline={pipeline} download={download} buildCombinedDownload={buildCombinedDownload} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '下载全部结果' }))
    fireEvent.click(screen.getByRole('button', { name: '取消处理' }))
    expect(screen.getByRole('status')).toHaveTextContent('全部结果打包已取消')
    resolveCombined({ name: 'all.zip', content: new Blob(['late']) })
    await Promise.resolve()
    expect(download).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('全部结果打包已取消')
    unmount()
  })

  it('aborts an in-flight combined export exactly once when the workbench unmounts', () => {
    let abortEvents = 0
    const buildCombinedDownload = vi.fn((_input, options: { signal?: AbortSignal } = {}) => new Promise<never>(() => {
      options.signal?.addEventListener('abort', () => { abortEvents += 1 })
    }))
    const { unmount } = render(
      <Workbench pipeline={exportPipeline()} download={vi.fn()} buildCombinedDownload={buildCombinedDownload} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '下载全部结果' }))
    unmount()
    expect(abortEvents).toBe(1)
  })

  it('exposes the four-stage progress indicator', () => {
    render(<App services={services()} />)
    expect(screen.getByRole('progressbar', { name: '处理进度' })).toBeInTheDocument()
  })

  it('contains no hero motion implementation identifiers', () => {
    const source = [
      readFileSync(resolve('src/components/Hero.tsx'), 'utf8'),
      readFileSync(resolve('src/app/App.tsx'), 'utf8'),
      readFileSync(resolve('src/app/app.css'), 'utf8'),
    ].join('\n')
    expect(source).not.toMatch(/requestAnimationFrame|cancelAnimationFrame|onPointerMove|parallax|particle-field|fog-near|fog-far|camera-breathe|will-change/i)
  })
})
