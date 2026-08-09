import { useEffect, useId, useMemo, useState } from 'react'

import type { UserDataMapping, UserMappingRequired, UserVariableSpec } from '../core/userDataset'

const MAX_VISIBLE_COLUMNS = 24

function boundedLabel(value: string) {
  return value.trim().slice(0, 120) || '未命名列'
}

export function ColumnMappingPanel({ required, disabled, onSubmit }: {
  required: UserMappingRequired
  disabled: boolean
  onSubmit(mapping: UserDataMapping): void
}) {
  const baseId = useId()
  const columns = useMemo(() => required.columns.slice(0, MAX_VISIBLE_COLUMNS), [required])
  const [timestampColumn, setTimestampColumn] = useState<number | null>(null)
  const [variables, setVariables] = useState<Record<number, UserVariableSpec>>({})

  useEffect(() => {
    setTimestampColumn(null)
    setVariables({})
  }, [required])

  const toggleVariable = (sourceColumn: number, label: string) => {
    setVariables((current) => {
      const next = { ...current }
      if (next[sourceColumn]) delete next[sourceColumn]
      else next[sourceColumn] = {
        sourceColumn,
        key: `variable_${sourceColumn + 1}`,
        label: boundedLabel(label),
        unit: '',
        nonNegative: true,
      }
      return next
    })
  }
  const selected = Object.values(variables).filter((variable) => variable.sourceColumn !== timestampColumn)
  const valid = timestampColumn !== null && selected.length > 0

  return (
    <fieldset className="mapping-panel" aria-label="字段映射" disabled={disabled}>
      <legend>字段映射</legend>
      <p>未能唯一识别时间列。请选择一个时间列和至少一个变量列。</p>
      <label className="mapping-time" htmlFor={`${baseId}-time`}>时间列
        <select id={`${baseId}-time`} value={timestampColumn ?? ''} onChange={(event) => setTimestampColumn(event.target.value === '' ? null : Number(event.target.value))}>
          <option value="">请选择</option>
          {columns.map((column) => <option key={column.sourceColumn} value={column.sourceColumn}>{boundedLabel(column.label)}</option>)}
        </select>
      </label>
      <div className="mapping-columns">
        {columns.map((column) => {
          const label = boundedLabel(column.label)
          const checked = Boolean(variables[column.sourceColumn])
          const variable = variables[column.sourceColumn]
          const inputId = `${baseId}-variable-${column.sourceColumn}`
          return (
            <div className="mapping-row" key={column.sourceColumn}>
              <label htmlFor={inputId} className="mapping-variable">
                <input id={inputId} type="checkbox" aria-label={`选择变量 ${label}`} checked={checked} disabled={disabled || timestampColumn === column.sourceColumn} onChange={() => toggleVariable(column.sourceColumn, label)} />
                <span title={label}>{label}</span>
              </label>
              {checked ? (
                <div className="mapping-options">
                  <label>单位 {label}<input type="text" value={variable.unit} onChange={(event) => setVariables((current) => ({ ...current, [column.sourceColumn]: { ...current[column.sourceColumn], unit: event.target.value.slice(0, 48) } }))} /></label>
                  <label className="check-label"><input type="checkbox" checked={variable.nonNegative} onChange={(event) => setVariables((current) => ({ ...current, [column.sourceColumn]: { ...current[column.sourceColumn], nonNegative: event.target.checked } }))} />非负 {label}</label>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {required.columns.length > MAX_VISIBLE_COLUMNS ? <p className="field-note">仅显示前 {MAX_VISIBLE_COLUMNS} 列，共 {required.columns.length} 列。</p> : null}
      <button type="button" className="panel-action" disabled={disabled || !valid} onClick={() => {
        if (timestampColumn === null || selected.length === 0) return
        onSubmit({ timestampColumn, variables: selected })
      }}>应用字段映射</button>
    </fieldset>
  )
}
