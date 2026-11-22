import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// The one "?" used everywhere for explanations. Hovering shows the bubble;
// clicking (or tapping, on phones) pins it open until you click elsewhere or
// press Escape — so links inside it, like "Store", can be clicked. The bubble
// sits in a padded wrapper that touches the "?", so moving the mouse from one
// to the other doesn't close it.
// align: which way the bubble opens; it's then nudged to stay on screen.
//
// The bubble only exists while it's open. A hidden-but-laid-out bubble near
// the right edge made the whole page wider than a phone screen, and mobile
// browsers then shrank the page to fit (the Plan page's Burn goal "?").
const EDGE = 8 // px kept clear of the screen edges

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
  const [hovered, setHovered] = useState(false)
  const [shift, setShift] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const open = pinned || hovered

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

  // Keep the open bubble inside the screen: measure where it landed and
  // slide it back by the overflow, before the browser paints
  useLayoutEffect(() => {
    if (!open) { setShift(0); return }
    const el = bubbleRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const right = r.right - shift
    const left = r.left - shift
    if (right > vw - EDGE) setShift(vw - EDGE - right)
    else if (left < EDGE) setShift(EDGE - left)
    else setShift(0)
    // Measured once per opening; shift itself is accounted for above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pos = align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'

  return (
    <span
      ref={ref}
      className="relative inline-flex align-middle"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setPinned((p) => !p)}
        className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold leading-none cursor-pointer bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
      >
        ?
      </button>
      {open && (
        <span className={`absolute top-full ${pos} z-40 pt-2`}>
          <span
            ref={bubbleRef}
            role="tooltip"
            className="block w-64 max-w-[calc(100vw-16px)] rounded-lg bg-gray-800 text-white text-xs font-normal normal-case tracking-normal leading-relaxed text-left px-3 py-2 shadow-lg"
            style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          >
            {children}
          </span>
        </span>
      )}
    </span>
  )
}
