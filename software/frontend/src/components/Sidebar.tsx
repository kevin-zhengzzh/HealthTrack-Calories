import { NavLink } from 'react-router-dom'
import BackToTopButton from './BackToTopButton'
import WeeklySummaryCard from './WeeklySummaryCard'
import { useMediaQuery } from '../hooks/useMediaQuery'

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/statistics', label: 'Statistics', end: false },
  { to: '/plan', label: 'Plan', end: false },
  { to: '/history', label: 'History', end: false },
  { to: '/device', label: 'Device', end: false },
]

export default function Sidebar() {
  // Last week's AI summary sits under the links on wide screens. On phones
  // the sidebar is a bar across the top of every page, so the summary is
  // shown at the bottom of the Dashboard instead (see Dashboard.tsx).
  const wide = useMediaQuery('(min-width: 1024px)')
  return (
    <>
      {/* The "hug left edge" offset scales with how much gutter actually
          exists outside the max-w-7xl (1280px) container instead of jumping
          at a fixed breakpoint — clamp(0, gutter, 50px) eases in smoothly as
          the window widens past 1280px and never exceeds the real gutter. */}
      <div
        className="w-full lg:w-56 lg:shrink-0 lg:sticky lg:top-22 flex flex-col gap-4"
        style={{ transform: 'translateX(clamp(-50px, calc((1280px - 100vw) / 2), 0px))' }}
      >
      <aside className="w-full bg-[var(--bg-surface)] rounded-2xl shadow p-3 overflow-x-auto">
        <nav className="flex lg:flex-col gap-1 min-w-max lg:min-w-0">
          {links.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `px-4 py-2 rounded-lg text-sm font-medium transition whitespace-nowrap ${
                  isActive ? '' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-inset)]'
                }`
              }
              style={({ isActive }) => (isActive ? { backgroundColor: 'var(--primary-light)', color: 'var(--primary-text)' } : undefined)}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      {wide && <WeeklySummaryCard compact />}
      </div>
      <BackToTopButton />
    </>
  )
}
