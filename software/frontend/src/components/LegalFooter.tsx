import { Link } from 'react-router-dom'

// One line at the bottom of every page (signed in or not): the numbers are
// estimates, with a link to the full disclaimer
export default function LegalFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`text-center text-xs text-[var(--text-muted)] py-6 ${className}`}>
      Estimates only, not medical advice ·{' '}
      <Link to="/disclaimer" className="underline hover:text-[var(--text-secondary)]">Disclaimer</Link>
    </footer>
  )
}
