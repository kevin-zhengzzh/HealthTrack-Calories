import { NavLink, Outlet } from 'react-router-dom'

// One "History" page for everything logged: meals (Food Log, incl. devices),
// workouts, check-ins and points, switched with tabs. Each tab has its own URL
// (/history/food, /history/workouts, /history/check-ins, /history/points) so links, the back
// button and bookmarks keep working; the old /food-log and /record-history
// addresses redirect here.
const HISTORY_TABS = [
  { to: 'food', label: 'Food Log' },
  { to: 'workouts', label: 'Workouts' },
  { to: 'check-ins', label: 'Check-ins' },
  { to: 'points', label: 'Points' },
] as const

export default function Records() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-3xl font-bold text-[var(--text-primary)]">History</h1>
        <nav className="grid grid-cols-4 sm:inline-flex bg-[var(--bg-inset)] rounded-full p-1 text-sm" aria-label="History sections">
          {HISTORY_TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              className={({ isActive }) =>
                `px-2 sm:px-4 py-1.5 rounded-full text-center font-medium transition whitespace-nowrap ${
                  isActive ? 'shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`
              }
              style={({ isActive }) => (isActive ? { backgroundColor: 'var(--primary-light)', color: 'var(--primary-text)' } : undefined)}
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </div>
  )
}
