import heroWebpLarge from '../assets/aerosol-hero-static-v2-1680.webp'
import heroWebpSmall from '../assets/aerosol-hero-static-v2-960.webp'
import heroFallback from '../assets/aerosol-hero-static-v2.png'
import { PIPELINE_STEPS, type PipelineStep } from '../pipeline/usePipeline'
import { STEP_LABELS } from './StepRail'

interface HeroProps {
  activeStep: PipelineStep
  onSelect(step: PipelineStep): void
}

export function Hero({ activeStep, onSelect }: HeroProps) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <picture className="hero-photo" aria-hidden="true">
        <source type="image/webp" srcSet={`${heroWebpSmall} 960w, ${heroWebpLarge} 1672w`} sizes="100vw" />
        <img src={heroFallback} width="1672" height="941" alt="" aria-hidden="true" {...{ fetchpriority: 'high' }} decoding="async" />
      </picture>
      <header className="hero-nav">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <strong>江峰课题组</strong>
        </div>
      </header>
      <div className="hero-copy">
        <p className="hero-kicker">MAKING INVISIBLE ATMOSPHERIC PROCESSES ANALYZABLE</p>
        <h1 id="hero-title">让不可见的<br />大气过程可分析</h1>
      </div>
      <nav className="hero-stage-nav" aria-label="快速进入处理阶段">
        {PIPELINE_STEPS.map((step, index) => (
          <button
            key={step}
            type="button"
            aria-label={STEP_LABELS[step]}
            aria-current={activeStep === step ? 'step' : undefined}
            onClick={() => onSelect(step)}
          >
            <span>0{index + 1}</span>
            <strong>{STEP_LABELS[step]}</strong>
          </button>
        ))}
      </nav>
    </section>
  )
}
