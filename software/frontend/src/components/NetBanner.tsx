import { Link } from 'react-router-dom'
import { INTAKE_COLOR } from '../goals'
import InfoTip from './InfoTip'

// Eaten − Burned = Net for today. Burned is the base burn (maintenance from
// the Plan page's body details, a whole day's worth) plus logged workouts.
// Net needs a meal, and something on the burn side: the base burn when the
// body details are filled in, otherwise a workout — with only one side it
// would just be that number, and a forgotten entry would skew it badly.
export default function NetBanner({
  eaten,
  workoutKcal,
  base,
  meals,
  workouts,
  loading,
}: {
  eaten: number
  workoutKcal: number
  base: number | null // kcal/day, null = body details incomplete
  meals: number
  workouts: number
  loading: boolean
}) {
  const burned = workoutKcal + (base ?? 0)
  const burnReady = base !== null || workouts > 0
  const ready = meals > 0 && burnReady
  const hint = meals === 0
    ? burnReady ? 'Log a meal to see your net calories.' : 'Log a meal and a workout to see your net calories.'
    : <>Log a workout, or fill in your body details on the <Link to="/plan" className="underline">Plan</Link> page, to see your net calories.</>

  return (
    <section
      className="bg-[var(--bg-surface)] rounded-2xl shadow px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6"
      aria-label="Net calories today"
    >
      <div className="flex items-start gap-3 sm:gap-5 flex-wrap">
        <Figure label="Eaten" value={loading ? null : eaten} color={INTAKE_COLOR} />
        <Op>−</Op>
        <Figure
          label="Burned"
          value={loading ? null : burned}
          color="var(--primary)"
          sub={!loading && base !== null ? `incl. ${base.toLocaleString()} base` : undefined}
        />
        <Op>=</Op>
        <Figure
          label="Net"
          value={loading || !ready ? null : eaten - burned}
          strong
          tip={
            <>
              <b>Net calories</b> = what you ate − what you burned. Burned is your <b>base burn</b> (the energy your
              body uses in a whole day without workouts, estimated from your body details on the{' '}
              <Link to="/plan" className="underline">Plan</Link> page) plus logged workouts. Below zero means you're
              eating less than you use today. Without body details, only workouts count, and net is shown once both a
              meal and a workout are logged.
            </>
          }
        />
      </div>
      {!loading && !ready && <p className="text-sm text-[var(--text-muted)] sm:ml-auto">{hint}</p>}
    </section>
  )
}

function Op({ children }: { children: React.ReactNode }) {
  return <span className="text-xl text-[var(--text-muted)] self-start mt-4" aria-hidden>{children}</span>
}

function Figure({ label, value, color, strong = false, tip, sub }: { label: string; value: number | null; color?: string; strong?: boolean; tip?: React.ReactNode; sub?: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)] flex items-center gap-1.5">
        {color && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />}
        {label}
        {tip && <InfoTip label={`What is ${label}?`}>{tip}</InfoTip>}
      </p>
      <p className={`tabular-nums ${strong ? 'text-2xl font-bold text-[var(--text-primary)]' : 'text-xl font-semibold text-[var(--text-secondary)]'}`}>
        {value === null ? '—' : (value < 0 ? '−' : '') + Math.abs(value).toLocaleString()}
        {value !== null && <span className="text-xs font-normal text-[var(--text-muted)]"> kcal</span>}
      </p>
      {sub && <p className="text-xs tabular-nums text-[var(--text-muted)]">{sub}</p>}
    </div>
  )
}
