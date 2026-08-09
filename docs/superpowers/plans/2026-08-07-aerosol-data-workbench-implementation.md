# Aerosol Data Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publicly deploy a photorealistic, motion-rich browser workbench that generates station-data download links, extracts a selected station, merges ion data, performs auditable QC, and exports reproducible results without uploading research data.

**Architecture:** React and TypeScript provide the UI and pipeline orchestration. Pure domain modules handle date generation, station CSV extraction, hourly series construction, ion workbook parsing, merging, QC, and exports; Web Workers keep large CSV parsing off the main thread. GitHub Actions builds and deploys the static app to GitHub Pages.

**Tech Stack:** React 18, TypeScript, Vite, Papa Parse, SheetJS, JSZip, Vitest, React Testing Library, Playwright, GitHub Actions.

**Interaction acceptance rule:** Every control that looks actionable must be genuinely clickable and keyboard-operable. This includes the navigation links, five step cards, date-link generator, generated file links, file-drop labels, previous/next controls, one-click processing, preview tabs, individual result downloads, and ZIP download. Decorative layers must use `pointer-events: none` and must never cover controls.

---

## File Map

```text
aerosol-data-workbench/
├─ public/assets/aerosol-hero-real.png
├─ reference-python/
│  ├─ 01_批量下载国控站逐日数据.py
│  ├─ 02_提取山南新区3329A六常规.py
│  └─ README_使用说明.md
├─ src/
│  ├─ app/App.tsx
│  ├─ app/app.css
│  ├─ components/Hero.tsx
│  ├─ components/Workbench.tsx
│  ├─ components/StepRail.tsx
│  ├─ components/InspectionPanel.tsx
│  ├─ components/FileDropZone.tsx
│  ├─ core/types.ts
│  ├─ core/dates.ts
│  ├─ core/downloadLinks.ts
│  ├─ core/stationCsv.ts
│  ├─ core/stationSeries.ts
│  ├─ core/ionWorkbook.ts
│  ├─ core/hourlyMerge.ts
│  ├─ core/qualityControl.ts
│  ├─ core/exports.ts
│  ├─ pipeline/usePipeline.ts
│  ├─ workers/stationCsv.worker.ts
│  ├─ workers/workerClient.ts
│  ├─ main.tsx
│  └─ vite-env.d.ts
├─ tests/fixtures/
├─ tests/unit/
├─ tests/integration/
├─ e2e/workbench.spec.ts
├─ .github/workflows/pages.yml
├─ index.html
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ vitest.config.ts
├─ playwright.config.ts
├─ README.md
└─ .gitignore
```

## Task 1: Scaffold the React Application and Test Harness

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/app.css`
- Create: `.gitignore`

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "aerosol-data-workbench",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit",
    "preview": "vite preview",
    "e2e": "playwright test"
  },
  "dependencies": {
    "jszip": "^3.10.1",
    "papaparse": "^5.5.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "xlsx": "^0.18.5"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^18.3.24",
    "@types/react-dom": "^18.3.7",
    "@types/papaparse": "^5.3.16",
    "@vitejs/plugin-react": "^4.7.0",
    "jsdom": "^26.1.0",
    "typescript": "^5.9.2",
    "vite": "^7.1.2",
    "vitest": "^3.2.4"
  }
}
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", setupFiles: ["./tests/setup.ts"] },
});
```

```ts
// tests/setup.ts
import "@testing-library/jest-dom/vitest";
```

```html
<!-- index.html -->
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>大气气溶胶数据工作台</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 2: Create Vite and TypeScript configuration**

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "production" ? "/aerosol-data-workbench/" : "/",
  worker: { format: "es" },
}));
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "tests", "vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create the failing application smoke test**

```ts
// tests/unit/App.test.tsx
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app/App";

describe("App", () => {
  it("renders the workbench title and primary action", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /让不可见的大气过程可分析/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /开始处理数据/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run the test and verify it fails**

Run: `npm install && npm test -- App.test.tsx`  
Expected: FAIL because `src/app/App.tsx` does not exist.

- [ ] **Step 5: Add the minimal application shell**

```tsx
// src/app/App.tsx
import "./app.css";

export function App() {
  return (
    <main>
      <section className="hero">
        <h1>让不可见的大气过程可分析</h1>
        <button type="button" onClick={() => document.querySelector("#workbench")?.scrollIntoView({ behavior: "smooth" })}>
          开始处理数据
        </button>
      </section>
      <section id="workbench" aria-label="数据工作台" />
    </main>
  );
}
```

```tsx
// src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
```

```css
/* src/app/app.css */
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; min-width: 320px; font-family: Inter, "Noto Sans SC", system-ui, sans-serif; background: #07151c; color: #f6fbfa; }
button, a, label, input { font: inherit; }
button, a, label[for] { cursor: pointer; }
```

- [ ] **Step 6: Run smoke checks and commit**

Run: `npm test && npm run build`  
Expected: all tests PASS and `dist/` is created.

```bash
git add package.json package-lock.json vite.config.ts tsconfig.json vitest.config.ts index.html src tests/unit/App.test.tsx .gitignore
git commit -m "chore: scaffold aerosol data workbench"
```

## Task 2: Define Domain Types and Download-Link Generation

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/dates.ts`
- Create: `src/core/downloadLinks.ts`
- Test: `tests/unit/downloadLinks.test.ts`

- [ ] **Step 1: Write failing date and link tests**

```ts
import { describe, expect, it } from "vitest";
import { buildDownloadLinks } from "../../src/core/downloadLinks";

describe("buildDownloadLinks", () => {
  it("creates inclusive daily station links", () => {
    expect(buildDownloadLinks("2024-11-01", "2024-11-03")).toEqual([
      { date: "2024-11-01", filename: "china_sites_20241101.csv", url: "https://quotsoft.net/air/data/china_sites_20241101.csv" },
      { date: "2024-11-02", filename: "china_sites_20241102.csv", url: "https://quotsoft.net/air/data/china_sites_20241102.csv" },
      { date: "2024-11-03", filename: "china_sites_20241103.csv", url: "https://quotsoft.net/air/data/china_sites_20241103.csv" },
    ]);
  });

  it("rejects a reversed date range", () => {
    expect(() => buildDownloadLinks("2024-12-01", "2024-11-01")).toThrow("结束日期不能早于开始日期");
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- downloadLinks.test.ts`  
Expected: FAIL with missing module.

- [ ] **Step 3: Implement typed date generation**

```ts
// src/core/types.ts
export const POLLUTANTS = ["SO2", "NO2", "O3", "CO", "PM10", "PM2.5"] as const;
export type Pollutant = (typeof POLLUTANTS)[number];
export type DownloadLink = { date: string; filename: string; url: string };
export type HourlyStationRow = { timestamp: string } & Partial<Record<Pollutant, number>>;
export type QcSeverity = "warning" | "blocking";
export type QcIssue = { code: string; severity: QcSeverity; message: string; timestamp?: string; file?: string };
```

```ts
// src/core/dates.ts
export function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`日期格式无效：${value}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`日期格式无效：${value}`);
  return date;
}

export function formatDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}
```

```ts
// src/core/downloadLinks.ts
import type { DownloadLink } from "./types";
import { formatDateUtc, parseIsoDate } from "./dates";

export function buildDownloadLinks(startValue: string, endValue: string): DownloadLink[] {
  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue);
  if (end < start) throw new Error("结束日期不能早于开始日期");
  const links: DownloadLink[] = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 86_400_000) {
    const date = formatDateUtc(new Date(cursor));
    const compact = date.replaceAll("-", "");
    links.push({ date, filename: `china_sites_${compact}.csv`, url: `https://quotsoft.net/air/data/china_sites_${compact}.csv` });
  }
  return links;
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- downloadLinks.test.ts`  
Expected: 2 tests PASS.

```bash
git add src/core tests/unit/downloadLinks.test.ts
git commit -m "feat: generate daily station download links"
```

## Task 3: Parse and Validate One Station CSV

**Files:**
- Create: `src/core/stationCsv.ts`
- Create: `src/workers/stationCsv.worker.ts`
- Create: `src/workers/workerClient.ts`
- Test: `tests/unit/stationCsv.test.ts`
- Create: `tests/fixtures/china_sites_20241101-small.csv`

- [ ] **Step 1: Create a small deterministic fixture**

```csv
date,hour,type,3329A,2277A
20241101,0,SO2,3,9
20241101,0,NO2,21,27
20241101,0,O3,92,68
20241101,0,CO,0.6,0.9
20241101,0,PM10,89,80
20241101,0,PM2.5,49,51
20241101,0,AQI,70,70
```

- [ ] **Step 2: Write failing parser tests**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStationCsvText } from "../../src/core/stationCsv";

describe("parseStationCsvText", () => {
  const csv = readFileSync("tests/fixtures/china_sites_20241101-small.csv", "utf8");
  it("keeps only six instantaneous pollutants for the selected station", () => {
    const result = parseStationCsvText(csv, "china_sites_20241101.csv", "3329A");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ timestamp: "2024-11-01 00:00:00", SO2: 3, NO2: 21, O3: 92, CO: 0.6, PM10: 89, "PM2.5": 49 });
  });
  it("reports a missing station as blocking", () => {
    expect(() => parseStationCsvText(csv, "china_sites_20241101.csv", "9999A")).toThrow("站点列不存在：9999A");
  });
});
```

- [ ] **Step 3: Implement the pure parser**

```ts
import Papa from "papaparse";
import { POLLUTANTS, type HourlyStationRow, type Pollutant } from "./types";

type CsvRecord = { date: string; hour: string; type: string; [station: string]: string };
export type ParsedStationFile = { filename: string; rows: HourlyStationRow[]; warnings: string[] };

export function parseStationCsvText(text: string, filename: string, station: string): ParsedStationFile {
  const parsed = Papa.parse<CsvRecord>(text.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`CSV解析失败：${parsed.errors[0].message}`);
  const fields = parsed.meta.fields ?? [];
  for (const required of ["date", "hour", "type", station]) {
    if (!fields.includes(required)) throw new Error(required === station ? `站点列不存在：${station}` : `必要列不存在：${required}`);
  }
  const byTime = new Map<string, HourlyStationRow>();
  for (const record of parsed.data) {
    if (!POLLUTANTS.includes(record.type as Pollutant)) continue;
    const date = record.date.padStart(8, "0");
    const hour = Number(record.hour);
    if (!/^\d{8}$/.test(date) || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const timestamp = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${String(hour).padStart(2, "0")}:00:00`;
    const row = byTime.get(timestamp) ?? { timestamp };
    const value = Number(record[station]);
    if (record[station] !== "" && Number.isFinite(value)) row[record.type as Pollutant] = value;
    byTime.set(timestamp, row);
  }
  return { filename, rows: [...byTime.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)), warnings: [] };
}
```

- [ ] **Step 4: Wrap the parser in a Web Worker**

```ts
// src/workers/stationCsv.worker.ts
/// <reference lib="webworker" />
import { parseStationCsvText } from "../core/stationCsv";

self.onmessage = async (event: MessageEvent<{ file: File; station: string }>) => {
  try {
    const text = await event.data.file.text();
    self.postMessage({ ok: true, result: parseStationCsvText(text, event.data.file.name, event.data.station) });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
```

```ts
// src/workers/workerClient.ts
import type { ParsedStationFile } from "../core/stationCsv";

export function parseStationFile(file: File, station: string): Promise<ParsedStationFile> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./stationCsv.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      data.ok ? resolve(data.result) : reject(new Error(data.error));
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ file, station });
  });
}
```

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- stationCsv.test.ts`  
Expected: 2 tests PASS.

```bash
git add src/core/stationCsv.ts src/workers tests/unit/stationCsv.test.ts tests/fixtures/china_sites_20241101-small.csv
git commit -m "feat: parse selected station CSV in worker"
```

## Task 4: Build a Continuous Hourly Station Series

**Files:**
- Create: `src/core/stationSeries.ts`
- Test: `tests/unit/stationSeries.test.ts`

- [ ] **Step 1: Write failing series tests**

```ts
import { describe, expect, it } from "vitest";
import { buildHourlySeries } from "../../src/core/stationSeries";

describe("buildHourlySeries", () => {
  it("fills missing hours and records missing pollutants", () => {
    const result = buildHourlySeries([
      { timestamp: "2024-11-01 00:00:00", SO2: 3, NO2: 21 },
      { timestamp: "2024-11-01 02:00:00", SO2: 2, NO2: 20 },
    ]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[1].status).toBe("存在缺测");
    expect(result.rows[1].missing).toContain("SO2");
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- stationSeries.test.ts`  
Expected: FAIL with missing module.

- [ ] **Step 3: Implement duplicate handling and timeline completion**

```ts
import { POLLUTANTS, type HourlyStationRow } from "./types";

export type StationSeriesRow = HourlyStationRow & { missing: string[]; status: "完整" | "存在缺测" };

function toUtcMillis(timestamp: string): number {
  return Date.parse(timestamp.replace(" ", "T") + "+08:00");
}

function formatBeijing(ms: number): string {
  const local = new Date(ms + 8 * 3_600_000).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 19)}`;
}

export function buildHourlySeries(input: HourlyStationRow[]): { rows: StationSeriesRow[]; duplicateTimes: string[] } {
  if (!input.length) return { rows: [], duplicateTimes: [] };
  const map = new Map<string, HourlyStationRow>();
  const duplicateTimes: string[] = [];
  for (const row of input) {
    if (map.has(row.timestamp)) duplicateTimes.push(row.timestamp);
    map.set(row.timestamp, { ...map.get(row.timestamp), ...row });
  }
  const times = [...map].map(([time]) => toUtcMillis(time)).sort((a, b) => a - b);
  const rows: StationSeriesRow[] = [];
  for (let time = times[0]; time <= times[times.length - 1]; time += 3_600_000) {
    const timestamp = formatBeijing(time);
    const row = map.get(timestamp) ?? { timestamp };
    const missing = POLLUTANTS.filter((pollutant) => row[pollutant] === undefined);
    rows.push({ ...row, missing: [...missing], status: missing.length ? "存在缺测" : "完整" });
  }
  return { rows, duplicateTimes: [...new Set(duplicateTimes)] };
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- stationSeries.test.ts`  
Expected: PASS.

```bash
git add src/core/stationSeries.ts tests/unit/stationSeries.test.ts
git commit -m "feat: assemble continuous hourly station series"
```

## Task 5: Parse the Ion Workbook

**Files:**
- Create: `src/core/ionWorkbook.ts`
- Test: `tests/unit/ionWorkbook.test.ts`
- Create: `tests/fixtures/ions-small.xlsx`

- [ ] **Step 1: Generate a deterministic ion workbook fixture**

Run:

```bash
node -e "const XLSX=require('xlsx');const rows=[['时间','NO₃⁻','SO₄²⁻','NH₄⁺'],['单位','μg/m³','μg/m³','μg/m³'],['2024-11-01 00:00:00',12.3,4.5,5.6]];const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'站点数据');XLSX.writeFile(wb,'tests/fixtures/ions-small.xlsx')"
```

- [ ] **Step 2: Write failing ion parser tests**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIonWorkbook } from "../../src/core/ionWorkbook";

describe("parseIonWorkbook", () => {
  it("recognizes Chinese ion headers and skips the unit row", () => {
    const bytes = readFileSync("tests/fixtures/ions-small.xlsx");
    const result = parseIonWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(result.rows).toEqual([{ timestamp: "2024-11-01 00:00:00", NO3: 12.3, SO4: 4.5, NH4: 5.6 }]);
  });
});
```

- [ ] **Step 3: Implement header normalization and row parsing**

```ts
import * as XLSX from "xlsx";

export type IonRow = { timestamp: string; NO3?: number; SO4?: number; NH4?: number; [key: string]: string | number | undefined };
const normalizedHeaders: Record<string, string> = {
  "时间": "timestamp", datetime: "timestamp",
  "NO₃⁻": "NO3", NO3: "NO3", "NO3_μg_m3": "NO3",
  "SO₄²⁻": "SO4", SO4: "SO4", "SO4_μg_m3": "SO4",
  "NH₄⁺": "NH4", NH4: "NH4", "NH4_μg_m3": "NH4",
};

export function parseIonWorkbook(buffer: ArrayBuffer): { rows: IonRow[]; sheetName: string } {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames.includes("站点数据") ? "站点数据" : workbook.SheetNames[0];
  const matrix = XLSX.utils.sheet_to_json<(string | number | Date)[]>(workbook.Sheets[sheetName], { header: 1, raw: false });
  if (!matrix.length) throw new Error("离子工作簿为空");
  const headers = matrix[0].map((value) => normalizedHeaders[String(value).trim()] ?? String(value).trim());
  for (const required of ["timestamp", "NO3", "SO4", "NH4"]) if (!headers.includes(required)) throw new Error(`离子工作簿缺少必要列：${required}`);
  const rows: IonRow[] = [];
  for (const values of matrix.slice(1)) {
    if (String(values[0] ?? "").includes("单位")) continue;
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const timestamp = String(record.timestamp ?? "").replace("T", " ").slice(0, 19);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) continue;
    rows.push({ timestamp, NO3: Number(record.NO3), SO4: Number(record.SO4), NH4: Number(record.NH4) });
  }
  return { rows, sheetName };
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- ionWorkbook.test.ts`  
Expected: PASS.

```bash
git add src/core/ionWorkbook.ts tests/unit/ionWorkbook.test.ts tests/fixtures/ions-small.xlsx
git commit -m "feat: parse water-soluble ion workbook"
```

## Task 6: Merge Hourly Data and Perform Auditable QC

**Files:**
- Create: `src/core/hourlyMerge.ts`
- Create: `src/core/qualityControl.ts`
- Test: `tests/unit/qualityControl.test.ts`

- [ ] **Step 1: Write failing QC tests**

```ts
import { describe, expect, it } from "vitest";
import { mergeHourly } from "../../src/core/hourlyMerge";
import { runQualityControl } from "../../src/core/qualityControl";

describe("quality control", () => {
  it("flags six simultaneous zero values without changing them", () => {
    const station = [{ timestamp: "2024-11-15 18:00:00", SO2: 0, NO2: 0, O3: 0, CO: 0, PM10: 0, "PM2.5": 0, missing: [], status: "完整" as const }];
    const merged = mergeHourly(station, [{ timestamp: "2024-11-15 18:00:00", NO3: 10, SO4: 3, NH4: 5 }]);
    const checked = runQualityControl(merged);
    expect(checked.rows[0].SO2).toBe(0);
    expect(checked.rows[0].QC_flag).toContain("六项污染物同时为0");
  });
});
```

- [ ] **Step 2: Implement the merge**

```ts
// src/core/hourlyMerge.ts
import type { IonRow } from "./ionWorkbook";
import type { StationSeriesRow } from "./stationSeries";

export type MergedRow = StationSeriesRow & Partial<IonRow>;
export function mergeHourly(stationRows: StationSeriesRow[], ionRows: IonRow[]): MergedRow[] {
  const ions = new Map(ionRows.map((row) => [row.timestamp, row]));
  return stationRows.map((row) => ({ ...row, ...(ions.get(row.timestamp) ?? {}) }));
}
```

- [ ] **Step 3: Implement QC rules as pure functions**

```ts
// src/core/qualityControl.ts
import { POLLUTANTS } from "./types";
import type { MergedRow } from "./hourlyMerge";

export type CheckedRow = MergedRow & { QC_flag: string; QC_keep: boolean };
export function runQualityControl(rows: MergedRow[]): { rows: CheckedRow[]; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const checked = rows.map((row) => {
    const flags: string[] = [];
    const core = [row.NO3, row.SO4, row.NH4];
    if (core.some((value) => value === undefined || Number.isNaN(value))) flags.push("核心离子缺测");
    const numericValues = [...POLLUTANTS.map((key) => row[key]), ...core];
    if (numericValues.some((value) => typeof value === "number" && value < 0)) flags.push("存在负浓度");
    if (POLLUTANTS.every((key) => row[key] === 0)) flags.push("六项污染物同时为0");
    if (row.missing.length) flags.push(`六常规缺测：${row.missing.join("、")}`);
    if (!flags.length) flags.push("正常");
    for (const flag of flags) counts[flag] = (counts[flag] ?? 0) + 1;
    return { ...row, QC_flag: flags.join("；"), QC_keep: flags.length === 1 && flags[0] === "正常" };
  });
  return { rows: checked, counts };
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- qualityControl.test.ts`  
Expected: PASS and original zero values remain unchanged.

```bash
git add src/core/hourlyMerge.ts src/core/qualityControl.ts tests/unit/qualityControl.test.ts
git commit -m "feat: merge hourly inputs and add auditable QC"
```

## Task 7: Export CSV, Excel, QC Report, and Processing Log

**Files:**
- Create: `src/core/exports.ts`
- Test: `tests/unit/exports.test.ts`

- [ ] **Step 1: Write a failing export test**

```ts
import { describe, expect, it } from "vitest";
import { createStationCsv } from "../../src/core/exports";

describe("exports", () => {
  it("writes UTF-8 BOM and explicit units", () => {
    const csv = createStationCsv([{ timestamp: "2024-11-01 00:00:00", SO2: 3, CO: 0.6, missing: [], status: "完整" }]);
    expect(csv.startsWith("\uFEFF时间,SO2_μg_m3")).toBe(true);
    expect(csv).toContain("2024-11-01 00:00:00,3");
  });
});
```

- [ ] **Step 2: Implement export helpers**

```ts
import Papa from "papaparse";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import type { StationSeriesRow } from "./stationSeries";
import type { CheckedRow } from "./qualityControl";

export function createStationCsv(rows: StationSeriesRow[]): string {
  const records = rows.map((row) => ({ 时间: row.timestamp, SO2_μg_m3: row.SO2, NO2_μg_m3: row.NO2, O3_μg_m3: row.O3, CO_mg_m3: row.CO, PM10_μg_m3: row.PM10, "PM2.5_μg_m3": row["PM2.5"], 缺测项目: row.missing.join("、"), 数据状态: row.status }));
  return "\uFEFF" + Papa.unparse(records);
}

export function createQcWorkbook(rows: CheckedRow[], counts: Record<string, number>): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "逐时合并与质控");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(Object.entries(counts).map(([QC_flag, 行数]) => ({ QC_flag, 行数 }))), "质控汇总");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

export async function createResultZip(files: Record<string, string | ArrayBuffer>): Promise<Blob> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "blob" });
}
```

- [ ] **Step 3: Run tests and commit**

Run: `npm test -- exports.test.ts`  
Expected: PASS.

```bash
git add src/core/exports.ts tests/unit/exports.test.ts
git commit -m "feat: export station data and QC results"
```

## Task 8: Implement Pipeline State and One-Click Orchestration

**Files:**
- Create: `src/pipeline/usePipeline.ts`
- Test: `tests/unit/usePipeline.test.tsx`

- [ ] **Step 1: Write the failing orchestration test**

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePipeline } from "../../src/pipeline/usePipeline";

describe("usePipeline", () => {
  it("stops at the first missing required input", async () => {
    const { result } = renderHook(() => usePipeline());
    await act(async () => result.current.runAll());
    expect(result.current.activeStep).toBe("station-files");
    expect(result.current.message).toBe("请先导入国控站逐日CSV文件");
  });
});
```

- [ ] **Step 2: Implement explicit pipeline states**

```ts
import { useCallback, useState } from "react";
import type { StationSeriesRow } from "../core/stationSeries";
import type { CheckedRow } from "../core/qualityControl";

export type PipelineStep = "download-links" | "station-files" | "station-series" | "merge-qc" | "exports";

export function usePipeline() {
  const [activeStep, setActiveStep] = useState<PipelineStep>("download-links");
  const [stationFiles, setStationFiles] = useState<File[]>([]);
  const [ionFile, setIonFile] = useState<File | null>(null);
  const [stationRows, setStationRows] = useState<StationSeriesRow[]>([]);
  const [checkedRows, setCheckedRows] = useState<CheckedRow[]>([]);
  const [message, setMessage] = useState("");

  const runAll = useCallback(async () => {
    if (!stationFiles.length) { setActiveStep("station-files"); setMessage("请先导入国控站逐日CSV文件"); return; }
    if (!ionFile) { setActiveStep("merge-qc"); setMessage("请上传水溶性离子Excel文件"); return; }
    setMessage("输入完整，可以运行全部流程");
  }, [stationFiles, ionFile]);

  return { activeStep, setActiveStep, stationFiles, setStationFiles, ionFile, setIonFile, stationRows, setStationRows, checkedRows, setCheckedRows, message, runAll };
}
```

- [ ] **Step 3: Extend `runAll` by composing the tested domain functions**

Add these imports and replace the validation-only success branch with the following orchestration. Calculations stay in core modules; the hook owns progress and messages.

```ts
import { parseStationFile } from "../workers/workerClient";
import { buildHourlySeries } from "../core/stationSeries";
import { parseIonWorkbook } from "../core/ionWorkbook";
import { mergeHourly } from "../core/hourlyMerge";
import { runQualityControl } from "../core/qualityControl";

const parsed = await Promise.all(stationFiles.map((file) => parseStationFile(file, "3329A")));
setActiveStep("station-series");
const series = buildHourlySeries(parsed.flatMap((item) => item.rows));
setStationRows(series.rows);

setActiveStep("merge-qc");
const ions = parseIonWorkbook(await ionFile.arrayBuffer());
const checked = runQualityControl(mergeHourly(series.rows, ions.rows));
setCheckedRows(checked.rows);

setActiveStep("exports");
setMessage(`处理完成：${checked.rows.length} 个逐时样本，可预览并下载结果。`);
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- usePipeline.test.tsx`  
Expected: PASS.

```bash
git add src/pipeline/usePipeline.ts tests/unit/usePipeline.test.tsx
git commit -m "feat: orchestrate stepwise and one-click processing"
```

## Task 9: Implement the Accepted Cinematic UI

**Files:**
- Create: `public/assets/aerosol-hero-real.png`
- Create: `src/components/Hero.tsx`
- Create: `src/components/Workbench.tsx`
- Create: `src/components/StepRail.tsx`
- Create: `src/components/InspectionPanel.tsx`
- Create: `src/components/FileDropZone.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/app.css`
- Test: `tests/unit/Workbench.test.tsx`

- [ ] **Step 1: Copy the approved hero asset into the project**

Run:

```powershell
Copy-Item -LiteralPath '<LOCAL_DESIGN_SESSION>\content\aerosol-hero-real.png' -Destination 'public\assets\aerosol-hero-real.png'
```

Expected: the image exists inside the repository and no production code points to `.superpowers`.

- [ ] **Step 2: Write the failing workbench interaction test**

```tsx
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Workbench } from "../../src/components/Workbench";

describe("Workbench", () => {
  it("exposes five steps and the one-click action", () => {
    render(<Workbench />);
    expect(screen.getAllByRole("button", { name: /步骤/ })).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "一键完成全部" }));
    expect(screen.getByText("请先导入国控站逐日CSV文件")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Build the hero with code-native text and motion layers**

```tsx
// src/components/Hero.tsx
export function Hero() {
  const heroImage = `${import.meta.env.BASE_URL}assets/aerosol-hero-real.png`;
  return (
    <section className="hero" aria-labelledby="hero-title" style={{ "--hero-image": `url(${heroImage})` } as React.CSSProperties}>
      <div className="hero__photo" aria-hidden="true" />
      <div className="hero__fog hero__fog--back" aria-hidden="true" />
      <div className="hero__fog hero__fog--front" aria-hidden="true" />
      <div className="hero__particles" aria-hidden="true" />
      <nav className="hero__nav"><span>大气气溶胶数据工作台</span><a href="#workbench">数据工作台</a><a href="#guide">流程说明</a></nav>
      <div className="hero__content">
        <h1 id="hero-title">让不可见的<br />大气过程可分析</h1>
        <p>数据下载、站点提取、离子合并与质量控制，在一条可复现的路径中完成。</p>
        <a className="button button--primary" href="#workbench">开始处理数据</a>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Implement the three-column observatory layout and real interactions**

`Workbench` renders `StepRail`, the active-step content panel, and `InspectionPanel`. Build every apparent control with a semantic interactive element and a connected handler:

- navigation and generated download items: `<a href="...">`;
- five step cards, previous/next, link generation, one-click processing, preview tabs, and export actions: `<button type="button">`;
- upload/drop areas: visible `<label htmlFor>` connected to a real `<input type="file">`;
- active step: `aria-current="step"`; active preview tab: `aria-selected="true"`;
- busy actions: `disabled` plus `aria-busy="true"`, with progress text;
- result downloads: create a Blob URL, trigger a named download, then revoke the URL;
- decorative photo, fog, glow, and particle layers: `pointer-events:none`.

Do not render `<div>` or `<span>` elements with button-like styling. A click on each step card must switch the center panel; previous/next must change the active step; generated download links must open the corresponding CSV URL; every result row must expose a working download action.

- [ ] **Step 5: Implement motion and reduced-motion CSS**

```css
:root { color-scheme: dark; --ink:#07151c; --panel:rgba(9,31,39,.76); --cyan:#a8e4d8; --mist:#dcebed; }
.hero { min-height:100svh; position:relative; overflow:hidden; background:var(--ink); color:#f6fbfa; }
.hero__photo { position:absolute; inset:-3%; pointer-events:none; background-image:var(--hero-image); background-position:center; background-size:cover; animation:camera-breathe 16s ease-in-out infinite alternate; }
.hero__fog { position:absolute; left:-15%; width:130%; height:18%; pointer-events:none; filter:blur(36px); background:linear-gradient(90deg,transparent,rgba(220,235,237,.35),transparent); }
.hero__particles { pointer-events:none; }
.hero__fog--back { top:43%; animation:fog-drift 24s linear infinite; }
.hero__fog--front { top:66%; animation:fog-drift 32s linear infinite reverse; }
@keyframes camera-breathe { from { transform:scale(1.02) } to { transform:scale(1.07) translate3d(.6%,-.3%,0) } }
@keyframes fog-drift { from { transform:translateX(-9%) } to { transform:translateX(11%) } }
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; animation-duration:.001ms!important; animation-iteration-count:1!important; } }
```

- [ ] **Step 6: Run component tests and visually inspect**

Run: `npm test -- Workbench.test.tsx && npm run dev -- --host 127.0.0.1`  
Expected: tests PASS; hero matches the accepted concept; all five step controls are visible without overlapping.

- [ ] **Step 7: Commit**

```bash
git add public/assets src/components src/app tests/unit/Workbench.test.tsx
git commit -m "feat: build cinematic aerosol data workbench UI"
```

## Task 10: Validate Against Real Research Files

**Files:**
- Create: `tests/integration/realDataParity.test.ts`
- Create: `tests/fixtures/README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Keep real data outside Git**

Add these rules:

```gitignore
tests/private-fixtures/
*.inspect.ndjson
*.part
research-data/
dist/
node_modules/
.superpowers/
```

- [ ] **Step 2: Write the parity test using an environment-provided fixture directory**

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStationCsvText } from "../../src/core/stationCsv";
import { buildHourlySeries } from "../../src/core/stationSeries";

const fixtureDir = process.env.PRIVATE_STATION_FIXTURES;
const run = fixtureDir && existsSync(fixtureDir) ? describe : describe.skip;

run("real 3329A parity", () => {
  it("builds the expected November-December timeline", () => {
    const files = readdirSync(fixtureDir!).filter((name) => /^china_sites_2024(11|12)\d{2}\.csv$/.test(name));
    const rows = files.flatMap((name) => parseStationCsvText(readFileSync(`${fixtureDir}/${name}`, "utf8"), name, "3329A").rows);
    const series = buildHourlySeries(rows);
    expect(files).toHaveLength(61);
    expect(series.rows).toHaveLength(1464);
    expect(series.rows.find((row) => row.timestamp === "2024-11-15 18:00:00")).toMatchObject({ SO2: 0, NO2: 0, O3: 0, CO: 0, PM10: 0, "PM2.5": 0 });
  });
});
```

- [ ] **Step 3: Run parity tests against the existing directory**

Run:

```powershell
$env:PRIVATE_STATION_FIXTURES='<PRIVATE_STATION_FIXTURES>'; $env:PRIVATE_ION_WORKBOOK='<PRIVATE_ION_WORKBOOK>'; npm test -- tests/integration/realDataParity.test.ts
```

Expected: 61 files, 1464 continuous station/ion hours, and the documented station comparison record passes.

- [ ] **Step 4: Commit only tests and ignore rules**

```bash
git add tests/integration/realDataParity.test.ts tests/fixtures/README.md .gitignore
git commit -m "test: verify browser pipeline against research data"
```

## Task 11: Add End-to-End Browser Tests

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/workbench.spec.ts`

- [ ] **Step 1: Configure Playwright**

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  webServer: { command: "npm run dev -- --host 127.0.0.1", url: "http://127.0.0.1:5173", reuseExistingServer: true },
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
```

- [ ] **Step 2: Test the visible core workflow**

```ts
import { expect, test } from "@playwright/test";

test("generates links and reports missing inputs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /让不可见的大气过程可分析/ })).toBeVisible();
  await page.getByRole("link", { name: "开始处理数据" }).click();
  await page.getByLabel("开始日期").fill("2024-11-01");
  await page.getByLabel("结束日期").fill("2024-11-03");
  await page.getByRole("button", { name: "生成下载链接" }).click();
  await expect(page.getByText("china_sites_20241103.csv")).toBeVisible();
  await page.getByRole("button", { name: "一键完成全部" }).click();
  await expect(page.getByText("请先导入国控站逐日CSV文件")).toBeVisible();
});

test("respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const duration = await page.locator(".hero__photo").evaluate((element) => getComputedStyle(element).animationDuration);
  expect(duration).toBe("0.001ms");
});

test("every visible workbench control is operable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "开始处理数据" }).click();
  for (const step of ["步骤 1", "步骤 2", "步骤 3", "步骤 4", "步骤 5"]) {
    await page.getByRole("button", { name: new RegExp(step) }).click();
    await expect(page.getByRole("button", { name: new RegExp(step) })).toHaveAttribute("aria-current", "step");
  }
  await page.getByRole("button", { name: "上一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByLabel("导入国控站逐日 CSV 文件")).toBeAttached();
  await expect(page.getByLabel("导入水溶性离子 Excel 文件")).toBeAttached();
  await expect(page.locator("button:visible:not([disabled]), a:visible")).not.toHaveCount(0);
});
```

- [ ] **Step 3: Run end-to-end tests and commit**

Run: `npx playwright install chromium && npm run e2e`  
Expected: desktop and mobile tests PASS.

```bash
git add playwright.config.ts e2e
git commit -m "test: cover workbench flow in desktop and mobile browsers"
```

## Task 12: Add Documentation, Reference Python, and GitHub Pages Deployment

**Files:**
- Create: `README.md`
- Create: `.github/workflows/pages.yml`
- Create: `reference-python/*`

- [ ] **Step 1: Copy the verified Python reference files**

Run:

```powershell
Copy-Item -LiteralPath '<PRIVATE_REFERENCE_SCRIPTS>\station-downloader.py' -Destination 'reference-python\station-downloader.py'
Copy-Item -LiteralPath '<PRIVATE_REFERENCE_SCRIPTS>\station-extractor.py' -Destination 'reference-python\station-extractor.py'
Copy-Item -LiteralPath '<PRIVATE_REFERENCE_SCRIPTS>\README.md' -Destination 'reference-python\README.md'
```

- [ ] **Step 2: Document data privacy, units, workflow, and limitations**

Create `README.md` with these exact sections: project purpose; online address; five-step workflow; one-click workflow; data privacy; supported columns and units; local development; deployment; limitations; Python reference scripts. State explicitly that research files never leave the browser, CO uses mg/m³ while the other five pollutants use μg/m³, source files follow `china_sites_YYYYMMDD.csv`, GitHub Pages cannot execute Python, large-file processing is desktop-first, and zero values are preserved and flagged rather than deleted. Include the mirror pattern as a clickable Markdown link and label all generated-result links clearly.

- [ ] **Step 3: Add the Pages workflow**

```yaml
name: Deploy GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 4: Run all local checks and commit**

Run: `npm run lint && npm test && npm run build && npm run e2e`  
Expected: all commands PASS.

```bash
git add README.md .github/workflows/pages.yml reference-python
git commit -m "docs: add deployment and research workflow guidance"
```

## Task 13: Perform Visual Fidelity QA and Publish to GitHub

**Files:**
- Modify only files identified by the visual fidelity ledger.

- [ ] **Step 1: Check GitHub CLI prerequisites**

Run: `gh --version && gh auth status`  
Expected: GitHub CLI is installed and authenticated.

- [ ] **Step 2: Capture desktop and mobile screenshots**

Run the app and capture:

- desktop at 1440 × 1000;
- mobile at 390 × 844;
- workbench after generating three download links;
- reduced-motion mode.

- [ ] **Step 3: Compare against the approved concept**

Use `view_image` on both:

- accepted concept asset and dynamic mockup screenshot;
- latest desktop browser screenshot.

Write a fidelity ledger covering at least: real mountain asset, fog depth, typography, hero balance, pipeline controls, workbench three-column anatomy, responsive behavior, and reduced motion. Fix all material mismatches and rerun screenshots.

- [ ] **Step 4: Verify no private data is tracked**

Run:

```bash
git status --short
git ls-files | findstr /i "china_sites ion xlsx csv inspect research-data"
```

Expected: only deliberate small fixtures and reference code appear; no real research data or local absolute-path output files are tracked.

- [ ] **Step 5: Create the public repository and configure Pages**

Run:

```bash
gh repo create aerosol-data-workbench --public --source=. --remote=origin
gh api "repos/$(gh api user --jq .login)/aerosol-data-workbench/pages" -X POST -f build_type=workflow
git push -u origin main
```

Expected: repository creation succeeds and `main` tracks `origin/main`.

- [ ] **Step 6: Enable and verify Pages**

Run:

```bash
gh run watch
```

Expected: the Pages workflow succeeds. Open the published URL and repeat the download-link and missing-input checks.

- [ ] **Step 7: Record release state**

```bash
git status --short
git add src public tests e2e README.md .github
git commit -m "release: publish aerosol data workbench"
git push
```

Skip the release commit if visual fixes produced no new changes. Report the repository URL, Pages URL, commit hash, validations, and any intentional deviations.
