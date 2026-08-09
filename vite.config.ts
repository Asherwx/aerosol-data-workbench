import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function requirePagesStationApiUrl(mode: string): void {
  const configured = loadEnv(mode, process.cwd(), '').VITE_STATION_API_URL?.trim()
  if (!configured) throw new Error('VITE_STATION_API_URL is required for a Pages production build')

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new Error('VITE_STATION_API_URL must be a valid HTTPS URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('VITE_STATION_API_URL must use HTTPS with no credentials or fragment')
  }
}

export default defineConfig(({ command, isPreview, mode }) => {
  if (command === 'build' && mode === 'pages') requirePagesStationApiUrl(mode)

  return {
    base:
      command === 'build' || isPreview ? '/aerosol-data-workbench/' : '/',
    plugins: [react()],
    worker: {
      format: 'es',
    },
  }
})
