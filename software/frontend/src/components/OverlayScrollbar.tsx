import { useCallback, useEffect, useRef, useState } from 'react'

// The page's own scrollbar. The browser's is hidden (index.css) because it
// takes up width only on pages long enough to scroll, so pages shifted
// sideways depending on their length. This one floats over the content:
// it appears while scrolling (wheel, touch, keys), when the mouse nears the
// right edge or is over it, and fades out about a second later. The thumb can
// be dragged. Nothing shows when the page fits on screen.

const HIDE_AFTER_MS = 1000
const EDGE_PX = 16
const MIN_THUMB = 32
const INSET = 4 // gap at the top and bottom of the track

export default function OverlayScrollbar() {
  const [geom, setGeom] = useState({ top: 0, height: 0, scrollable: false })
  const [visible, setVisible] = useState(false)
  const [hover, setHover] = useState(false)
  const [dragging, setDragging] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drag = useRef<{ startY: number; startScroll: number } | null>(null)

  const measure = useCallback(() => {
    const el = document.documentElement
    const view = window.innerHeight
    const full = el.scrollHeight
    const scrollable = full > view + 1 && getComputedStyle(document.body).overflow !== 'hidden'
    const track = view - INSET * 2
    const height = Math.max(MIN_THUMB, (view / full) * track)
    const maxScroll = full - view
    const top = INSET + (maxScroll > 0 ? (window.scrollY / maxScroll) * (track - height) : 0)
    setGeom({ top, height, scrollable })
  }, [])

  const flash = useCallback(() => {
    setVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS)
  }, [])

  useEffect(() => {
    measure()
    const onScroll = () => { measure(); flash() }
    const onMove = (e: MouseEvent) => { if (e.clientX >= window.innerWidth - EDGE_PX) flash() }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('wheel', flash, { passive: true })
    window.addEventListener('touchmove', flash, { passive: true })
    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('resize', measure)
    // Content grows and shrinks without scrolling (data loading, tabs, modals
    // locking the body), so watch the page's size and body style too
    const ro = new ResizeObserver(measure)
    ro.observe(document.body)
    const mo = new MutationObserver(measure)
    mo.observe(document.body, { attributes: true, attributeFilter: ['style'] })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('wheel', flash)
      window.removeEventListener('touchmove', flash)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('resize', measure)
      ro.disconnect()
      mo.disconnect()
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [measure, flash])

  // Dragging the thumb scrolls the page in proportion
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      if (!drag.current) return
      const el = document.documentElement
      const track = window.innerHeight - INSET * 2 - geom.height
      const maxScroll = el.scrollHeight - window.innerHeight
      const dy = e.clientY - drag.current.startY
      window.scrollTo({ top: drag.current.startScroll + (track > 0 ? (dy / track) * maxScroll : 0) })
    }
    const onUp = () => {
      setDragging(false)
      drag.current = null
      flash()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, geom.height, flash])

  if (!geom.scrollable) return null
  const shown = visible || hover || dragging

  return (
    <div
      aria-hidden
      className="fixed right-0 top-0 bottom-0 w-3 z-50"
      style={{ pointerEvents: shown ? 'auto' : 'none' }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <div
        onPointerDown={(e) => {
          e.preventDefault()
          drag.current = { startY: e.clientY, startScroll: window.scrollY }
          setDragging(true)
        }}
        className="absolute right-0.5 rounded-full cursor-pointer transition-[opacity,width] duration-300"
        style={{
          top: geom.top,
          height: geom.height,
          width: hover || dragging ? 8 : 5,
          opacity: shown ? 1 : 0,
          backgroundColor: hover || dragging ? 'var(--text-muted)' : 'var(--border-strong)',
        }}
      />
    </div>
  )
}
