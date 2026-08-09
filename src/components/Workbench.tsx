import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { NamedArtifact, ResultArtifacts } from '../core/exports'
import { buildCombinedQcDownload, type MergedQcArtifacts, type StationQcArtifacts } from '../core/qcModeExports'
import { PIPELINE_STEPS, type PipelineModel } from '../pipeline/usePipeline'
import { DataSourcePanel } from './DataSourcePanel'
import { Icon } from './Icon'
import { InspectionPanel } from './InspectionPanel'
import { PreviewTable } from './PreviewTable'
import { QcModePanel } from './QcModePanel'
import { STEP_LABELS, StepRail } from './StepRail'

type DownloadFn = (content: Blob, filename: string) => void
type CombinedDownloadBuilder = typeof buildCombinedQcDownload

function hasCompletedWork(pipeline: PipelineModel): boolean {
  return pipeline.downloadLinks.length > 0
    || pipeline.parsedStationFiles.length > 0
    || pipeline.stationSeriesResult !== null
    || pipeline.stationQcResult !== null
    || pipeline.mergedQcResult !== null
    || Object.values(pipeline.exportArtifactsByMode).some(Boolean)
}

function artifactBlob(content: string | Blob, type = 'text/plain;charset=utf-8') {
  return content instanceof Blob ? content : new Blob([content], { type })
}

function ActionButton({ busy, disabled = false, onClick, children }: {
  busy: boolean
  disabled?: boolean
  onClick(): void
  children: ReactNode
}) {
  return (
    <button type="button" className="panel-action" disabled={busy || disabled} aria-busy={busy || undefined} onClick={onClick}>
      <Icon name="play" />{children}
    </button>
  )
}

function StationSeriesPanel({ pipeline, busy }: { pipeline: PipelineModel; busy: boolean }) {
  const ready = pipeline.canRun('station-series') || pipeline.stationSeriesResult !== null
  return (
    <>
      <h3 id="active-panel-title">构建逐时序列</h3>
      <p className="panel-intro">从上一步的标准站点数据构建连续逐时序列，并明确标注缺测；本阶段不重复导入或转换格式。</p>
      {!ready ? <p className="prerequisite">请先获取或导入站点数据</p> : null}
      <ActionButton busy={busy} disabled={!pipeline.canRun('station-series')} onClick={() => { void pipeline.runStep('station-series') }}>构建逐时序列</ActionButton>
      {pipeline.stationSeriesResult ? (
        <div className="series-preview">
          <p className="summary-line">当前序列 {pipeline.stationRows.length} 行</p>
          <PreviewTable caption="站点逐时序列预览" rows={pipeline.stationRows as unknown as Record<string, unknown>[]} />
        </div>
      ) : null}
    </>
  )
}

function artifactEntries(artifacts: ResultArtifacts): NamedArtifact<string | Blob>[] {
  return Object.values(artifacts) as NamedArtifact<string | Blob>[]
}

function ArtifactList({ artifacts, download, busy }: { artifacts: ResultArtifacts; download: DownloadFn; busy: boolean }) {
  return (
    <ul className="artifact-list">
      {artifactEntries(artifacts).map((artifact) => (
        <li key={artifact.name}>
          <div><Icon name="file" /><span>{artifact.name}</span></div>
          <button type="button" disabled={busy} aria-label={`下载 ${artifact.name}`} onClick={() => download(artifactBlob(artifact.content), artifact.name)}><Icon name="download" />下载</button>
        </li>
      ))}
    </ul>
  )
}

function ExportsPanel({ pipeline, download, busy, combining, combinedStatus, onDownloadAll }: {
  pipeline: PipelineModel
  download: DownloadFn
  busy: boolean
  combining: boolean
  combinedStatus: string
  onDownloadAll(): void
}) {
  const station = pipeline.exportArtifactsByMode.station
  const merged = pipeline.exportArtifactsByMode.merged
  const currentMode = pipeline.qcMode
  const canGenerate = pipeline.canRun('exports')
  const guidance = currentMode === 'merged' ? '请先完成“用户数据合并质控”' : '请先完成“站点数据质控”'
  return (
    <>
      <h3 id="active-panel-title">导出结果</h3>
      <p className="panel-intro">分别生成站点质控与合并质控结果包；文件只会在你明确点击下载时保存。</p>
      {!canGenerate && !pipeline.exportArtifacts ? <p className="prerequisite">{guidance}</p> : null}
      <ActionButton busy={busy} disabled={!canGenerate || currentMode === null} onClick={() => { void pipeline.runStep('exports') }}>
        生成{currentMode === 'merged' ? '合并质控' : '站点质控'}导出文件
      </ActionButton>
      <div className="export-groups">
        {station ? <section className="artifact-group" aria-label="站点质控结果文件"><div className="result-heading"><h4>站点质控结果</h4><span>独立结果包</span></div><ArtifactList artifacts={station} download={download} busy={busy} /></section> : null}
        {merged ? <section className="artifact-group" aria-label="合并质控结果文件"><div className="result-heading"><h4>合并质控结果</h4><span>独立结果包</span></div><ArtifactList artifacts={merged} download={download} busy={busy} /></section> : null}
      </div>
      {station && merged ? <button type="button" className="download-all" disabled={busy} aria-busy={combining || undefined} onClick={onDownloadAll}><Icon name="download" />下载全部结果</button> : null}
      {combinedStatus ? <p className="combined-export-status" role="status" aria-live="polite">{combinedStatus}</p> : null}
    </>
  )
}

function StepPanel({ pipeline, download, busy, combining, combinedStatus, onDownloadAll }: {
  pipeline: PipelineModel
  download: DownloadFn
  busy: boolean
  combining: boolean
  combinedStatus: string
  onDownloadAll(): void
}) {
  if (pipeline.activeStep === 'data-source') return <DataSourcePanel pipeline={pipeline} busy={busy} />
  if (pipeline.activeStep === 'station-series') return <StationSeriesPanel pipeline={pipeline} busy={busy} />
  if (pipeline.activeStep === 'quality-control') return <QcModePanel pipeline={pipeline} busy={busy} />
  return <ExportsPanel pipeline={pipeline} download={download} busy={busy} combining={combining} combinedStatus={combinedStatus} onDownloadAll={onDownloadAll} />
}

export function Workbench({ pipeline, download, buildCombinedDownload = buildCombinedQcDownload }: {
  pipeline: PipelineModel
  download: DownloadFn
  buildCombinedDownload?: CombinedDownloadBuilder
}) {
  const combinedControllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const [combining, setCombining] = useState(false)
  const [combinedStatus, setCombinedStatus] = useState('')
  const index = PIPELINE_STEPS.indexOf(pipeline.activeStep)
  const pipelineBusy = pipeline.status === 'running' || pipeline.sourceStatus === 'parsing' || pipeline.userDataStatus === 'parsing'
  const busy = pipelineBusy || combining
  const runAllLabel = pipeline.activeStep === 'data-source' && !hasCompletedWork(pipeline)
    ? '一键完成全部'
    : '从当前步骤继续'
  const previousStep = index > 0 ? PIPELINE_STEPS[index - 1] : null
  const nextStep = index < PIPELINE_STEPS.length - 1 ? PIPELINE_STEPS[index + 1] : null

  const downloadAll = useCallback(async () => {
    const station = pipeline.exportArtifactsByMode.station
    const merged = pipeline.exportArtifactsByMode.merged
    if (!station || !merged || pipelineBusy || combinedControllerRef.current) return
    const controller = new AbortController()
    combinedControllerRef.current = controller
    setCombining(true)
    setCombinedStatus('正在打包全部结果')
    try {
      const combined = await buildCombinedDownload({
        station: station as unknown as StationQcArtifacts,
        merged: merged as unknown as MergedQcArtifacts,
      }, { signal: controller.signal, timeoutMs: 30_000 })
      if (controller.signal.aborted || combinedControllerRef.current !== controller) return
      download(combined.content, combined.name)
      setCombinedStatus('全部结果已下载')
    } catch (cause) {
      if (combinedControllerRef.current !== controller) return
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        setCombinedStatus('全部结果打包已取消')
      } else {
        setCombinedStatus('全部结果打包失败，请重试')
      }
    } finally {
      if (combinedControllerRef.current === controller) {
        combinedControllerRef.current = null
        if (mountedRef.current) setCombining(false)
      }
    }
  }, [buildCombinedDownload, download, pipeline.exportArtifactsByMode.merged, pipeline.exportArtifactsByMode.station, pipelineBusy])

  const cancel = useCallback(() => {
    pipeline.cancel()
    const controller = combinedControllerRef.current
    if (!controller) return
    combinedControllerRef.current = null
    controller.abort()
    setCombining(false)
    setCombinedStatus('全部结果打包已取消')
  }, [pipeline])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const controller = combinedControllerRef.current
      combinedControllerRef.current = null
      controller?.abort()
    }
  }, [])

  return (
    <section id="workbench" className="workbench" aria-labelledby="workbench-title" aria-busy={busy || undefined}>
      <header className="workbench-header">
        <h2 id="workbench-title">数据工作台</h2>
        <div className="workbench-actions">
          {pipeline.error || pipeline.message ? <p className="workflow-command-status" aria-live="polite">{pipeline.error || pipeline.message}</p> : null}
          <button type="button" className="run-all-action" disabled={busy} aria-busy={busy || undefined} onClick={() => { void pipeline.runAll() }}><Icon name="play" />{runAllLabel}</button>
          {busy ? <button type="button" className="cancel-action" onClick={cancel}>取消处理</button> : null}
        </div>
      </header>
      <div className="workbench-layout">
        <StepRail activeStep={pipeline.activeStep} disabled={busy} onSelect={pipeline.setActiveStep} />
        <article id={`workbench-panel-${pipeline.activeStep}`} className="active-panel glass-panel" tabIndex={-1} aria-labelledby="active-panel-title" aria-busy={busy || undefined}>
          <span className="panel-step">STEP 0{index + 1}</span>
          <StepPanel pipeline={pipeline} download={download} busy={busy} combining={combining} combinedStatus={combinedStatus} onDownloadAll={() => { void downloadAll() }} />
          <footer className="panel-navigation">
            <button type="button" disabled={busy || previousStep === null} onClick={() => { if (previousStep) pipeline.setActiveStep(previousStep) }}>上一步</button>
            <span>{STEP_LABELS[pipeline.activeStep]}</span>
            <button type="button" disabled={busy || nextStep === null} onClick={() => { if (nextStep) pipeline.setActiveStep(nextStep) }}>下一步</button>
          </footer>
        </article>
        <InspectionPanel pipeline={pipeline} />
      </div>
      {pipeline.error ? <p className="global-alert" role="alert">{pipeline.error}</p> : null}
    </section>
  )
}
