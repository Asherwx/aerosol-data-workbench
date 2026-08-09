# Dual-Input Continuous Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the link-only/manual-reimport workflow with parallel online-download and local-import entry paths that feed one continuous four-stage pipeline, add independent station-only and merged-data QC modes, and publish the static visual redesign plus a bounded Cloudflare Worker.

**Architecture:** Keep the React application on GitHub Pages and add a small Cloudflare Worker that fetches one public national CSV per request and returns one station-day result. The browser owns date batching, cancellation, aggregation, file download, parsing, continuous-series construction, QC-mode state, and export. Refactor the current fixed five-step hook into four stages with explicit source and QC-mode results; keep expensive CSV/XLSX and export work in Workers.

**Tech Stack:** React 18, TypeScript 5.8, Vite 6, Vitest 3, Playwright, Papa Parse, read-excel-file, write-excel-file, JSZip, Cloudflare Workers, Wrangler 4.120.0.

---

## File responsibility map

### New files

- `worker/wrangler.jsonc` — deployable Worker configuration and non-secret origin/source variables.
- `worker/src/protocol.ts` — validated station-day request and response types shared by the Worker tests.
- `worker/src/stationDay.ts` — pure upstream CSV validation, station extraction, limits, and bounded warnings.
- `worker/src/index.ts` — HTTP/CORS/cache adapter only.
- `src/core/extractedStationCsv.ts` — station-wide CSV serialization and parsing.
- `src/core/onlineStationDownload.ts` — bounded browser batching, cancellation, aggregation, and progress.
- `src/core/userDataset.ts` — canonical user-data rows, variable metadata, mapping validation, and CSV matrix parsing.
- `src/core/userWorkbook.ts` — safe XLSX Worker client for generic user datasets.
- `src/core/userWorkbookProtocol.ts` — compact Worker protocol.
- `src/workers/userWorkbook.worker.ts` — read-excel-file browser Worker entry.
- `src/core/stationQualityControl.ts` — six-station-variable QC wrapper.
- `src/core/dynamicQualityControl.ts` — generic mapped-variable QC and independent result type.
- `src/core/qcModeExports.ts` — station-mode and merged-mode artifact assembly.
- `src/components/DataSourcePanel.tsx` — STEP 01 online/local entry UI.
- `src/components/QcModePanel.tsx` — STEP 03 mode chooser and active mode UI.
- `src/components/ColumnMappingPanel.tsx` — accessible mapping fallback.
- `scripts/build-static-hero-assets.mjs` — deterministic desktop/mobile WebP derivatives.
- `.github/workflows/deploy-worker.yml` — Worker validation and main-only deployment.

### Files to split or modify

- `src/pipeline/pipelineTypes.ts` — move public pipeline types out of the current 500-line hook.
- `src/pipeline/defaultPipelineServices.ts` — hold production service composition and Worker clients.
- `src/pipeline/usePipeline.ts` — orchestration, invalidation, cancellation, and four-stage state only.
- `src/core/hourlyMerge.ts` — merge dynamic user values as a nested record without losing fixed station fields.
- `src/core/qualityControl.ts` — retain compatibility exports while delegating to the new QC engines.
- `src/core/exports.ts`, `src/core/qcWorkbook.ts`, `src/core/exportShared.ts` — mode-aware dynamic columns and separate artifact bundles.
- `src/components/Hero.tsx`, `src/components/Workbench.tsx`, `src/components/StepRail.tsx`, `src/components/InspectionPanel.tsx` — static hero, clickable four-stage navigation, one active panel, and mode summaries.
- `src/app/App.tsx`, `src/app/app.css` — hero-to-workbench step selection and static responsive layout.
- `tests/unit/*`, `e2e/workbench.spec.ts`, `README.md`, `package.json`, `.gitignore`, `scripts/check-public-release.test.mjs` — regression, release, privacy, and deployment coverage.

---

### Task 1: Define the station-day Worker protocol and pure extractor

**Files:**
- Create: `worker/src/protocol.ts`
- Create: `worker/src/stationDay.ts`
- Create: `tests/unit/stationDayWorker.test.ts`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write the failing protocol and extractor tests**

```ts
import { describe, expect, it } from 'vitest'
import { extractStationDay } from '../../worker/src/stationDay'

const csv = '\ufeffdate,hour,type,3329A,2277A\r\n'
  + '20241101,0,SO2,3,9\r\n'
  + '20241101,0,NO2,21,27\r\n'
  + '20241101,0,O3,92,68\r\n'
  + '20241101,0,CO,0.6,0.9\r\n'
  + '20241101,0,PM10,89,80\r\n'
  + '20241101,0,PM2.5,49,51\r\n'

describe('extractStationDay', () => {
  it('returns canonical station rows without changing zeros', () => {
    expect(extractStationDay(csv, '2024-11-01', '3329A')).toMatchObject({
      date: '2024-11-01',
      stationId: '3329A',
      rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 3, NO2: 21, O3: 92, CO: 0.6, PM10: 89, 'PM2.5': 49 }],
    })
  })

  it.each(['', '3329', '3329A<script>'])('rejects invalid station %s', (stationId) => {
    expect(() => extractStationDay(csv, '2024-11-01', stationId)).toThrow(/站点编号/)
  })

  it('rejects filename-date row mismatches and caps warnings', () => {
    const wrong = csv.replaceAll('20241101', '20241102').repeat(30)
    const result = extractStationDay(wrong, '2024-11-01', '3329A')
    expect(result.rows).toEqual([])
    expect(result.warningTotal).toBeGreaterThan(result.warnings.length)
    expect(result.warnings.length).toBeLessThanOrEqual(100)
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/unit/stationDayWorker.test.ts`
Expected: FAIL because `worker/src/stationDay.ts` does not exist.

- [ ] **Step 3: Implement exact protocol types and pure extraction**

```ts
export interface StationDayResponse {
  date: string
  stationId: string
  sourceFilename: string
  rows: HourlyStationRow[]
  warnings: string[]
  warningTotal: number
}

export const STATION_ID_PATTERN = /^[0-9]{4}[A-Z]$/
export const MAX_UPSTREAM_CSV_BYTES = 8 * 1024 * 1024
export const STATION_DAY_WARNING_LIMIT = 100
```

Implement `extractStationDay(text, isoDate, stationId)` with Papa Parse, the same first-finite duplicate policy as `parseStationCsvText`, strict real-calendar dates, integer hours `0..23`, the exact six pollutants, and no network or Worker globals.

- [ ] **Step 4: Run focused and related parser tests**

Run: `npm test -- tests/unit/stationDayWorker.test.ts tests/unit/stationCsv.test.ts`
Expected: PASS; zeros remain numeric zero and all warning arrays are bounded.

- [ ] **Step 5: Commit**

```bash
git add worker/src/protocol.ts worker/src/stationDay.ts src/core/types.ts tests/unit/stationDayWorker.test.ts
git commit -m "feat: extract bounded station-day data"
```

---

### Task 2: Add the Cloudflare Worker HTTP boundary

**Files:**
- Create: `worker/wrangler.jsonc`
- Create: `worker/src/index.ts`
- Create: `tests/unit/stationDayHttp.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add Wrangler and write failing HTTP tests**

Install exactly: `npm install --save-dev wrangler@4.120.0`.

Test a directly importable `worker.fetch(request, env, ctx)` adapter:

```ts
const env = {
  ALLOWED_ORIGINS: 'https://asherwx.github.io,http://127.0.0.1:4173',
  SOURCE_BASE_URL: 'https://quotsoft.net/air/data',
}

it('fetches only the configured source and returns CORS to the Pages origin', async () => {
  const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(sourceCsv, { headers: { 'content-length': String(sourceCsv.length) } }),
  )
  const response = await worker.fetch(
    new Request('https://api.example/v1/station-day?date=2024-11-01&station=3329A', {
      headers: { Origin: 'https://asherwx.github.io' },
    }), env, executionContext,
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBe('https://asherwx.github.io')
  expect(upstream).toHaveBeenCalledWith(
    'https://quotsoft.net/air/data/china_sites_20241101.csv',
    expect.objectContaining({ redirect: 'error' }),
  )
})
```

Cover invalid origin, missing origin, invalid date/station, upstream redirect, declared/streamed oversize, timeout, non-CSV body, upstream 404, OPTIONS, bounded error text, and cache hit.

- [ ] **Step 2: Run the HTTP test and verify RED**

Run: `npm test -- tests/unit/stationDayHttp.test.ts`
Expected: FAIL because the HTTP adapter is missing.

- [ ] **Step 3: Implement the Worker adapter**

Use `AbortSignal.timeout(30_000)`, `redirect: 'error'`, a streamed-byte counter, `caches.default`, and this route shape only:

```ts
if (url.pathname !== '/v1/station-day') return jsonError(404, '接口不存在')
const date = parseIsoDateStrict(url.searchParams.get('date') ?? '')
const station = validateStationId(url.searchParams.get('station') ?? '')
const sourceUrl = `${env.SOURCE_BASE_URL}/china_sites_${formatUtcDate(date)}.csv`
```

Do not accept a source URL from the request. Cache only successful canonical JSON responses for six hours. Return no stack traces.

- [ ] **Step 4: Add Wrangler configuration and scripts**

```jsonc
{
  "$schema": "../node_modules/wrangler/config-schema.json",
  "name": "aerosol-station-data-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-09",
  "workers_dev": true,
  "vars": {
    "SOURCE_BASE_URL": "https://quotsoft.net/air/data",
    "ALLOWED_ORIGINS": "https://asherwx.github.io,http://127.0.0.1:4173,http://localhost:4173"
  }
}
```

Add scripts: `worker:test`, `worker:types`, `worker:dry-run`, `worker:dev`, and `worker:deploy`. Ignore `.wrangler/` and `.dev.vars*`.

- [ ] **Step 5: Verify Worker boundary and bundle**

Run:

```bash
npm test -- tests/unit/stationDayWorker.test.ts tests/unit/stationDayHttp.test.ts
npx wrangler types --config worker/wrangler.jsonc
npx wrangler deploy --dry-run --config worker/wrangler.jsonc
```

Expected: tests PASS; types generate without secrets; dry-run emits one Worker bundle and does not deploy.

- [ ] **Step 6: Commit**

```bash
git add worker package.json package-lock.json .gitignore tests/unit/stationDayHttp.test.ts
git commit -m "feat: add secure station data worker"
```

---

### Task 3: Build the online station downloader and extracted CSV format

**Files:**
- Create: `src/core/extractedStationCsv.ts`
- Create: `src/core/onlineStationDownload.ts`
- Create: `tests/unit/extractedStationCsv.test.ts`
- Create: `tests/unit/onlineStationDownload.test.ts`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write RED tests for serialization, batching, partial failures, and abort**

```ts
it('downloads three dates with bounded concurrency and aggregates in order', async () => {
  const result = await downloadStationRange({
    startDate: '2024-11-01', endDate: '2024-11-03', stationId: '3329A',
    endpoint: 'https://api.example/v1/station-day', concurrency: 2,
    fetcher, signal: new AbortController().signal,
  })
  expect(result.filename).toBe('3329A_20241101_20241103.csv')
  expect(result.rows.map((row) => row.timestamp)).toEqual([
    '2024-11-01 00:00:00', '2024-11-02 00:00:00', '2024-11-03 00:00:00',
  ])
  expect(maxObservedConcurrency).toBe(2)
})

it('retains successful dates and reports a missing source day', async () => {
  expect(result.failedDates).toEqual(['2024-11-02'])
  expect(result.warnings.join(' ')).toContain('2024-11-02')
})
```

Also assert the exact BOM/CRLF station CSV header, formula neutralization, zero round-trip, duplicate timestamp first-finite resolution, 366-day pre-allocation rejection, and abort preventing new requests and progress updates.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/unit/extractedStationCsv.test.ts tests/unit/onlineStationDownload.test.ts`
Expected: FAIL on missing modules.

- [ ] **Step 3: Implement the public APIs**

```ts
export interface DownloadStationRangeOptions {
  startDate: string
  endDate: string
  stationId: string
  endpoint: string
  concurrency?: number
  signal: AbortSignal
  fetcher?: typeof fetch
  onProgress?(progress: { completed: number; total: number; failed: number }): void
}

export interface DownloadedStationRange {
  filename: string
  csvText: string
  rows: HourlyStationRow[]
  failedDates: string[]
  warnings: string[]
}
```

`downloadStationRange` validates the endpoint as HTTPS except loopback development, clamps concurrency to `1..4`, uses the inclusive UTC iterator, preserves stable date order, and caps public warnings at 100 while retaining totals.

- [ ] **Step 4: Verify RED/GREEN and no live network**

Run: `npm test -- tests/unit/extractedStationCsv.test.ts tests/unit/onlineStationDownload.test.ts`
Expected: PASS with mocked fetch only.

- [ ] **Step 5: Commit**

```bash
git add src/core/extractedStationCsv.ts src/core/onlineStationDownload.ts src/core/types.ts tests/unit/extractedStationCsv.test.ts tests/unit/onlineStationDownload.test.ts
git commit -m "feat: download and serialize station ranges"
```

---

### Task 4: Auto-detect and auto-parse local station files

**Files:**
- Modify: `src/workers/workerClient.ts`
- Modify: `src/workers/stationCsv.worker.ts`
- Modify: `src/core/stationCsv.ts`
- Create: `src/core/stationFileDetection.ts`
- Create: `tests/unit/stationFileDetection.test.ts`
- Modify: `tests/unit/workerClient.test.ts`

- [ ] **Step 1: Write failing tests for both accepted local formats**

```ts
it('detects national daily files from required long-form headers', () => {
  expect(detectStationFileKind('date,hour,type,3329A\r\n', 'china_sites_20241101.csv'))
    .toBe('national-daily')
})

it('detects one extracted station-wide file and parses without a second action', async () => {
  const files = [new File([stationWideCsv], '3329A_20241101_20241103.csv')]
  const parsed = await parseStationInputs(files, '3329A', signal)
  expect(parsed.flatMap((file) => file.rows)).toHaveLength(3)
})
```

Cover mixed-format rejection, missing station metadata, filename mismatch warnings, multiple extracted files with duplicate hours, physical batch cancellation, and no automatic parse after unmount.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/unit/stationFileDetection.test.ts tests/unit/workerClient.test.ts`
Expected: FAIL because detection and the unified client do not exist.

- [ ] **Step 3: Implement unified worker requests**

Extend the station Worker request with a discriminated kind:

```ts
type StationWorkerRequest =
  | { kind: 'national-daily'; file: File; stationId: string }
  | { kind: 'station-wide'; file: File; stationId: string }
```

Expose `parseStationInputs(files, stationId, signal)` and retain max four active Workers. Do not parse large files on the main thread.

- [ ] **Step 4: Run parser, lifecycle, and existing fixture tests**

Run: `npm test -- tests/unit/stationCsv.test.ts tests/unit/stationFileDetection.test.ts tests/unit/workerClient.test.ts`
Expected: PASS; existing national CSV behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/stationCsv.ts src/core/stationFileDetection.ts src/workers/workerClient.ts src/workers/stationCsv.worker.ts tests/unit/stationFileDetection.test.ts tests/unit/workerClient.test.ts
git commit -m "feat: auto-parse local station inputs"
```

---

### Task 5: Refactor the pipeline into four continuous stages

**Files:**
- Create: `src/pipeline/pipelineTypes.ts`
- Create: `src/pipeline/defaultPipelineServices.ts`
- Modify: `src/pipeline/usePipeline.ts`
- Modify: `src/app/App.tsx`
- Modify: `tests/unit/usePipeline.test.tsx`

- [ ] **Step 1: Write failing orchestration tests first**

Define the stage list:

```ts
export const PIPELINE_STEPS = ['data-source', 'station-series', 'quality-control', 'exports'] as const
export type DataSourceMode = 'online-links' | 'online-station' | 'local-import'
export type QcMode = 'station' | 'merged'
```

Tests must prove:

```ts
it('online station download becomes parsed input without re-upload', async () => {
  await result.current.downloadAndUseStationData()
  expect(services.downloadStationRange).toHaveBeenCalledOnce()
  expect(result.current.parsedStationFiles[0].rows).toEqual(downloadedRows)
  await result.current.runStep('station-series')
  expect(services.buildHourlySeries).toHaveBeenCalledWith(downloadedRows)
})

it('setting local files triggers parse automatically and enables stage two', async () => {
  act(() => result.current.setStationFiles([file]))
  await waitFor(() => expect(result.current.sourceStatus).toBe('ready'))
  expect(result.current.canRun('station-series')).toBe(true)
})
```

Also cover four-stage invalidation, clickable future-step prerequisite messages, current-position run-all, source replacement, overlap, cancel, StrictMode replay, unmount, and stale online responses.

- [ ] **Step 2: Run the hook tests and verify RED**

Run: `npm test -- tests/unit/usePipeline.test.tsx`
Expected: FAIL because current five-step types and APIs differ.

- [ ] **Step 3: Extract types/services and implement four-stage state**

Keep the hook focused on orchestration. The model must expose:

```ts
interface PipelineModel {
  activeStep: PipelineStep
  sourceMode: DataSourceMode | null
  sourceStatus: 'empty' | 'parsing' | 'ready' | 'error'
  downloadProgress: { completed: number; total: number; failed: number } | null
  stationQcResult: StationQualityControlResult | null
  mergedQcResult: DynamicQualityControlResult | null
  downloadAndUseStationData(): Promise<void>
  setStationFiles(files: File[]): void
  runQcMode(mode: QcMode): Promise<void>
  canRun(step: PipelineStep): boolean
}
```

Local file selection starts a cancellable parse run immediately. Online station success publishes parsed rows and triggers the user-provided `download` callback once; it does not require a synthetic `File` round trip.

- [ ] **Step 4: Run hook tests and existing cancellation tests**

Run: `npm test -- tests/unit/usePipeline.test.tsx tests/unit/workerClient.test.ts`
Expected: PASS under React StrictMode with no leaked Workers.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/pipelineTypes.ts src/pipeline/defaultPipelineServices.ts src/pipeline/usePipeline.ts src/app/App.tsx tests/unit/usePipeline.test.tsx
git commit -m "refactor: make pipeline inputs continuous"
```

---

### Task 6: Add independent station-only QC

**Files:**
- Create: `src/core/stationQualityControl.ts`
- Create: `tests/unit/stationQualityControl.test.ts`
- Modify: `src/core/qualityControl.ts`
- Modify: `src/pipeline/defaultPipelineServices.ts`
- Modify: `tests/unit/qualityControl.test.ts`

- [ ] **Step 1: Write RED tests that do not require ions**

```ts
it('keeps a complete six-pollutant station row without requiring ions', () => {
  const result = qualityControlStation([completeStationRow])
  expect(result.keptRows).toHaveLength(1)
  expect(result.rows[0].QC_flag).toBe('正常')
})

it('flags missing, nonfinite, negative, all-zero, and metadata mismatches without changing values', () => {
  const frozen = structuredClone(problemRows)
  const result = qualityControlStation(problemRows)
  expect(result.counts['六项污染物同时为0']).toBe(1)
  expect(problemRows).toEqual(frozen)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/unit/stationQualityControl.test.ts`
Expected: FAIL because `qualityControlStation` is missing.

- [ ] **Step 3: Extract reusable station rules**

Move six-variable checks into a pure helper used by both station-only and merged QC. Preserve the current structured flag codes and deep-cloned partitions. `qualityControl` remains an exported compatibility wrapper for the existing nine-variable path until Task 8 migrates callers.

- [ ] **Step 4: Verify old and new QC behavior**

Run: `npm test -- tests/unit/stationQualityControl.test.ts tests/unit/qualityControl.test.ts`
Expected: PASS; old merged baselines remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/stationQualityControl.ts src/core/qualityControl.ts src/pipeline/defaultPipelineServices.ts tests/unit/stationQualityControl.test.ts tests/unit/qualityControl.test.ts
git commit -m "feat: add station-only quality control"
```

---

### Task 7: Parse mapped user CSV and XLSX safely

**Files:**
- Create: `src/core/userDataset.ts`
- Create: `src/core/userWorkbook.ts`
- Create: `src/core/userWorkbookProtocol.ts`
- Create: `src/workers/userWorkbook.worker.ts`
- Create: `tests/unit/userDataset.test.ts`
- Create: `tests/unit/userWorkbook.test.ts`
- Modify: `src/core/zipPreflight.ts`

- [ ] **Step 1: Write failing matrix/mapping tests**

```ts
const mapping: UserColumnMapping = {
  timestampColumn: '时间',
  variables: [
    { sourceColumn: 'NO3-_μg_m3', key: 'NO3', label: 'NO3⁻', unit: 'μg/m³', nonNegative: true },
    { sourceColumn: '自定义变量', key: 'custom_1', label: '自定义变量', unit: '', nonNegative: false },
  ],
}

it('normalizes CSV and XLSX matrices to the same canonical rows', () => {
  expect(parseUserMatrix(csvMatrix, mapping)).toEqual(parseUserMatrix(xlsxMatrix, mapping))
})
```

Cover common time aliases, split two-row headers, Excel serial dates, wall-clock timezone policy, duplicate complementary values, first-finite conflicts, unknown unit warnings, dangerous formula-like headers, 100,000 physical-row cap, 8,784 canonical-hour cap, malformed mappings, warning cap, invalid ZIP metadata, abort, timeout, and Worker envelope validation.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/unit/userDataset.test.ts tests/unit/userWorkbook.test.ts`
Expected: FAIL on missing modules.

- [ ] **Step 3: Implement canonical user-data types**

```ts
export interface UserVariableSpec {
  key: string
  label: string
  unit: string
  nonNegative: boolean
  sourceColumn: string
}

export interface UserDataRow {
  timestamp: string
  values: Record<string, number | undefined>
}

export interface ParsedUserDataset {
  rows: UserDataRow[]
  variables: UserVariableSpec[]
  mapping: UserColumnMapping
  warnings: string[]
}
```

Auto-detection returns either a complete mapping or a bounded `mappingRequired` description. Never guess a time column when two candidates are equally plausible.

- [ ] **Step 4: Implement XLSX entirely inside a Worker**

Reuse ZIP preflight before transfer. The main thread sends only an ArrayBuffer and optional mapping; the Worker uses `read-excel-file/web-worker`, normalizes matrices, and returns a compact canonical result. Clean up listeners, timers, signal handlers, and the Worker on every settlement.

- [ ] **Step 5: Run focused, ZIP, and ion-workbook regression tests**

Run: `npm test -- tests/unit/userDataset.test.ts tests/unit/userWorkbook.test.ts tests/unit/zipPreflight.test.ts tests/unit/ionWorkbook.test.ts`
Expected: PASS; existing ion workbook remains supported.

- [ ] **Step 6: Commit**

```bash
git add src/core/userDataset.ts src/core/userWorkbook.ts src/core/userWorkbookProtocol.ts src/workers/userWorkbook.worker.ts src/core/zipPreflight.ts tests/unit/userDataset.test.ts tests/unit/userWorkbook.test.ts
git commit -m "feat: parse mapped user CSV and XLSX"
```

---

### Task 8: Merge dynamic user data and implement two independent QC modes

**Files:**
- Create: `src/core/dynamicQualityControl.ts`
- Modify: `src/core/hourlyMerge.ts`
- Modify: `src/pipeline/pipelineTypes.ts`
- Modify: `src/pipeline/usePipeline.ts`
- Create: `tests/unit/dynamicQualityControl.test.ts`
- Modify: `tests/unit/hourlyMerge.test.ts`
- Modify: `tests/unit/usePipeline.test.tsx`

- [ ] **Step 1: Write RED tests for dynamic merge and independent mode state**

```ts
it('merges user values on the station-authoritative timeline', () => {
  const result = mergeUserHourly(stationRows, userDataset)
  expect(result.rows[0].userValues).toEqual({ NO3: 8.2, custom_1: -2 })
  expect(result.unmatchedUserTimestamps).toEqual(['2024-11-02 02:00:00'])
})

it('does not apply a negative rule to unknown variables by default', () => {
  const result = qualityControlDynamic(mergedRows, variables)
  expect(result.rows[0].QC_flags.some((flag) => flag.variable === 'custom_1' && flag.code === 'negative')).toBe(false)
})

it('keeps station and merged QC results independently', async () => {
  await result.current.runQcMode('station')
  await result.current.runQcMode('merged')
  expect(result.current.stationQcResult).not.toBeNull()
  expect(result.current.mergedQcResult).not.toBeNull()
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/unit/dynamicQualityControl.test.ts tests/unit/hourlyMerge.test.ts tests/unit/usePipeline.test.tsx`
Expected: FAIL on missing APIs and state.

- [ ] **Step 3: Implement station-authoritative dynamic merge**

Add `userValues` as a nested record to avoid unsafe/dynamic top-level keys. Use exact canonical hours, retain all unmatched timestamp details in a bounded-size result, and retain the existing first-finite duplicate policy.

- [ ] **Step 4: Implement dynamic QC**

Run station rules first, then user-variable rules from `UserVariableSpec`. Missing and nonfinite checks apply to every mapped variable; negative checks apply only where `nonNegative` is true. Produce deep-cloned `rows`, `keptRows`, and `rejectedRows` plus per-flag counts.

- [ ] **Step 5: Implement independent pipeline invalidation**

Changing station inputs invalidates both QC modes. Changing only user data invalidates merged QC and merged exports but leaves station QC and station exports intact. Running one mode never clears the other.

- [ ] **Step 6: Run the focused and full unit suite**

Run: `npm test -- tests/unit/dynamicQualityControl.test.ts tests/unit/hourlyMerge.test.ts tests/unit/usePipeline.test.tsx && npm test`
Expected: focused and full suites PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/dynamicQualityControl.ts src/core/hourlyMerge.ts src/pipeline/pipelineTypes.ts src/pipeline/usePipeline.ts tests/unit/dynamicQualityControl.test.ts tests/unit/hourlyMerge.test.ts tests/unit/usePipeline.test.tsx
git commit -m "feat: add selectable quality control modes"
```

---

### Task 9: Export separate station and merged QC bundles

**Files:**
- Create: `src/core/qcModeExports.ts`
- Modify: `src/core/exports.ts`
- Modify: `src/core/qcWorkbook.ts`
- Modify: `src/core/exportShared.ts`
- Modify: `src/workers/qcWorkbook.worker.ts`
- Modify: `tests/unit/exports.test.ts`
- Create: `tests/unit/qcModeExports.test.ts`

- [ ] **Step 1: Write failing artifact contract tests**

```ts
it('builds a station-only bundle without ion columns', async () => {
  const artifacts = await buildStationQcArtifacts(input, options)
  expect(Object.values(artifacts).map((item) => item.name)).toContain('站点数据_质控结果.zip')
  expect(await csvText(artifacts.checkedCsv)).not.toContain('NO3')
})

it('builds a merged bundle with mapped dynamic columns and unmatched rows', async () => {
  const artifacts = await buildMergedQcArtifacts(input, options)
  expect(await csvText(artifacts.checkedCsv)).toContain('NO3⁻ (μg/m³)')
  expect(await csvText(artifacts.unmatchedCsv)).toContain('timestamp')
})
```

Inspect XLSX ZIP members and parse the workbook to assert sheet order, dynamic headers, counts, zeros, formula neutralization, no external links/macros, and deterministic ZIP bytes.

- [ ] **Step 2: Run export tests and verify RED**

Run: `npm test -- tests/unit/qcModeExports.test.ts tests/unit/exports.test.ts`
Expected: FAIL because mode-aware builders are missing.

- [ ] **Step 3: Generalize workbook input without weakening boundaries**

Pass explicit column descriptors and pre-normalized cells to the workbook Worker. Retain row/file/byte limits, metadata sanitization, Worker-only generation, timeout/abort, and canonical response reconstruction.

- [ ] **Step 4: Build two artifact maps and optional combined download**

Use separate filenames/prefixes. When both modes exist, expose both maps in the UI; do not silently combine or overwrite them. A combined top-level ZIP may contain `station-qc/` and `merged-qc/` folders only when the user explicitly clicks “下载全部结果”.

- [ ] **Step 5: Verify all export tests and production build**

Run: `npm test -- tests/unit/qcModeExports.test.ts tests/unit/exports.test.ts && npm run build`
Expected: PASS; QC and ZIP Workers emit as separate production assets.

- [ ] **Step 6: Commit**

```bash
git add src/core/qcModeExports.ts src/core/exports.ts src/core/qcWorkbook.ts src/core/exportShared.ts src/workers/qcWorkbook.worker.ts tests/unit/qcModeExports.test.ts tests/unit/exports.test.ts
git commit -m "feat: export independent qc result bundles"
```

---

### Task 10: Build the single-step UI and static premium hero

**Files:**
- Create: `src/components/DataSourcePanel.tsx`
- Create: `src/components/QcModePanel.tsx`
- Create: `src/components/ColumnMappingPanel.tsx`
- Modify: `src/components/Hero.tsx`
- Modify: `src/components/Workbench.tsx`
- Modify: `src/components/StepRail.tsx`
- Modify: `src/components/InspectionPanel.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/app.css`
- Create: `scripts/build-static-hero-assets.mjs`
- Create: `src/assets/aerosol-hero-static-v2.png`
- Create: `src/assets/aerosol-hero-static-v2-1680.webp`
- Create: `src/assets/aerosol-hero-static-v2-960.webp`
- Modify: `tests/unit/App.test.tsx`

- [ ] **Step 1: Write RED component tests for confirmed copy and behavior**

```tsx
expect(screen.getByText('江峰课题组')).toBeVisible()
expect(screen.queryByText(/安徽理工大学课题组/)).not.toBeInTheDocument()
expect(screen.queryByText(/数据不离开浏览器/)).not.toBeInTheDocument()
expect(screen.getByText('MAKING INVISIBLE ATMOSPHERIC PROCESSES ANALYZABLE')).toBeVisible()

for (const label of ['获取或导入数据', '构建逐时序列', '数据质控', '导出结果']) {
  expect(screen.getByRole('button', { name: new RegExp(label) })).toBeEnabled()
}
```

Click every hero step and assert the workbench scroll target plus exactly one active panel. Assert local file selection calls automatic parsing, online raw links do not ask for a station, and future-stage prerequisite guidance is visible.

- [ ] **Step 2: Run component tests and verify RED**

Run: `npm test -- tests/unit/App.test.tsx`
Expected: FAIL on old brand, five decorative hero steps, dynamic layers, and old labels.

- [ ] **Step 3: Generate and persist the approved original static image**

Use the built-in image-generation workflow with this exact prompt summary:

```text
Original ultra-photorealistic wide mountain landscape at dawn; layered blue-gray ridges and natural valley clouds; left 42 percent dark negative space for Chinese copy; strongest rocky ridge on the right; premium documentary nature photography; no people, buildings, text, logo, watermark, particles, fantasy, or oversaturation.
```

Save the selected source as `src/assets/aerosol-hero-static-v2.png`. Run `node scripts/build-static-hero-assets.mjs` to create deterministic 960px and 1680px WebP variants. The script must fail if dimensions, decode, or output-size caps are violated.

- [ ] **Step 4: Remove every background-motion path**

Delete pointer tracking, requestAnimationFrame state, fog elements, particles, `camera-breathe`, `fog-*`, `particle-float`, parallax CSS variables, and related `will-change`. Keep only a static `<picture>`, edge gradient, and non-animated responsive crop.

- [ ] **Step 5: Implement layout C and clickable four-stage hero navigation**

Place the English guide line above the two-line Chinese H1. Render the four hero stage cards as `<button type="button">`; clicking sets the pipeline active step and scrolls to the workbench. Use `aria-current="step"` for the current card.

- [ ] **Step 6: Implement one-active-panel Workbench UI**

STEP 01 renders `DataSourcePanel`; STEP 02 renders only series controls/preview; STEP 03 renders the QC mode chooser plus one selected mode; STEP 04 renders available artifact groups. Do not render hidden copies of inactive forms.

- [ ] **Step 7: Implement accessible data source, QC mode, and mapping controls**

Use semantic tabs or radio cards with keyboard support and unique `aria-controls`. Unknown mappings open `ColumnMappingPanel`; submit is disabled until one time column and at least one variable are valid. Every busy operation keeps Cancel enabled.

- [ ] **Step 8: Run component, accessibility, and CSS regression tests**

Run: `npm test -- tests/unit/App.test.tsx tests/unit/usePipeline.test.tsx && npm run lint && npm run build`
Expected: PASS; a source scan finds no removed animation identifiers.

- [ ] **Step 9: Commit**

```bash
git add src/components src/app src/assets scripts/build-static-hero-assets.mjs tests/unit/App.test.tsx
git commit -m "feat: redesign the staged aerosol workbench"
```

---

### Task 11: Add full browser coverage for both paths and both QC modes

**Files:**
- Modify: `e2e/workbench.spec.ts`
- Create: `tests/fixtures/user-data-small.csv`
- Create: `tests/fixtures/user-data-small.xlsx`
- Modify: `tests/fixtures/generate-ion-fixtures.py`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Write E2E tests before adapting production behavior**

Add tests that use a same-origin Playwright route as the Worker endpoint while preserving genuine browser CSV/XLSX/export Workers:

```ts
test('online station download saves CSV and continues without re-upload', async ({ page }) => {
  await installStationApiFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: /获取或导入数据/ }).click()
  await page.getByRole('tab', { name: '在线获取数据' }).click()
  await page.getByLabel('站点编号').fill('3329A')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载并直接处理' }).click()
  expect((await download).suggestedFilename()).toBe('3329A_20241101_20241103.csv')
  await page.getByRole('button', { name: /构建逐时序列/ }).click()
  await expect(page.getByText(/当前序列 72 行/)).toBeVisible()
})
```

Add separate tests for raw-link generation without station, local national CSV auto-parse, extracted CSV auto-parse, station-only QC, merged CSV QC, merged XLSX QC, both mode bundles, one-click resume, cancellation/late response, four clickable stage cards, static hero, brand text, keyboard mapping, desktop `1440x1000`, and mobile `390x844` overflow/console errors.

- [ ] **Step 2: Run E2E and verify RED against the old UI**

Run: `npm run build && npm run e2e`
Expected: new tests FAIL on old labels and missing modes; existing unrelated tests still pass.

- [ ] **Step 3: Update fixtures deterministically**

Generate the XLSX twice and compare SHA-256. Fixtures contain only synthetic values and no private paths. Ensure `git diff --check` and the privacy audit accept them.

- [ ] **Step 4: Run repeated focused E2E, then full E2E**

Run:

```bash
npx playwright test e2e/workbench.spec.ts --grep "online station|local import|station-only QC|merged" --repeat-each=3
npm run e2e
```

Expected: repeated focused tests and full desktop/mobile suite PASS; only explicitly desktop-only cancellation cases may skip on mobile.

- [ ] **Step 5: Commit**

```bash
git add e2e playwright.config.ts tests/fixtures
git commit -m "test: cover dual input and qc workflows"
```

---

### Task 12: Document and deploy the Worker and updated Pages app

**Files:**
- Create: `.github/workflows/deploy-worker.yml`
- Modify: `.github/workflows/pages.yml`
- Modify: `README.md`
- Modify: `scripts/check-public-release.test.mjs`
- Modify: `package.json`
- Modify: `vite.config.ts`

- [ ] **Step 1: Write release-contract tests first**

Tests must require:

- `VITE_STATION_API_URL` at build time and an HTTPS production value;
- `worker/wrangler.jsonc` with fixed source and allowed origins;
- `worker:dry-run` in `verify:public`;
- no secrets in tracked files;
- main-only Worker deployment;
- exact pinned Wrangler and immutable Cloudflare Action SHA;
- README statements that online station data passes through the Worker while local uploads are browser-parsed.

- [ ] **Step 2: Run the public contract test and verify RED**

Run: `node --test scripts/check-public-release.test.mjs`
Expected: FAIL on missing Worker deployment and updated documentation.

- [ ] **Step 3: Add the Worker deployment workflow**

Use the verified Cloudflare Action commit and exact Wrangler version:

```yaml
- uses: cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd # v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    wranglerVersion: "4.120.0"
    workingDirectory: worker
    command: deploy
```

PRs and non-main manual runs execute tests/dry-run only. Deployment requires `github.ref == 'refs/heads/main' && github.event_name != 'pull_request'`, one production concurrency lane, and a 10-minute timeout.

- [ ] **Step 4: Wire the Pages build to the non-secret API URL**

Define repository variable `VITE_STATION_API_URL` after the Worker is deployed. Pages build must fail closed when the value is absent or non-HTTPS. Local `.env.local` stays ignored and may use `http://127.0.0.1:8787`.

- [ ] **Step 5: Update README and release checks**

Document the two parallel entry paths, four clickable stages, both QC modes, Worker privacy boundary, Cloudflare prerequisites, local Worker development, CSV/XLSX mapping, and exact deployment sequence. Remove the global claim that every online operation stays in the browser.

- [ ] **Step 6: Verify locally before external deployment**

Run:

```bash
npm run verify:release
npm run worker:dry-run
npm run audit:privacy
npm run audit:privacy:history
```

Expected: all commands PASS; no Worker credential, research input, local path, or personal metadata is tracked.

- [ ] **Step 7: Deploy the Worker with user-authorized Cloudflare credentials**

Read-only preflight:

```bash
npx wrangler whoami
```

If unauthenticated, stop and ask the user to run `npx wrangler login`; do not substitute a third-party proxy. After authentication:

```bash
npm run worker:deploy
```

Record the exact `https://aerosol-station-data-api.<account-subdomain>.workers.dev` URL, set it as GitHub repository variable `VITE_STATION_API_URL`, and run a real one-day request for `3329A`.

- [ ] **Step 8: Push and verify both workflows**

Push `main`, watch the Worker workflow and Pages workflow, then run live desktop/mobile smoke tests for raw links, online station download, local import, both QC modes, result ZIPs, console errors, and overflow. Verify Worker CORS rejects an unrelated Origin.

- [ ] **Step 9: Commit documentation/deployment files before push**

```bash
git add .github/workflows README.md scripts/check-public-release.test.mjs package.json vite.config.ts
git commit -m "docs: deploy continuous station workflow"
```

---

### Task 13: Final privacy, scientific parity, and visual release gate

**Files:**
- Modify only files identified by failing parity, privacy, or visual evidence.

- [ ] **Step 1: Run private real-data parity without committing inputs**

Use the existing gated environment variables. Confirm 61 daily files, 1,464 hours, ion workbook parity, and unchanged source file size/mtime. Add new assertions that local import auto-parses and station-only QC does not require ions.

- [ ] **Step 2: Capture and inspect final visuals**

Capture desktop `1440x1000`, mobile `390x844`, STEP 01, STEP 03 mode A, STEP 03 mode B, and reduced-motion screenshots outside the repository. Compare against the approved static-background and layout-C decisions. Confirm no dynamic fog, particles, camera movement, or inactive-stage content.

- [ ] **Step 3: Run the complete local release gate fresh**

Run:

```bash
npm run verify:release
npm run audit:privacy
npm run audit:privacy:history
npm audit --omit=dev
npx wrangler deploy --dry-run --config worker/wrangler.jsonc
git diff --check
git status --short
```

Expected: all gates PASS; worktree is clean before the release push.

- [ ] **Step 4: Verify public deployment state**

Confirm GitHub `main`, Pages, and Worker deployment reference the same reviewed release. Run live HTTP and browser checks and verify the public Git history contains only GitHub noreply identities and no private paths/data.

- [ ] **Step 5: Record release state**

Report the repository URL, Pages URL, Worker URL, commit SHA, workflow runs, unit/Python/E2E counts, private parity outcome, privacy object counts, and intentional limitations. Preserve the worktree for follow-up.

---

## Plan self-review checklist

- Spec coverage: both online functions, parallel local import, no re-import, four clickable stages, one active panel, independent QC modes, CSV/XLSX mapping, static background, Jiang Feng branding, layout C, security, deployment, and live QA each map to at least one task.
- Type consistency: `PipelineStep`, `DataSourceMode`, `QcMode`, `UserDataRow`, `UserVariableSpec`, station/merged QC result names, and artifact builders are defined before later use.
- Placeholder scan: the plan contains no `TBD`, `TODO`, “implement later”, or unspecified error-handling steps.
- Scope control: the Worker handles one station/day only; browser aggregation and existing analysis remain client-side; arbitrary upstream URLs and arbitrary scientific rules are explicitly excluded.
