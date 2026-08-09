import { expect, test, type Download, type Locator, type Page } from '@playwright/test'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import readXlsxFile from 'read-excel-file/node'

const NATIONAL_FIXTURE = resolve('tests/fixtures/china_sites_20241101-small.csv')
const USER_CSV_FIXTURE = resolve('tests/fixtures/user-data-small.csv')
const USER_XLSX_FIXTURE = resolve('tests/fixtures/user-data-small.xlsx')
const STATION_ID = '3329A'
const START_DATE = '2024-11-01'
const END_DATE = '2024-11-03'
const STEP_LABELS = ['获取或导入数据', '构建逐时序列', '数据质控', '导出结果'] as const

type StationApiOptions = { delayMs?: number }
type RuntimeIssues = {
  console: string[]
  page: string[]
  requests: string[]
  onConsole(message: import('@playwright/test').ConsoleMessage): void
  onPageError(error: Error): void
  onRequestFailed(request: import('@playwright/test').Request): void
}

const runtimeIssues = new WeakMap<Page, RuntimeIssues>()

test.beforeEach(async ({ page }) => {
  const issues: RuntimeIssues = {
    console: [],
    page: [],
    requests: [],
    onConsole(message) {
      if (message.type() === 'error' || message.type() === 'warning') {
        this.console.push(`${message.type()}: ${message.text()}`)
      }
    },
    onPageError(error) { this.page.push(error.message) },
    onRequestFailed(request) {
      this.requests.push(`${request.url()} :: ${request.failure()?.errorText ?? 'unknown request failure'}`)
    },
  }
  issues.onConsole = issues.onConsole.bind(issues)
  issues.onPageError = issues.onPageError.bind(issues)
  issues.onRequestFailed = issues.onRequestFailed.bind(issues)
  runtimeIssues.set(page, issues)
  page.on('console', issues.onConsole)
  page.on('pageerror', issues.onPageError)
  page.on('requestfailed', issues.onRequestFailed)
  await page.addInitScript(() => {
    const target = window as typeof window & {
      __e2eUnhandledRejections?: string[]
      __e2eUnhandledRejectionHandler?: (event: PromiseRejectionEvent) => void
    }
    target.__e2eUnhandledRejections = []
    target.__e2eUnhandledRejectionHandler = (event) => {
      const reason = event.reason
      target.__e2eUnhandledRejections!.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason))
    }
    window.addEventListener('unhandledrejection', target.__e2eUnhandledRejectionHandler)
  })
})

test.afterEach(async ({ page }, testInfo) => {
  const issues = runtimeIssues.get(page)
  if (!issues) return
  page.off('console', issues.onConsole)
  page.off('pageerror', issues.onPageError)
  page.off('requestfailed', issues.onRequestFailed)
  const unhandled = await page.evaluate(() => {
    const target = window as typeof window & {
      __e2eUnhandledRejections?: string[]
      __e2eUnhandledRejectionHandler?: (event: PromiseRejectionEvent) => void
    }
    if (target.__e2eUnhandledRejectionHandler) {
      window.removeEventListener('unhandledrejection', target.__e2eUnhandledRejectionHandler)
    }
    return [...(target.__e2eUnhandledRejections ?? [])]
  }).catch(() => [])
  const cancellationAllowsStationAbort = testInfo.annotations.some(({ type }) => type === 'allow-station-abort')
  const unexpectedRequests = issues.requests.filter((entry) => !(
    cancellationAllowsStationAbort
      && entry.includes('/v1/station-day')
      && /AbortError|ERR_ABORTED/.test(entry)
  ))
  expect(issues.console, 'console errors and warnings').toEqual([])
  expect(issues.page, 'page errors').toEqual([])
  expect(unhandled, 'unhandled promise rejections').toEqual([])
  expect(unexpectedRequests, 'unexpected failed requests').toEqual([])
})

function stationRows(date: string) {
  const dayIndex = Number(date.slice(-2)) - 1
  return Array.from({ length: 24 }, (_, hour) => {
    const row: Record<string, string | number> = {
      timestamp: `${date} ${String(hour).padStart(2, '0')}:00:00`,
      SO2: 10 + dayIndex,
      NO2: 20 + hour,
      O3: 30 + hour,
      CO: 0.5,
      PM10: 40 + hour,
      'PM2.5': 25 + hour,
    }
    if (date === '2024-11-02' && hour === 5) delete row['PM2.5']
    if (date === '2024-11-03' && hour === 2) {
      for (const pollutant of ['SO2', 'NO2', 'O3', 'CO', 'PM10', 'PM2.5']) row[pollutant] = 0
    }
    return row
  })
}

async function installStationApi(page: Page, options: StationApiOptions = {}) {
  const requests: string[] = []
  await page.route('**/v1/station-day?*', async (route) => {
    const url = new URL(route.request().url())
    requests.push(url.toString())
    if (options.delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs))
    const date = url.searchParams.get('date') ?? ''
    const stationId = url.searchParams.get('station') ?? ''
    const rows = stationRows(date)
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        date,
        stationId,
        sourceFilename: `china_sites_${date.replaceAll('-', '')}.csv`,
        rows,
        allRows: rows.map(({ timestamp, ...values }) => ({
          timestamp,
          values: { ...values, AQI: 80, SO2_24h: 15 },
        })),
        warnings: [],
        warningTotal: 0,
      }),
    }).catch(() => undefined)
  })
  return requests
}

const WORKER_GATES = ['stationCsv.worker', 'userWorkbook.worker', 'qcWorkbook.worker', 'resultZip.worker'] as const
type WorkerGateName = typeof WORKER_GATES[number]

async function installWorkerMessageGates(page: Page) {
  await page.addInitScript((gateNames) => {
    type ListenerRecord = { listener: EventListenerOrEventListenerObject; once: boolean }
    type GateInstance = { release(): void }
    type GateState = Record<string, { created: number; arrived: number; delivered: number; waiting: number; terminated: number }>
    const target = window as typeof window & {
      __workerGateControl?: {
        state: GateState
        arm(name: string): void
        release(name: string): void
      }
    }
    const state: GateState = Object.fromEntries(gateNames.map((name) => [name, {
      created: 0, arrived: 0, delivered: 0, waiting: 0, terminated: 0,
    }]))
    const gates = Object.fromEntries(gateNames.map((name) => [name, {
      released: false,
      instances: new Set<GateInstance>(),
    }])) as Record<string, { released: boolean; instances: Set<GateInstance> }>
    target.__workerGateControl = {
      state,
      arm(name) {
        const gate = gates[name]
        if (!gate) throw new Error(`Unknown worker gate: ${name}`)
        gate.released = false
      },
      release(name) {
        const gate = gates[name]
        if (!gate) throw new Error(`Unknown worker gate: ${name}`)
        gate.released = true
        for (const instance of [...gate.instances]) instance.release()
      },
    }

    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args: ConstructorParameters<typeof Worker>) {
        const worker = new Target(...args)
        const name = gateNames.find((candidate) => String(args[0]).includes(candidate))
        if (!name) return worker
        const gate = gates[name]
        const evidence = state[name]
        evidence.created += 1
        const nativeAdd = worker.addEventListener.bind(worker)
        const nativeRemove = worker.removeEventListener.bind(worker)
        const nativeTerminate = worker.terminate.bind(worker)
        const listeners = new Set<ListenerRecord>()
        const waiting: MessageEvent[] = []
        let appOnMessage: ((this: Worker, event: MessageEvent) => unknown) | null = null
        let terminated = false

        const deliver = (event: MessageEvent) => {
          if (terminated) return
          evidence.delivered += 1
          appOnMessage?.call(worker, event)
          for (const record of [...listeners]) {
            if (typeof record.listener === 'function') record.listener.call(worker, event)
            else record.listener.handleEvent(event)
            if (record.once) listeners.delete(record)
          }
        }
        const instance: GateInstance = {
          release() {
            while (!terminated && waiting.length > 0) {
              const event = waiting.shift()!
              evidence.waiting -= 1
              deliver(event)
            }
          },
        }
        gate.instances.add(instance)
        nativeAdd('message', ((event: MessageEvent) => {
          evidence.arrived += 1
          if (gate.released) deliver(event)
          else {
            waiting.push(event)
            evidence.waiting += 1
          }
        }) as EventListener)
        Object.defineProperty(worker, 'onmessage', {
          configurable: true,
          get: () => appOnMessage,
          set: (value) => { appOnMessage = typeof value === 'function' ? value : null },
        })
        worker.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
          if (type === 'message' && listener) {
            listeners.add({ listener, once: typeof options === 'object' && options.once === true })
            return
          }
          nativeAdd(type, listener as EventListener, options)
        }) as Worker['addEventListener']
        worker.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
          if (type === 'message' && listener) {
            for (const record of listeners) if (record.listener === listener) listeners.delete(record)
            return
          }
          nativeRemove(type, listener as EventListener, options)
        }) as Worker['removeEventListener']
        worker.terminate = () => {
          if (terminated) return
          terminated = true
          evidence.waiting -= waiting.length
          waiting.length = 0
          evidence.terminated += 1
          gate.instances.delete(instance)
          nativeTerminate()
        }
        return worker
      },
    })
  }, [...WORKER_GATES])
}

async function waitForWorkerMessage(page: Page, name: WorkerGateName, arrived: number) {
  await expect.poll(() => page.evaluate(({ workerName, minimum }) => {
    const target = window as typeof window & { __workerGateControl?: { state: Record<string, { arrived: number }> } }
    return (target.__workerGateControl?.state[workerName]?.arrived ?? 0) >= minimum
  }, { workerName: name, minimum: arrived })).toBe(true)
}

async function setWorkerGate(page: Page, action: 'arm' | 'release', name: WorkerGateName) {
  await page.evaluate(({ gateAction, workerName }) => {
    const target = window as typeof window & { __workerGateControl?: { arm(name: string): void; release(name: string): void } }
    target.__workerGateControl?.[gateAction](workerName)
  }, { gateAction: action, workerName: name })
}

async function open(page: Page) {
  await page.goto('./')
}

function rail(page: Page) {
  return page.getByRole('navigation', { name: '处理步骤' })
}

async function goToStep(page: Page, label: typeof STEP_LABELS[number]) {
  await rail(page).getByRole('button', { name: new RegExp(`${label}$`) }).click()
}

function metric(page: Page, label: string) {
  return page.locator('.metric-list div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
}

async function readDownload(download: Download) {
  const path = await download.path()
  expect(path).not.toBeNull()
  expect((await stat(path!)).size).toBeGreaterThan(0)
  return readFile(path!)
}

async function onlineStationSeries(page: Page, endDate = END_DATE) {
  await page.getByRole('button', { name: '站点直连下载' }).click()
  await page.getByLabel('开始日期').fill(START_DATE)
  await page.getByLabel('结束日期').fill(endDate)
  await page.getByLabel('站点编号').fill(STATION_ID)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载并使用站点数据' }).click()
  await downloadPromise
  await expect(page.getByText('已准备 1 个站点文件')).toBeVisible()
  await goToStep(page, '构建逐时序列')
  await page.locator('.active-panel').getByRole('button', { name: '构建逐时序列', exact: true }).click()
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${START_DATE}T00:00:00Z`)) / 86_400_000) + 1
  await expect(page.getByText(`当前序列 ${days * 24} 行`)).toBeVisible()
}

async function runStationQc(page: Page) {
  await goToStep(page, '数据质控')
  await page.getByRole('radio', { name: '站点数据质控' }).check()
  await page.getByRole('button', { name: '运行当前质控' }).click()
  await expect(page.getByRole('region', { name: '站点质控结果' })).toBeVisible()
}

async function supplyUserData(page: Page, fixture: string) {
  await page.getByRole('radio', { name: '用户数据合并质控' }).check()
  await page.getByLabel('选择 CSV 或 XLSX 文件').setInputFiles(fixture)
}

async function applyAmbiguousUserMapping(page: Page, beforeApply?: () => Promise<void>) {
  const mapping = page.getByRole('group', { name: '字段映射' })
  await expect(mapping).toBeVisible()
  const time = mapping.getByLabel('时间列')
  await time.focus()
  await time.press('ArrowDown')
  await time.press('Enter')
  await expect(time).toHaveValue('0')
  const temperature = mapping.getByLabel('选择变量 Temperature')
  await temperature.focus()
  await temperature.press('Space')
  const nonNegativeTemperature = mapping.getByLabel('非负 Temperature')
  await nonNegativeTemperature.focus()
  await nonNegativeTemperature.press('Space')
  const tracer = mapping.getByLabel('选择变量 Tracer')
  await tracer.focus()
  await tracer.press('Space')
  const apply = mapping.getByRole('button', { name: '应用字段映射' })
  await apply.focus()
  if (beforeApply) await beforeApply()
  await apply.press('Enter')
}

function qcCount(result: Locator, label: string) {
  return result.locator('dt').filter({ hasText: label }).locator('..').locator('dd')
}

test('online station workflow uses the same-origin API, downloads exact CSV, and directly builds 72 parsed rows', async ({ page }) => {
  const requests = await installStationApi(page)
  await open(page)
  await page.getByRole('button', { name: '站点直连下载' }).click()
  await page.getByLabel('开始日期').fill(START_DATE)
  await page.getByLabel('结束日期').fill(END_DATE)
  await page.getByLabel('站点编号').fill(STATION_ID)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载并使用站点数据' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('3329A_20241101_20241103.csv')
  const csv = (await readDownload(download)).toString('utf8')
  expect(csv.startsWith('\uFEFFstation_id,timestamp,SO2(μg/m³)')).toBe(true)
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  expect(lines).toHaveLength(73)
  expect(lines[0]).toContain(',AQI,SO2_24h')
  expect(lines[1]).toBe('3329A,2024-11-01 00:00:00,10,20,30,0.5,40,25,80,15')
  expect(lines.at(-1)).toBe('3329A,2024-11-03 23:00:00,12,43,53,0.5,63,48,80,15')

  const expected = ['2024-11-01', '2024-11-02', '2024-11-03'].map((date) =>
    `http://127.0.0.1:4173/aerosol-data-workbench/v1/station-day?date=${date}&station=3329A`,
  )
  await expect.poll(() => requests.length).toBe(3)
  expect([...requests].sort()).toEqual(expected)

  await goToStep(page, '构建逐时序列')
  await page.locator('.active-panel').getByRole('button', { name: '构建逐时序列', exact: true }).click()
  await expect(page.getByText('当前序列 72 行')).toBeVisible()
  await expect(metric(page, '源记录')).toHaveText('72')
  await expect(metric(page, '逐时序列')).toHaveText('72')
  await expect(page.getByRole('list', { name: '已选择文件' })).toHaveCount(0)
})

test('online raw links need only a date range and produce exact public URLs', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: '生成公开链接' }).click()
  await expect(page.getByLabel('站点编号')).toHaveCount(0)
  await page.getByLabel('开始日期').fill(START_DATE)
  await page.getByLabel('结束日期').fill(END_DATE)
  await page.getByRole('button', { name: '生成下载链接', exact: true }).click()
  for (const date of ['20241101', '20241102', '20241103']) {
    await expect(page.getByRole('link', { name: `china_sites_${date}.csv` })).toHaveAttribute(
      'href', `https://quotsoft.net/air/data/china_sites_${date}.csv`,
    )
  }
})

test('local national daily and extracted station-wide inputs auto-parse without a second action', async ({ page }) => {
  const workerUrls: string[] = []
  page.on('worker', (worker) => workerUrls.push(worker.url()))
  await open(page)
  await page.getByRole('button', { name: '本地导入 CSV' }).click()
  const first = await readFile(NATIONAL_FIXTURE)
  const second = first.toString('utf8').replaceAll('20241101', '20241102').replace(/,0,/g, ',23,')
  await page.getByLabel('选择 CSV 文件').setInputFiles([
    { name: 'china_sites_20241101.csv', mimeType: 'text/csv', buffer: first },
    { name: 'china_sites_20241102.csv', mimeType: 'text/csv', buffer: Buffer.from(second) },
  ])
  await expect(page.getByText('已准备 2 个站点文件')).toBeVisible()
  await expect(page.getByRole('button', { name: /解析|提取/ })).toHaveCount(0)
  await goToStep(page, '构建逐时序列')
  await page.locator('.active-panel').getByRole('button', { name: '构建逐时序列', exact: true }).click()
  await expect(page.getByText('当前序列 48 行')).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: '本地导入 CSV' }).click()
  const wide = [
    '\uFEFFstation_id,timestamp,SO2(μg/m³),NO2(μg/m³),O3(μg/m³),CO(mg/m³),PM10(μg/m³),PM2.5(μg/m³)',
    '3329A,2024-11-01 00:00:00,1,2,3,0.4,5,6',
    '3329A,2024-11-01 23:00:00,7,8,9,1,11,12',
  ].join('\r\n') + '\r\n'
  await page.getByLabel('选择 CSV 文件').setInputFiles({
    name: '3329A_20241101_20241101.csv', mimeType: 'text/csv', buffer: Buffer.from(wide),
  })
  await expect(page.getByText('已准备 1 个站点文件')).toBeVisible()
  await goToStep(page, '构建逐时序列')
  await page.locator('.active-panel').getByRole('button', { name: '构建逐时序列', exact: true }).click()
  await expect(page.getByText('当前序列 24 行')).toBeVisible()
  expect(workerUrls.filter((url) => url.includes('stationCsv.worker')).length).toBeGreaterThanOrEqual(3)
})

test('station-only QC needs no user or ion input and reports exact flags and counts', async ({ page }) => {
  await installStationApi(page)
  await open(page)
  await onlineStationSeries(page)
  await runStationQc(page)
  const result = page.getByRole('region', { name: '站点质控结果' })
  await expect(qcCount(result, '保留')).toHaveText('70')
  await expect(qcCount(result, '剔除')).toHaveText('2')
  await expect(page.getByLabel('选择 CSV 或 XLSX 文件')).toHaveCount(0)
  await expect(page.getByLabel('选择 XLSX 文件')).toHaveCount(0)
  await goToStep(page, '导出结果')
  await page.getByRole('button', { name: '生成站点质控导出文件' }).click()
  const csvPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 站点数据_质控结果.csv' }).click()
  const csv = (await readDownload(await csvPromise)).toString('utf8')
  expect(csv).toContain('缺失：PM2.5 (μg/m³)')
  expect(csv).toContain('六项污染物同时为0')
})

test('merged CSV auto-maps in the genuine user worker and honors negative-variable semantics', async ({ page }) => {
  const workerUrls: string[] = []
  page.on('worker', (worker) => workerUrls.push(worker.url()))
  await installStationApi(page)
  await open(page)
  await onlineStationSeries(page)
  await goToStep(page, '数据质控')
  await supplyUserData(page, USER_CSV_FIXTURE)
  await expect(page.getByText('用户数据已准备：3 行')).toBeVisible()
  await expect(page.getByRole('group', { name: '字段映射' })).toHaveCount(0)
  await page.getByRole('button', { name: '运行当前质控' }).click()
  const result = page.getByRole('region', { name: '合并质控结果' })
  await expect(qcCount(result, '保留')).toHaveText('2')
  await expect(qcCount(result, '剔除')).toHaveText('70')
  await goToStep(page, '导出结果')
  await page.getByRole('button', { name: '生成合并质控导出文件' }).click()
  const csvPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 合并数据_质控结果.csv' }).click()
  const csv = (await readDownload(await csvPromise)).toString('utf8')
  const negativeRow = csv.split(/\r?\n/).find((line) => line.includes('2024-11-01 01:00:00')) ?? ''
  expect(negativeRow).toContain('负值：Tracer')
  expect(negativeRow).not.toContain('负值：Temperature')
  expect(workerUrls.some((url) => url.includes('userWorkbook.worker'))).toBe(true)
})

test('merged XLSX ambiguity is resolved entirely by keyboard mapping', async ({ page }) => {
  const workerUrls: string[] = []
  page.on('worker', (worker) => workerUrls.push(worker.url()))
  await installStationApi(page)
  await open(page)
  await onlineStationSeries(page)
  await goToStep(page, '数据质控')
  await supplyUserData(page, USER_XLSX_FIXTURE)
  await applyAmbiguousUserMapping(page)
  await expect(page.getByText('用户数据已准备：2 行')).toBeVisible()
  await page.getByRole('button', { name: '运行当前质控' }).click()
  const result = page.getByRole('region', { name: '合并质控结果' })
  await expect(qcCount(result, '保留')).toHaveText('2')
  await expect(qcCount(result, '剔除')).toHaveText('70')
  expect(workerUrls.filter((url) => url.includes('userWorkbook.worker')).length).toBeGreaterThanOrEqual(2)
})

test('causal worker gates prove real parsing and export before combined workbook inspection', async ({ page }) => {
  const workerUrls: string[] = []
  page.on('worker', (worker) => workerUrls.push(worker.url()))
  await installWorkerMessageGates(page)
  await installStationApi(page)
  await open(page)

  await page.getByRole('button', { name: '本地导入 CSV' }).click()
  await page.getByLabel('选择 CSV 文件').setInputFiles({
    name: 'china_sites_20241101.csv', mimeType: 'text/csv', buffer: await readFile(NATIONAL_FIXTURE),
  })
  await waitForWorkerMessage(page, 'stationCsv.worker', 1)
  await expect(page.getByText('已准备 1 个站点文件')).toHaveCount(0)
  await expect(metric(page, '源记录')).toHaveText('0')
  await setWorkerGate(page, 'release', 'stationCsv.worker')
  await expect(page.getByText('已准备 1 个站点文件')).toBeVisible()
  await expect(metric(page, '源记录')).toHaveText('1')

  await onlineStationSeries(page)
  await runStationQc(page)
  await goToStep(page, '导出结果')
  const stationGroup = page.getByRole('region', { name: '站点质控结果文件' })
  await page.getByRole('button', { name: '生成站点质控导出文件' }).click()
  await waitForWorkerMessage(page, 'qcWorkbook.worker', 1)
  await expect(stationGroup).toHaveCount(0)
  await setWorkerGate(page, 'release', 'qcWorkbook.worker')
  await waitForWorkerMessage(page, 'resultZip.worker', 1)
  await expect(stationGroup).toHaveCount(0)
  await setWorkerGate(page, 'release', 'resultZip.worker')
  await expect(stationGroup).toBeVisible()

  await goToStep(page, '数据质控')
  await supplyUserData(page, USER_CSV_FIXTURE)
  await waitForWorkerMessage(page, 'userWorkbook.worker', 1)
  await expect(page.getByText('用户数据已准备：3 行')).toHaveCount(0)
  await setWorkerGate(page, 'release', 'userWorkbook.worker')
  await expect(page.getByText('用户数据已准备：3 行')).toBeVisible()

  await setWorkerGate(page, 'arm', 'userWorkbook.worker')
  await supplyUserData(page, USER_XLSX_FIXTURE)
  await waitForWorkerMessage(page, 'userWorkbook.worker', 2)
  await expect(page.getByRole('group', { name: '字段映射' })).toHaveCount(0)
  await setWorkerGate(page, 'release', 'userWorkbook.worker')
  await applyAmbiguousUserMapping(page, async () => setWorkerGate(page, 'arm', 'userWorkbook.worker'))
  await waitForWorkerMessage(page, 'userWorkbook.worker', 3)
  await expect(page.getByText('用户数据已准备：2 行')).toHaveCount(0)
  await setWorkerGate(page, 'release', 'userWorkbook.worker')
  await expect(page.getByText('用户数据已准备：2 行')).toBeVisible()

  await setWorkerGate(page, 'arm', 'userWorkbook.worker')
  await supplyUserData(page, USER_CSV_FIXTURE)
  await waitForWorkerMessage(page, 'userWorkbook.worker', 4)
  await expect(page.getByText('用户数据已准备：3 行')).toHaveCount(0)
  await setWorkerGate(page, 'release', 'userWorkbook.worker')
  await expect(page.getByText('用户数据已准备：3 行')).toBeVisible()
  await page.getByRole('button', { name: '运行当前质控' }).click()
  await goToStep(page, '导出结果')
  await setWorkerGate(page, 'arm', 'qcWorkbook.worker')
  await setWorkerGate(page, 'arm', 'resultZip.worker')
  const mergedGroup = page.getByRole('region', { name: '合并质控结果文件' })
  await page.getByRole('button', { name: '生成合并质控导出文件' }).click()
  await waitForWorkerMessage(page, 'qcWorkbook.worker', 2)
  await expect(mergedGroup).toHaveCount(0)
  await setWorkerGate(page, 'release', 'qcWorkbook.worker')
  await waitForWorkerMessage(page, 'resultZip.worker', 2)
  await expect(mergedGroup).toHaveCount(0)
  await setWorkerGate(page, 'release', 'resultZip.worker')
  await expect(mergedGroup).toBeVisible()
  await expect(stationGroup).toBeVisible()

  const stationDownloadPromise = page.waitForEvent('download')
  await stationGroup.getByRole('button', { name: '下载 站点数据_质控结果.zip' }).click()
  const stationZip = await JSZip.loadAsync(await readDownload(await stationDownloadPromise))
  expect(Object.keys(stationZip.files).sort()).toEqual([
    '站点数据_处理日志.json', '站点数据_时间缺口.csv', '站点数据_质控报告.xlsx',
    '站点数据_质控汇总.csv', '站点数据_质控结果.csv',
  ])
  expect(await stationZip.file('站点数据_质控结果.csv')!.async('string')).toContain(
    '2024-11-01 00:00:00,10,20,30,0.5,40,25',
  )
  const stationWorkbook = await stationZip.file('站点数据_质控报告.xlsx')!.async('nodebuffer')
  const stationSheets = await readXlsxFile(stationWorkbook)
  expect(stationSheets.map(({ sheet }) => sheet)).toEqual([
    '站点质控结果', '质控保留', '质控异常', '时间缺口', '质控汇总', '处理日志',
  ])
  const stationAll = stationSheets.find(({ sheet }) => sheet === '站点质控结果')!.data
  expect(stationAll).toHaveLength(73)
  expect(stationAll[0]).toEqual([
    '时间', 'SO2 (µg/m³)', 'NO2 (µg/m³)', 'O3 (µg/m³)', 'CO (mg/m³)',
    'PM10 (µg/m³)', 'PM2.5 (µg/m³)', '缺测项目', '数据状态', 'QC标记', 'QC详情', 'QC保留',
  ])
  expect(stationAll[1]).toEqual([
    '2024-11-01 00:00:00', 10, 20, 30, 0.5, 40, 25, null, '完整', '正常', '[]', true,
  ])
  expect(stationSheets.find(({ sheet }) => sheet === '质控保留')!.data).toHaveLength(71)
  expect(stationSheets.find(({ sheet }) => sheet === '质控异常')!.data).toHaveLength(3)
  expect(stationSheets.find(({ sheet }) => sheet === '质控汇总')!.data).toEqual(expect.arrayContaining([
    ['正常', 70], ['缺失：PM2.5 (μg/m³)', 1], ['六项污染物同时为0', 1],
  ]))

  const mergedDownloadPromise = page.waitForEvent('download')
  await mergedGroup.getByRole('button', { name: '下载 合并数据_质控结果.zip' }).click()
  const mergedZip = await JSZip.loadAsync(await readDownload(await mergedDownloadPromise))
  expect(Object.keys(mergedZip.files).sort()).toEqual([
    '合并数据_变量说明.csv', '合并数据_处理日志.json', '合并数据_映射说明.csv',
    '合并数据_未匹配时间.csv', '合并数据_质控报告.xlsx', '合并数据_质控汇总.csv', '合并数据_质控结果.csv',
  ])
  const mergedCsv = await mergedZip.file('合并数据_质控结果.csv')!.async('string')
  expect(mergedCsv).toContain('2024-11-01 00:00:00,10,20,30,0.5,40,25,,完整,-5,1')
  expect(mergedCsv).toContain('2024-11-01 01:00:00,10,21,31,0.5,41,26,,完整,-4,-2')
  const mergedWorkbook = await mergedZip.file('合并数据_质控报告.xlsx')!.async('nodebuffer')
  const mergedSheets = await readXlsxFile(mergedWorkbook)
  expect(mergedSheets.map(({ sheet }) => sheet)).toEqual([
    '合并质控结果', '质控保留', '质控异常', '未匹配时间', '变量说明', '映射说明', '质控汇总', '处理日志',
  ])
  const mergedAll = mergedSheets.find(({ sheet }) => sheet === '合并质控结果')!.data
  expect(mergedAll).toHaveLength(73)
  expect(mergedAll[0]).toEqual([
    '时间', 'SO2 (µg/m³)', 'NO2 (µg/m³)', 'O3 (µg/m³)', 'CO (mg/m³)',
    'PM10 (µg/m³)', 'PM2.5 (µg/m³)', '缺测项目', '数据状态', 'Temperature', 'Tracer',
    'QC标记', 'QC详情', 'QC保留',
  ])
  expect(mergedAll[1]).toEqual([
    '2024-11-01 00:00:00', 10, 20, 30, 0.5, 40, 25, null, '完整', -5, 1, '正常', '[]', true,
  ])
  expect(mergedAll[2]?.slice(0, 11)).toEqual([
    '2024-11-01 01:00:00', 10, 21, 31, 0.5, 41, 26, null, '完整', -4, -2,
  ])
  expect(mergedAll[2]?.[11]).toBe('负值：Tracer')
  expect(mergedAll[2]?.[13]).toBe(false)
  expect(mergedSheets.find(({ sheet }) => sheet === '质控保留')!.data).toHaveLength(3)
  expect(mergedSheets.find(({ sheet }) => sheet === '质控异常')!.data).toHaveLength(71)
  expect(mergedSheets.find(({ sheet }) => sheet === '变量说明')!.data).toEqual([
    ['key', 'label', 'unit', 'nonNegative', 'sourceColumn'],
    ['temperature', 'Temperature', null, false, 1],
    ['tracer', 'Tracer', null, true, 2],
  ])
  expect(mergedSheets.find(({ sheet }) => sheet === '质控汇总')!.data).toEqual(expect.arrayContaining([
    ['正常', 2], ['负值：Tracer', 1], ['缺失：Temperature', 69], ['缺失：Tracer', 69],
  ]))

  await setWorkerGate(page, 'arm', 'resultZip.worker')
  const combinedPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载全部结果' }).click()
  await waitForWorkerMessage(page, 'resultZip.worker', 3)
  await expect(page.getByRole('button', { name: '下载全部结果' })).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByText('正在打包全部结果')).toBeVisible()
  await setWorkerGate(page, 'release', 'resultZip.worker')
  const combinedDownload = await combinedPromise
  expect(combinedDownload.suggestedFilename()).toBe('全部数据_质控结果.zip')
  const combined = await JSZip.loadAsync(await readDownload(combinedDownload))
  const combinedNames = Object.keys(combined.files).filter((name) => !combined.files[name].dir).sort()
  expect(combinedNames).toHaveLength(12)
  expect(combinedNames.every((name) => name.startsWith('station-qc/') || name.startsWith('merged-qc/'))).toBe(true)
  expect(await combined.file('merged-qc/合并数据_质控结果.csv')!.async('string')).toContain('Temperature,Tracer')
  const nestedStationWorkbook = await combined.file('station-qc/站点数据_质控报告.xlsx')!.async('nodebuffer')
  const nestedMergedWorkbook = await combined.file('merged-qc/合并数据_质控报告.xlsx')!.async('nodebuffer')
  expect(nestedStationWorkbook.equals(stationWorkbook)).toBe(true)
  expect(nestedMergedWorkbook.equals(mergedWorkbook)).toBe(true)
  const nestedStationSheets = await readXlsxFile(nestedStationWorkbook)
  const nestedMergedSheets = await readXlsxFile(nestedMergedWorkbook)
  expect(nestedStationSheets.map(({ sheet }) => sheet)).toEqual(stationSheets.map(({ sheet }) => sheet))
  expect(nestedMergedSheets.map(({ sheet }) => sheet)).toEqual(mergedSheets.map(({ sheet }) => sheet))
  expect(nestedStationSheets[0]?.data[1]).toEqual(stationAll[1])
  expect(nestedMergedSheets[0]?.data[1]).toEqual(mergedAll[1])
  expect(nestedStationSheets.find(({ sheet }) => sheet === '质控汇总')!.data).toEqual(
    stationSheets.find(({ sheet }) => sheet === '质控汇总')!.data,
  )
  expect(nestedMergedSheets.find(({ sheet }) => sheet === '质控汇总')!.data).toEqual(
    mergedSheets.find(({ sheet }) => sheet === '质控汇总')!.data,
  )

  const gateEvidence = await page.evaluate(() => {
    const target = window as typeof window & {
      __workerGateControl?: { state: Record<string, { created: number; arrived: number; delivered: number; waiting: number; terminated: number }> }
    }
    return target.__workerGateControl?.state
  })
  for (const workerName of WORKER_GATES) {
    expect(gateEvidence?.[workerName].created, `${workerName} should be constructed`).toBeGreaterThan(0)
    expect(gateEvidence?.[workerName].arrived, `${workerName} should produce a genuine response`).toBeGreaterThan(0)
    expect(gateEvidence?.[workerName].delivered).toBe(gateEvidence?.[workerName].arrived)
    expect(gateEvidence?.[workerName].waiting).toBe(0)
    expect(gateEvidence?.[workerName].terminated).toBe(gateEvidence?.[workerName].created)
  }

  for (const workerName of ['userWorkbook.worker', 'qcWorkbook.worker', 'resultZip.worker']) {
    expect(workerUrls.some((url) => url.includes(workerName)), `${workerName} should execute`).toBe(true)
  }
})

test('run-all resumes after completed work, skips re-parsing, and source switching invalidates results', async ({ page }) => {
  const workerUrls: string[] = []
  page.on('worker', (worker) => workerUrls.push(worker.url()))
  await open(page)
  await page.getByRole('button', { name: '本地导入 CSV' }).click()
  await page.getByLabel('选择 CSV 文件').setInputFiles({
    name: 'china_sites_20241101.csv', mimeType: 'text/csv', buffer: await readFile(NATIONAL_FIXTURE),
  })
  await expect(page.getByText('已准备 1 个站点文件')).toBeVisible()
  const stationWorkersAfterParse = workerUrls.filter((url) => url.includes('stationCsv.worker')).length
  expect(stationWorkersAfterParse).toBe(1)
  await page.getByRole('button', { name: '从当前步骤继续' }).click()
  await expect(page.locator('.status-live')).toHaveText('全部处理完成', { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: '导出结果' })).toBeVisible()
  expect(workerUrls.filter((url) => url.includes('stationCsv.worker'))).toHaveLength(stationWorkersAfterParse)
  await expect(page.getByRole('region', { name: '站点质控结果文件' })).toBeVisible()

  await goToStep(page, '数据质控')
  await supplyUserData(page, USER_CSV_FIXTURE)
  await expect(page.getByText('用户数据已准备：3 行')).toBeVisible()
  await page.getByRole('button', { name: '从当前步骤继续' }).click()
  await expect(page.locator('.status-live')).toHaveText('全部处理完成', { timeout: 30_000 })
  await expect(page.getByRole('region', { name: '合并质控结果文件' })).toBeVisible()
  await expect(page.getByRole('region', { name: '站点质控结果文件' })).toBeVisible()
  expect(workerUrls.filter((url) => url.includes('stationCsv.worker'))).toHaveLength(stationWorkersAfterParse)

  await goToStep(page, '获取或导入数据')
  await page.getByRole('button', { name: '生成公开链接' }).click()
  for (const label of ['源记录', '逐时序列', '站点质控', '合并质控']) await expect(metric(page, label)).toHaveText('0')
  await goToStep(page, '导出结果')
  await expect(page.getByRole('region', { name: /质控结果文件/ })).toHaveCount(0)
})

test('cancellation physically terminates a worker and aborts fetch with no late progress or artifact', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Cancellation timing is intentionally desktop-only.')
  testInfo.annotations.push({ type: 'allow-station-abort' })
  await page.addInitScript(() => {
    const target = window as typeof window & {
      __abortEvidence?: { stationWorkers: number; stationTerminations: number; fetchStarts: number; fetchAborts: number }
    }
    target.__abortEvidence = { stationWorkers: 0, stationTerminations: 0, fetchStarts: 0, fetchAborts: 0 }
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args: ConstructorParameters<typeof Worker>) {
        const worker = new Target(...args)
        if (String(args[0]).includes('stationCsv.worker')) {
          target.__abortEvidence!.stationWorkers += 1
          const nativePostMessage = worker.postMessage.bind(worker)
          const nativeTerminate = worker.terminate.bind(worker)
          let terminated = false
          worker.postMessage = ((message: unknown, transfer?: Transferable[]) => {
            window.setTimeout(() => {
              if (terminated) return
              if (transfer) nativePostMessage(message, transfer)
              else nativePostMessage(message)
            }, 1_000)
          }) as Worker['postMessage']
          worker.terminate = () => {
            if (terminated) return
            terminated = true
            target.__abortEvidence!.stationTerminations += 1
            nativeTerminate()
          }
        }
        return worker
      },
    })
    const nativeFetch = window.fetch.bind(window)
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/v1/station-day')) {
        target.__abortEvidence!.fetchStarts += 1
        init?.signal?.addEventListener('abort', () => { target.__abortEvidence!.fetchAborts += 1 }, { once: true })
      }
      return nativeFetch(input, init)
    }) as typeof window.fetch
  })
  await installStationApi(page, { delayMs: 1_500 })
  await open(page)
  await page.getByRole('button', { name: '本地导入 CSV' }).click()
  await page.getByLabel('选择 CSV 文件').setInputFiles({
    name: 'china_sites_20241101.csv', mimeType: 'text/csv', buffer: await readFile(NATIONAL_FIXTURE),
  })
  await expect(page.getByRole('button', { name: '取消处理' })).toBeVisible()
  await page.getByRole('button', { name: '取消处理' }).press('Enter')
  await expect(page.locator('.status-live')).toContainText('处理已取消')
  await page.waitForTimeout(1_100)
  await expect(page.getByText(/已准备 .*个站点文件/)).toHaveCount(0)
  expect(await page.evaluate(() => (window as typeof window & { __abortEvidence?: object }).__abortEvidence)).toMatchObject({
    stationWorkers: 1, stationTerminations: 1,
  })

  await page.getByRole('button', { name: '站点直连下载' }).click()
  await page.getByLabel('开始日期').fill(START_DATE)
  await page.getByLabel('结束日期').fill(START_DATE)
  await page.getByLabel('站点编号').fill(STATION_ID)
  await page.getByRole('button', { name: '下载并使用站点数据' }).click()
  await expect(page.getByRole('button', { name: '取消处理' })).toBeVisible()
  await page.getByRole('button', { name: '取消处理' }).click()
  const cancelledProgress = await page.getByRole('progressbar', { name: '处理进度' }).getAttribute('value')
  await page.waitForTimeout(1_700)
  await expect(page.locator('.status-live')).toContainText('处理已取消')
  await expect(page.getByRole('progressbar', { name: '处理进度' })).toHaveAttribute('value', cancelledProgress!)
  await expect(page.getByText(/已准备 .*个站点文件/)).toHaveCount(0)
  await goToStep(page, '导出结果')
  await expect(page.getByRole('region', { name: /质控结果文件/ })).toHaveCount(0)
  expect(await page.evaluate(() => (window as typeof window & { __abortEvidence?: object }).__abortEvidence)).toMatchObject({
    fetchStarts: 1, fetchAborts: 1,
  })
})

test('four hero stages are clickable and focused with static motion-safe responsive layout', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page)
  await expect(page.getByText('江峰课题组', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: /让不可见的\s*大气过程可分析/ })).toBeVisible()
  await expect(page.getByText('大气气溶胶数据工作台')).toHaveCount(0)
  await expect(page.getByText('安徽理工大学课题组')).toHaveCount(0)
  const heroNav = page.getByRole('navigation', { name: '快速进入处理阶段' })
  await expect(heroNav.getByRole('button')).toHaveCount(4)
  await heroNav.getByRole('button', { name: '导出结果', exact: true }).click()
  for (const label of STEP_LABELS) {
    const button = heroNav.getByRole('button', { name: label, exact: true })
    await button.focus()
    await expect(button).toBeFocused()
    await button.press('Enter')
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
    await expect(page.locator('.active-panel')).toBeFocused()
  }
  const image = page.locator('.hero-photo img')
  await expect(image).toHaveAttribute('width', '1672')
  await expect(image).toHaveAttribute('height', '941')
  await expect(image).toHaveAttribute('fetchpriority', 'high')
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.currentSrc)).toMatch(/static-v2-.*\.webp$/)
  await expect(image).toHaveCSS('animation-name', 'none')
  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})
