export function PreviewTable({ caption, rows }: { caption: string; rows: readonly Record<string, unknown>[] }) {
  const preview = rows.slice(0, 50)
  const columns = preview.length > 0 ? Object.keys(preview[0]).slice(0, 8) : []
  if (preview.length === 0) return <p className="empty-state">暂无可预览记录</p>
  return (
    <div className="table-wrap">
      <table>
        <caption>{caption}（前 {preview.length} 行）</caption>
        <thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{preview.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{Array.isArray(row[column]) ? (row[column] as unknown[]).join('、') : String(row[column] ?? '—')}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}
