import { useEffect, useState } from 'react'

// Top of the floating column (+ at the bottom, the AI chat above it, this
// one above that). Only there once the page is scrolled down far enough for
// "back to top" to mean something; fades in and out.
const SHOW_AFTER_PX = 400

export default function BackToTopButton() {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > SHOW_AFTER_PX)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Back to top"
      title="Back to top"
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      className={`fixed bottom-42 right-4 w-12 h-12 flex items-center justify-center text-white rounded-full shadow-lg transition-all duration-200 active:scale-95 cursor-pointer z-30 ${
        shown ? 'opacity-100 scale-100' : 'opacity-0 scale-75 pointer-events-none'
      }`}
      style={{ backgroundColor: 'var(--primary)' }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--primary-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--primary)')}
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <path d="M12 19V5" />
        <path d="M5 12l7-7 7 7" />
      </svg>
    </button>
  )
}
