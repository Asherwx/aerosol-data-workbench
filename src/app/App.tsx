import { useEffect, useRef } from 'react'

import { Hero } from '../components/Hero'
import { Workbench } from '../components/Workbench'
import { downloadArtifact } from '../core/exports'
import { usePipeline, type DownloadFn, type PipelineServices } from '../pipeline/usePipeline'

interface AppProps {
  services?: PipelineServices
  download?: DownloadFn
  stationEndpoint?: string
}

export function App({ services, download = downloadArtifact, stationEndpoint }: AppProps) {
  const pipeline = usePipeline({
    ...(services ? { services } : {}),
    ...(stationEndpoint ? { stationEndpoint } : {}),
    download,
  })
  const previousStepRef = useRef(pipeline.activeStep)

  useEffect(() => {
    if (previousStepRef.current === pipeline.activeStep) return
    previousStepRef.current = pipeline.activeStep
    let current = true
    queueMicrotask(() => {
      if (!current) return
      const panel = document.getElementById(`workbench-panel-${pipeline.activeStep}`)
      if (!(panel instanceof HTMLElement)) return
      panel.focus({ preventScroll: true })
      const reducedMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      panel.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    })
    return () => { current = false }
  }, [pipeline.activeStep])

  return <main><Hero activeStep={pipeline.activeStep} onSelect={pipeline.setActiveStep} /><Workbench pipeline={pipeline} download={download} /></main>
}
