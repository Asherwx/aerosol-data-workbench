import { PIPELINE_STEPS, type PipelineStep } from '../pipeline/usePipeline'

export const STEP_LABELS: Record<PipelineStep, string> = {
  'data-source': '获取或导入数据',
  'station-series': '构建逐时序列',
  'quality-control': '数据质控',
  exports: '导出结果',
}

interface StepRailProps {
  activeStep: PipelineStep
  disabled?: boolean
  onSelect(step: PipelineStep): void
}

export function StepRail({ activeStep, disabled = false, onSelect }: StepRailProps) {
  return (
    <nav className="step-rail" aria-label="处理步骤">
      {PIPELINE_STEPS.map((step, index) => (
        <button
          key={step}
          type="button"
          className="step-card"
          aria-current={activeStep === step ? 'step' : undefined}
          disabled={disabled}
          onClick={() => onSelect(step)}
        >
          <span className="step-number">0{index + 1}</span>
          <span>{STEP_LABELS[step]}</span>
        </button>
      ))}
    </nav>
  )
}
