import { useId, useRef, useState } from 'react'

import { PreviewTable } from './PreviewTable'

type QcTab = 'kept' | 'rejected'

interface QcPreviewTabsProps {
  keptRows: readonly Record<string, unknown>[]
  rejectedRows: readonly Record<string, unknown>[]
}

const TAB_ORDER: QcTab[] = ['kept', 'rejected']

export function QcPreviewTabs({ keptRows, rejectedRows }: QcPreviewTabsProps) {
  const [selected, setSelected] = useState<QcTab>('kept')
  const baseId = useId()
  const keptRef = useRef<HTMLButtonElement>(null)
  const rejectedRef = useRef<HTMLButtonElement>(null)
  const refs = { kept: keptRef, rejected: rejectedRef }
  const tabs = {
    kept: { label: '保留记录', rows: keptRows, caption: '质控保留记录' },
    rejected: { label: '剔除记录', rows: rejectedRows, caption: '质控剔除记录' },
  }

  const selectAndFocus = (tab: QcTab) => {
    setSelected(tab)
    refs[tab].current?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: QcTab) => {
    const index = TAB_ORDER.indexOf(current)
    let next: QcTab | null = null
    if (event.key === 'ArrowRight') next = TAB_ORDER[(index + 1) % TAB_ORDER.length]
    else if (event.key === 'ArrowLeft') next = TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length]
    else if (event.key === 'Home') next = TAB_ORDER[0]
    else if (event.key === 'End') next = TAB_ORDER.at(-1) ?? TAB_ORDER[0]
    if (!next) return
    event.preventDefault()
    selectAndFocus(next)
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="质控结果预览">
        {TAB_ORDER.map((tab) => {
          const tabId = `${baseId}-${tab}-tab`
          const panelId = `${baseId}-${tab}-panel`
          return (
            <button
              key={tab}
              ref={refs[tab]}
              id={tabId}
              role="tab"
              type="button"
              aria-selected={selected === tab}
              aria-controls={panelId}
              tabIndex={selected === tab ? 0 : -1}
              onClick={() => setSelected(tab)}
              onKeyDown={(event) => handleKeyDown(event, tab)}
            >
              {tabs[tab].label}
            </button>
          )
        })}
      </div>
      {TAB_ORDER.map((tab) => (
        <div
          key={tab}
          id={`${baseId}-${tab}-panel`}
          role="tabpanel"
          aria-labelledby={`${baseId}-${tab}-tab`}
          hidden={selected !== tab}
        >
          <PreviewTable caption={tabs[tab].caption} rows={tabs[tab].rows} />
        </div>
      ))}
    </>
  )
}
