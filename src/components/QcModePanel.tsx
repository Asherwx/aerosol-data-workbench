import { useId } from 'react'

import type { PipelineModel, QcMode } from '../pipeline/usePipeline'
import { ColumnMappingPanel } from './ColumnMappingPanel'
import { FileDropZone } from './FileDropZone'
import { Icon } from './Icon'
import { QcPreviewTabs } from './QcPreviewTabs'

function ModeCard({ mode, selected, disabled, title, description, name, onSelect }: {
  mode: QcMode
  selected: boolean
  disabled: boolean
  title: string
  description: string
  name: string
  onSelect(): void
}) {
  const id = useId()
  return (
    <label htmlFor={id} className="mode-card" data-selected={selected || undefined}>
      <input id={id} type="radio" name={name} value={mode} aria-label={title} checked={selected} disabled={disabled} onChange={onSelect} />
      <span><strong>{title}</strong><small>{description}</small></span>
    </label>
  )
}

function ResultSummary({ title, result }: { title: string; result: NonNullable<PipelineModel['qcResult']> }) {
  return (
    <section className="qc-result" aria-label={title}>
      <div className="result-heading"><h4>{title}</h4><span>已完成</span></div>
      <dl className="qc-counts"><div><dt>保留</dt><dd>{result.keptRows.length}</dd></div><div><dt>剔除</dt><dd>{result.rejectedRows.length}</dd></div></dl>
      <QcPreviewTabs keptRows={result.keptRows as unknown as Record<string, unknown>[]} rejectedRows={result.rejectedRows as unknown as Record<string, unknown>[]} />
    </section>
  )
}

export function QcModePanel({ pipeline, busy }: { pipeline: PipelineModel; busy: boolean }) {
  const radioName = useId()
  const readyForQc = pipeline.stationSeriesResult !== null
  return (
    <>
      <h3 id="active-panel-title">数据质控</h3>
      <p className="panel-intro">两种质控互相独立；切换模式不会移除另一种模式已经生成的结果。</p>
      {!readyForQc ? <p className="prerequisite">请先获取或导入站点数据，并构建逐时序列</p> : null}
      <fieldset className="mode-selector" disabled={busy}>
        <legend className="visually-hidden">质控模式</legend>
        <ModeCard mode="station" name={radioName} selected={pipeline.qcMode === 'station'} disabled={busy} title="站点数据质控" description="仅使用标准站点逐时序列，无需用户文件" onSelect={() => pipeline.setQcMode('station')} />
        <ModeCard mode="merged" name={radioName} selected={pipeline.qcMode === 'merged'} disabled={busy} title="用户数据合并质控" description="合并用户 CSV 或 XLSX 后独立执行质控" onSelect={() => pipeline.setQcMode('merged')} />
      </fieldset>

      {pipeline.qcMode === 'merged' ? (
        <div className="merged-input">
          <FileDropZone kind="data" disabled={busy} files={pipeline.userDataFile ? [pipeline.userDataFile] : []} onChange={(files) => pipeline.setUserDataFile(files[0] ?? null)} />
          {pipeline.userDataStatus === 'parsing' ? <p className="summary-line" role="status">正在自动解析用户数据…</p> : null}
          {pipeline.userDataStatus === 'ready' ? <p className="summary-line">用户数据已准备：{pipeline.parsedUserDataset?.rows.length ?? 0} 行</p> : null}
          {pipeline.userDataError ? <p className="inline-alert" role="alert">{pipeline.userDataError}</p> : null}
          {pipeline.userMappingRequired && pipeline.userDataFile ? (
            <ColumnMappingPanel required={pipeline.userMappingRequired} disabled={busy} onSubmit={(mapping) => pipeline.setUserDataFile(pipeline.userDataFile, mapping)} />
          ) : null}
        </div>
      ) : null}

      <button type="button" className="panel-action" disabled={busy || !pipeline.canRun('quality-control') || pipeline.qcMode === null} aria-busy={busy || undefined} onClick={() => { if (pipeline.qcMode) void pipeline.runQcMode(pipeline.qcMode) }}>
        <Icon name="play" />运行当前质控
      </button>
      <div className="qc-results">
        {pipeline.stationQcResult ? <ResultSummary title="站点质控结果" result={pipeline.stationQcResult} /> : null}
        {pipeline.mergedQcResult ? <ResultSummary title="合并质控结果" result={pipeline.mergedQcResult} /> : null}
      </div>
    </>
  )
}
