import { useEffect, useMemo, useState } from 'react'
import { getCheckInHistory, getIntakeStats, getWorkoutHistory } from '../api'
import { useStore } from '../store'
import type { CheckIn, IntakeStats, WorkoutRecord } from '../types'
import { INTAKE_COLOR, useGoals } from '../goals'
import { localDateStr } from '../intake'
import { bars as makeBars, periodRange, summarize, type PeriodKind } from '../stats'
import PeriodBarChart from '../components/PeriodBarChart'
import CheckInHeatmap from '../components/CheckInHeatmap'
import WeeklySummaryCard from '../components/WeeklySummaryCard'

// Trends, like a bookkeeping app: Intake or Burned, by calendar week, month
// or year, stepping back through earlier periods. Total and daily average
// (logged days only), a bar chart against the daily goal, and what made up
// the period (top foods / workout types).

type Measure = 'intake' | 'burn'

const KINDS: { id: PeriodKind; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
]

export default function Statistics() {
  const { workoutRefreshKey, intakeRefreshKey } = useStore()
  const { intake: intakeGoal, burn: burnGoal } = useGoals()
  const [measure, setMeasure] = useState<Measure>('intake')
  const [kind, setKind] = useState<PeriodKind>('week')
  const [offset, setOffset] = useState(0)
  const [workouts, setWorkouts] = useState<WorkoutRecord[] | null>(null)
  const [checkIns, setCheckIns] = useState<CheckIn[]>([])
  const [intake, setIntake] = useState<{ key: string; stats: IntakeStats } | null>(null)

  const today = new Date()
  const todayStr = localDateStr(today)
  const range = periodRange(kind, offset, today)
  const rangeKey = `${range.from}/${range.to}`

  useEffect(() => {
    getWorkoutHistory().then(setWorkouts).catch(console.error)
    getCheckInHistory().then(setCheckIns).catch(console.error)
  }, [workoutRefreshKey])

  useEffect(() => {
    let live = true
    getIntakeStats(range.from, range.to)
      .then((stats) => { if (live) setIntake({ key: rangeKey, stats }) })
      .catch(console.error)
    return () => { live = false }
    // range.from/to are captured in rangeKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, intakeRefreshKey])

  // kcal per day, for the chosen measure and period
  const totals = useMemo(() => {
    const m = new Map<string, number>()
    if (measure === 'intake') {
      for (const d of intake?.stats.days ?? []) m.set(d.date, d.calories)
    } else {
      for (const w of workouts ?? []) {
        if (w.date >= range.from && w.date <= range.to) m.set(w.date, (m.get(w.date) ?? 0) + w.calories)
      }
    }
    return m
  }, [measure, intake, workouts, range.from, range.to])

  const loading = measure === 'intake' ? intake?.key !== rangeKey : workouts === null
  const chartBars = makeBars(kind, range, totals, today)
  const summary = summarize(range, totals)
  const color = measure === 'intake' ? INTAKE_COLOR : 'var(--primary)'
  const goal = (measure === 'intake' ? intakeGoal?.perDay : burnGoal?.perDay) ?? null

  // What made up the period
  const ranking = useMemo(() => {
    if (measure === 'intake') return (intake?.stats.foods ?? []).map((f) => ({ name: f.name, kcal: f.calories, count: f.count }))
    const byType = new Map<string, { kcal: number; count: number }>()
    for (const w of workouts ?? []) {
      if (w.date < range.from || w.date > range.to) continue
      const t = byType.get(w.workoutType) ?? { kcal: 0, count: 0 }
      byType.set(w.workoutType, { kcal: t.kcal + w.calories, count: t.count + 1 })
    }
    return [...byType.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.kcal - a.kcal)
  }, [measure, intake, workouts, range.from, range.to])
  const rankMax = Math.max(1, ...ranking.map((r) => r.kcal))

  const changeKind = (k: PeriodKind) => { setKind(k); setOffset(0) }
  const todayKey = kind === 'year' ? todayStr.slice(0, 7) : todayStr

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-3xl font-bold text-[var(--text-primary)]">Statistics</h1>
        <Segmented
          value={measure}
          onChange={setMeasure}
          options={[{ id: 'intake', label: 'Intake', dot: INTAKE_COLOR }, { id: 'burn', label: 'Burned', dot: 'var(--primary)' }]}
          label="What to show"
        />
      </div>

      <section className="bg-[var(--bg-surface)] rounded-2xl shadow p-5 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <Segmented value={kind} onChange={changeKind} options={KINDS} label="Period" />
          <div className="flex items-center gap-1 self-center sm:self-auto">
            <NavButton label="Earlier" onClick={() => setOffset((o) => o + 1)}>‹</NavButton>
            <span className="min-w-44 text-center font-semibold text-[var(--text-primary)] tabular-nums">{range.label}</span>
            <NavButton label="Later" onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={range.current}>›</NavButton>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Figure label={measure === 'intake' ? 'Total eaten' : 'Total burned'} value={loading ? null : summary.total} unit="kcal" />
          <Figure
            label="Daily average"
            value={loading ? null : summary.dailyAvg}
            unit="kcal"
            note={loading ? '' : summary.loggedDays === 0 ? 'nothing logged' : `over ${summary.loggedDays} logged day${summary.loggedDays === 1 ? '' : 's'}`}
          />
        </div>

        <div className={loading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
          <PeriodBarChart bars={chartBars} kind={kind} color={color} goal={goal} avg={summary.dailyAvg} todayKey={todayKey} />
        </div>
        {kind === 'year' && <p className="text-xs text-[var(--text-muted)] -mt-2">Each bar is that month's daily average, over the days with something logged.</p>}
      </section>

      <section className="bg-[var(--bg-surface)] rounded-2xl shadow p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{measure === 'intake' ? 'Top foods' : 'By workout'}</h2>
          <span className="text-sm text-[var(--text-muted)]">{range.label}</span>
        </div>
        {loading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading…</p>
        ) : ranking.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">{measure === 'intake' ? 'No meals' : 'No workouts'} in this period.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {ranking.map((r, i) => (
              <li key={r.name} className="flex items-center gap-3 text-sm">
                <span className="w-5 text-right tabular-nums text-[var(--text-muted)]">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[var(--text-primary)] font-medium">
                      {r.name} <span className="text-xs font-normal text-[var(--text-muted)]">× {r.count}</span>
                    </span>
                    <span className="tabular-nums font-semibold text-[var(--text-secondary)] shrink-0">{r.kcal.toLocaleString()} kcal</span>
                  </div>
                  <div className="h-1.5 mt-1 rounded-full bg-[var(--bg-inset)] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(r.kcal / rankMax) * 100}%`, backgroundColor: color }} />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <WeeklySummaryCard />

      <CheckInHeatmap checkIns={checkIns} records={workouts ?? []} />
    </div>
  )
}

function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T
  onChange: (v: T) => void
  options: { id: T; label: string; dot?: string }[]
  label: string
}) {
  return (
    <div className="inline-flex self-start bg-[var(--bg-inset)] rounded-full p-1 text-sm" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`px-4 py-1.5 rounded-full font-medium transition cursor-pointer flex items-center gap-1.5 ${value === o.id ? 'shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}
          style={value === o.id ? { backgroundColor: 'var(--primary-light)', color: 'var(--primary-text)' } : undefined}
        >
          {o.dot && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: o.dot }} aria-hidden />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

function NavButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className="w-9 h-9 rounded-full text-xl leading-none text-[var(--text-secondary)] hover:bg-[var(--bg-inset)] disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default">
      {children}
    </button>
  )
}

function Figure({ label, value, unit, note }: { label: string; value: number | null; unit: string; note?: string }) {
  return (
    <div className="rounded-xl bg-[var(--bg-inset)] px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="text-2xl font-bold tabular-nums text-[var(--text-primary)]">
        {value === null ? '—' : value.toLocaleString()}
        {value !== null && <span className="text-sm font-normal text-[var(--text-muted)]"> {unit}</span>}
      </p>
      {note !== undefined && <p className="text-xs text-[var(--text-muted)] min-h-4">{note}</p>}
    </div>
  )
}
