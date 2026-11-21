import { INTAKE_COLOR } from '../goals'

// Eaten − Burned = Net for today. Net is only worked out once both sides have
// something logged: with only meals (or only workouts) it would just be the
// one number, and a forgotten workout would make it look far too high.
export default function NetBanner({
  eaten,
  burned,
  meals,
  workouts,
  loading,
}: {
  eaten: number
  burned: number
  meals: number
  workouts: number
  loading: boolean
}) {
  const ready = meals > 0 && workouts > 0
  const hint = meals === 0 && workouts === 0
    ? 'Log a meal and a workout to see your net calories.'
    : meals === 0
      ? 'Log a meal to see your net calories.'
      : 'Log a workout to see your net calories.'

  return (
    <section
      className="bg-[var(--bg-surface)] rounded-2xl shadow px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6"
      aria-label="Net calories today"
    >
      <div className="flex items-center gap-3 sm:gap-5 flex-wrap">
        <Figure label="Eaten" value={loading ? null : eaten} color={INTAKE_COLOR} />
        <Op>−</Op>
        <Figure label="Burned" value={loading ? null : burned} color="var(--primary)" />
        <Op>=</Op>
        <Figure label="Net" value={loading || !ready ? null : eaten - burned} strong />
      </div>
      {!loading && !ready && <p className="text-sm text-[var(--text-muted)] sm:ml-auto">{hint}</p>}
    </section>
  )
}

function Op({ children }: { children: React.ReactNode }) {
  return <span className="text-xl text-[var(--text-muted)] self-end pb-0.5" aria-hidden>{children}</span>
}

function Figure({ label, value, color, strong = false }: { label: string; value: number | null; color?: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)] flex items-center gap-1.5">
        {color && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />}
        {label}
      </p>
      <p className={`tabular-nums ${strong ? 'text-2xl font-bold text-[var(--text-primary)]' : 'text-xl font-semibold text-[var(--text-secondary)]'}`}>
        {value === null ? '—' : (value < 0 ? '−' : '') + Math.abs(value).toLocaleString()}
        {value !== null && <span className="text-xs font-normal text-[var(--text-muted)]"> kcal</span>}
      </p>
    </div>
  )
}
