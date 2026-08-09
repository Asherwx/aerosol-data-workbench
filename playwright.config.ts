import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const baseURL = 'http://127.0.0.1:4173/aerosol-data-workbench/'
const stationDataEndpoint = `${baseURL}v1/station-day`

function findLocalChrome(): string | undefined {
  const override = process.env.PLAYWRIGHT_CHROME_EXECUTABLE
  if (override) {
    if (!existsSync(override)) throw new Error(`PLAYWRIGHT_CHROME_EXECUTABLE does not exist: ${override}`)
    return override
  }
  if (process.env.CI) return undefined

  const candidates = process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']

  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
}

const localChrome = findLocalChrome()

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    launchOptions: localChrome ? { executablePath: localChrome } : undefined,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    env: { ...process.env, VITE_STATION_API_URL: stationDataEndpoint },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile-chromium', use: { viewport: { width: 390, height: 844 } } },
  ],
})
