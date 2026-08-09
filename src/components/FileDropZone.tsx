import { useId, useState } from 'react'

import { Icon } from './Icon'

interface FileDropZoneProps {
  kind: 'csv' | 'xlsx' | 'data'
  files: File[]
  multiple?: boolean
  disabled?: boolean
  onChange(files: File[]): void
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function isAccepted(file: File, kind: 'csv' | 'xlsx' | 'data') {
  const name = file.name.toLowerCase()
  const csv = name.endsWith('.csv') || file.type === 'text/csv'
  const xlsx = name.endsWith('.xlsx') || file.type === XLSX_TYPE
  return kind === 'csv' ? csv : kind === 'xlsx' ? xlsx : csv || xlsx
}

export function FileDropZone({ kind, files, multiple = false, disabled = false, onChange }: FileDropZoneProps) {
  const inputId = useId()
  const [error, setError] = useState('')
  const label = kind === 'csv' ? '选择 CSV 文件' : kind === 'xlsx' ? '选择 XLSX 文件' : '选择 CSV 或 XLSX 文件'

  const receive = (incoming: File[]) => {
    if (disabled) return
    const accepted = incoming.filter((file) => isAccepted(file, kind))
    if (accepted.length !== incoming.length) setError(kind === 'data' ? '仅支持 CSV 或 XLSX 文件' : `仅支持 ${kind.toUpperCase()} 文件`)
    else setError('')
    if (accepted.length > 0) onChange(multiple ? [...files, ...accepted] : [accepted[0]])
  }

  return (
    <div className="file-control">
      <label htmlFor={inputId} className="drop-zone" aria-disabled={disabled} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
        event.preventDefault()
        receive(Array.from(event.dataTransfer.files))
      }}>
        <Icon name="file" />
        <span><strong>{label}</strong><small>点击选择或拖放到这里</small></span>
      </label>
      <input id={inputId} className="visually-hidden" type="file" disabled={disabled} accept={kind === 'csv' ? '.csv,text/csv' : kind === 'xlsx' ? `.xlsx,${XLSX_TYPE}` : `.csv,text/csv,.xlsx,${XLSX_TYPE}`} multiple={multiple} aria-label={label} onChange={(event) => {
        receive(Array.from(event.currentTarget.files ?? []))
        event.currentTarget.value = ''
      }} />
      {error ? <p className="inline-alert" role="alert">{error}</p> : null}
      {files.length > 0 ? (
        <ul className="file-list" aria-label="已选择文件">
          {files.map((file, index) => (
            <li key={`${file.name}-${file.lastModified}-${index}`}><span>{file.name}</span><button type="button" disabled={disabled} aria-label={`移除 ${file.name}`} onClick={() => onChange(files.filter((_, fileIndex) => fileIndex !== index))}><Icon name="x" /></button></li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
