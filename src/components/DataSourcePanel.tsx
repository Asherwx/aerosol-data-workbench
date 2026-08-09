import type { PipelineModel } from '../pipeline/usePipeline'
import { FileDropZone } from './FileDropZone'
import { Icon } from './Icon'

export function DataSourcePanel({ pipeline, busy }: { pipeline: PipelineModel; busy: boolean }) {
  const progress = pipeline.downloadProgress
  return (
    <>
      <h3 id="active-panel-title">获取或导入数据</h3>
      <p className="panel-intro">选择在线获取或本地导入。切换路径不会清空已经填写的日期、站点和文件。</p>
      <div className="source-layout">
        <section className="source-major" aria-labelledby="online-source-title">
          <div className="section-heading"><span>ONLINE</span><h4 id="online-source-title">在线获取</h4></div>
          <div className="source-choice-grid">
            <button type="button" className="choice-card" aria-label="生成公开链接" aria-pressed={pipeline.sourceMode === 'online-links'} disabled={busy} onClick={() => pipeline.setSourceMode('online-links')}>
              <small>A</small><strong>生成公开链接</strong><span>仅按日期生成国控逐日原始文件链接</span>
            </button>
            <button type="button" className="choice-card" aria-label="站点直连下载" aria-pressed={pipeline.sourceMode === 'online-station'} disabled={busy} onClick={() => pipeline.setSourceMode('online-station')}>
              <small>B</small><strong>站点直连下载</strong><span>按日期和站点下载，并直接进入工作流</span>
            </button>
          </div>
          {pipeline.sourceMode === 'online-links' || pipeline.sourceMode === 'online-station' ? (
            <div className="source-detail">
              <div className={`form-grid ${pipeline.sourceMode === 'online-station' ? 'three' : 'two'}`}>
                <label>开始日期<input type="date" disabled={busy} value={pipeline.startDate} onChange={(event) => pipeline.setStartDate(event.target.value)} /></label>
                <label>结束日期<input type="date" disabled={busy} value={pipeline.endDate} onChange={(event) => pipeline.setEndDate(event.target.value)} /></label>
                {pipeline.sourceMode === 'online-station' ? <label>站点编号<input type="text" disabled={busy} value={pipeline.stationId} onChange={(event) => pipeline.setStationId(event.target.value)} /></label> : null}
              </div>
              <button type="button" className="panel-action" disabled={busy || !pipeline.canRun('data-source')} aria-busy={busy || undefined} onClick={() => { void pipeline.runStep('data-source') }}>
                <Icon name={pipeline.sourceMode === 'online-links' ? 'arrow' : 'download'} />
                {pipeline.sourceMode === 'online-links' ? '生成下载链接' : '下载并使用站点数据'}
              </button>
            </div>
          ) : null}
          {progress ? (
            <div className="download-progress" role="status" aria-label="站点下载状态">
              <div><span>站点数据下载进度</span><strong>{progress.completed}/{progress.total}</strong></div>
              <progress aria-label="站点下载进度" max={Math.max(progress.total, 1)} value={progress.completed} />
              <small>失败 {progress.failed} 日</small>
            </div>
          ) : null}
          {pipeline.sourceMode === 'online-station' && pipeline.sourceStatus === 'ready' ? <p className="summary-line">已准备 {pipeline.parsedStationFiles.length} 个站点文件</p> : null}
          {pipeline.downloadLinks.length > 0 ? (
            <ul className="result-links" aria-label="已生成下载链接">
              {pipeline.downloadLinks.map((link) => <li key={link.url}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.filename}</a><span>{link.date}</span></li>)}
            </ul>
          ) : null}
        </section>

        <section className="source-major" aria-labelledby="local-source-title">
          <div className="section-heading"><span>LOCAL</span><h4 id="local-source-title">本地导入</h4></div>
          <button type="button" className="choice-card choice-card-wide" aria-label="本地导入 CSV" aria-pressed={pipeline.sourceMode === 'local-import'} disabled={busy} onClick={() => pipeline.setSourceMode('local-import')}>
            <small>C</small><strong>本地导入 CSV</strong><span>多个 china_sites 逐日文件，或一个站点宽表 CSV</span>
          </button>
          {pipeline.sourceMode === 'local-import' ? (
            <div className="source-detail">
              <div className="form-grid"><label>站点编号<input type="text" disabled={busy} value={pipeline.stationId} onChange={(event) => pipeline.setStationId(event.target.value)} /></label></div>
              <FileDropZone kind="csv" multiple disabled={busy} files={pipeline.stationFiles} onChange={pipeline.setStationFiles} />
              <p className="field-note">选择文件后自动识别格式并解析，无需额外操作。</p>
              {pipeline.sourceStatus === 'parsing' ? <p className="summary-line" role="status">正在解析所选文件…</p> : null}
              {pipeline.sourceStatus === 'ready' ? <p className="summary-line">已准备 {pipeline.parsedStationFiles.length} 个站点文件</p> : null}
            </div>
          ) : null}
        </section>
      </div>
      {pipeline.sourceMode === null ? <p className="prerequisite">请选择一种数据获取路径。</p> : null}
    </>
  )
}
