import { useEffect, useRef, useState } from 'react'

// The one "?" used everywhere for explanations. Hovering shows the bubble;
// clicking (or tapping, on phones) pins it open until you click elsewhere or
// press Escape — so links inside it, like "Store", can be clicked. The bubble
// sits in a padded wrapper that touches the "?", so moving the mouse from one
// to the other doesn't close it.
// align: which way the bubble opens, so it stays on screen near an edge.
export default function InfoTip({
  label,
  children,
  align = 'center',
}: {
  label: string
  children: React.ReactNode
  align?: 'center' | 'left' | 'right'
}) {
  const [pinned, setPinned] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!pinned) return
    const close = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPinned(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPinned(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('touchstart', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('touchstart', close)
      document.removeEventListener('keydown', esc)
    }
  }, [pinned])

  const pos = align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
  const shown = pinned
    ? 'opacity-100 visible pointer-events-auto'
    : 'opacity-0 invisible pointer-events-none group-hover:opacity-100 group-hover:visible group-hover:pointer-events-auto'

  return (
    <span ref={ref} className="relative inline-flex group align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={pinned}
        onClick={() => setPinned((p) => !p)}
        className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold leading-none cursor-pointer bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
      >
        ?
      </button>
      <span className={`absolute top-full ${pos} z-40 pt-2 transition-opacity ${shown}`}>
        <span
          role="tooltip"
          className="block w-64 max-w-[80vw] rounded-lg bg-gray-800 text-white text-xs font-normal normal-case tracking-normal leading-relaxed text-left px-3 py-2 shadow-lg"
        >
          {children}
        </span>
      </span>
    </span>
  )
}
