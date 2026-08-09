import type { SVGProps } from 'react'

type IconName = 'arrow' | 'download' | 'file' | 'play' | 'x'

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    download: <><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 20h14" /></>,
    file: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v5h4" /></>,
    play: <path d="m9 6 9 6-9 6z" />,
    x: <><path d="m7 7 10 10" /><path d="m17 7-10 10" /></>,
  }
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      {paths[name]}
    </svg>
  )
}
