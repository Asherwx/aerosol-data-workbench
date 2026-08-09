import type { PipelineModel } from '../pipeline/usePipeline'

export function InspectionPanel({ pipeline }: { pipeline: PipelineModel }) {
  const parsedRows = pipeline.parsedStationFiles.reduce((total, file) => total + file.rows.length, 0)
  const metrics = [
    ['站点文件', pipeline.parsedStationFiles.length],
    ['源记录', parsedRows],
    ['逐时序列', pipeline.stationRows.length],
    ['站点质控', pipeline.stationQcResult?.rows.length ?? 0],
    ['合并质控', pipeline.mergedQcResult?.rows.length ?? 0],
  ] as const
  return (
    <aside className="inspection-panel glass-panel" aria-labelledby="inspection-title">
      <div className="panel-heading"><span className={`status-dot status-${pipeline.status}`} /><div><small>处理状态</small><h3 id="inspection-title">检查面板</h3></div></div>
      <div className="progress-block"><div><span className="status-live" aria-live="polite">{pipeline.message || '等待开始'}</span><strong>{Math.round(pipeline.progress)}%</strong></div><progress aria-label="处理进度" max="100" value={pipeline.progress}>{pipeline.progress}%</progress></div>
      <dl className="metric-list">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {pipeline.warnings.length > 0 ? <div className="warning-list"><h4>警告</h4><ul>{pipeline.warnings.slice(0, 8).map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : <p className="quiet-state">暂无警告</p>}
    </aside>
  )
}
