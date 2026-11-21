import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getIntakeHistory } from '../api'
import { localDateStr, useIntakeGoal } from '../intake'
import type { IntakeRecord } from '../types'

const SIZE = 180
const STROKE = 18
const R = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * R
const GAP = 3
const POLL_MS = 30_000

// Meals aren't fixed categories, so colors go by position in the day
// (first meal, second meal, ...) and repeat after eight.
const MEAL_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#d6a12a', '#8e5bd6', '#d64a7a', '#3fb3c9', '#7a8a2a']

const mealName = (r: IntakeRecord) => r.foodName || 'Unnamed food'

// Today's food intake as a ring: the full circle is the daily goal, each
// meal adds a slice. Past the goal the ring is full and the slices share it.
// burned: kcal from today's workouts, for the eaten − burned = net row
// (null while the workouts are still loading).
export default function TodayIntakeCard({ burned }: { burned: number | null }) {
  const { goal } = useIntakeGoal()
  const [records, setRecords] = useState<IntakeRecord[] | null>(null)
  const [hoverId, setHoverId] = useState<number | null>(null)

  const load = useCallback(() => getIntakeHistory().then(setRecords).catch(console.error), [])
  useEffect(() => {
    load()
    // Devices log meals in the background
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    window.addEventListener('focus', load)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [load])

  const today = localDateStr()
  const meals = useMemo(
    () => (records ?? [])
      .filter((r) => r.date === today)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [records, today],
  )
  const total = meals.reduce((s, r) => s + r.calories, 0)

  // Grow in from empty on first load; later changes animate via CSS
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    if (records === null) return
    const t = setTimeout(() => setGrown(true), 30)
    return () => clearTimeout(t)
  }, [records])

  const scale = Math.max(goal ?? 0, total)
  const segments = useMemo(() => {
    let cursor = 0
    return meals.filter((r) => r.calories > 0).map((r, i) => {
      const raw = grown && scale > 0 ? (r.calories / scale) * CIRCUMFERENCE : 0
      const length = Math.max(0, raw - GAP)
      const seg = { record: r, color: MEAL_COLORS[i % MEAL_COLORS.length], length, offset: cursor + (raw - length) / 2 }
      cursor += raw
      return seg
    })
  }, [meals, scale, grown])
  const colorOf = (id: number) => segments.find((s) => s.record.id === id)?.color ?? 'var(--border-strong)'

  const over = goal !== null && total > goal
  const percent = goal ? Math.round((total / goal) * 100) : null
  const hovered = meals.find((r) => r.id === hoverId) ?? null

  let subtitle: string
  if (hovered) subtitle = mealName(hovered)
  else if (goal === null) subtitle = 'kcal eaten today'
  else if (over) subtitle = `${(total - goal).toLocaleString()} kcal over`
  else subtitle = `of ${goal.toLocaleString()} kcal`

  return (
    <div className="bg-[var(--bg-surface)] rounded-2xl shadow p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-[var(--text-secondary)]">Today's intake</h2>
        <Link to="/food-log" className="text-sm font-medium hover:underline" style={{ color: 'var(--primary)' }}>
          Food Log →
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-6">
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            width={SIZE}
            height={SIZE}
            role="img"
            aria-label={goal ? `${total} of ${goal} kcal eaten today (${percent}%)` : `${total} kcal eaten today`}
          >
            <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
            <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
              {segments.map((s) => (
                <circle
                  key={s.record.id}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={R}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={STROKE}
                  strokeDasharray={`${s.length} ${CIRCUMFERENCE - s.length}`}
                  strokeDashoffset={-s.offset}
                  opacity={hoverId === null || hoverId === s.record.id ? 1 : 0.35}
                  onPointerEnter={() => setHoverId(s.record.id)}
                  onPointerLeave={() => setHoverId((cur) => (cur === s.record.id ? null : cur))}
                  className="cursor-pointer transition-[stroke-dasharray,stroke-dashoffset,opacity] duration-700 ease-out"
                />
              ))}
            </g>
            <text
              x={SIZE / 2}
              y={SIZE / 2 - 4}
              textAnchor="middle"
              fontSize={30}
              fontWeight={700}
              className={over && !hovered ? 'fill-amber-600' : 'fill-[var(--text-primary)]'}
            >
              {(hovered ? hovered.calories : total).toLocaleString()}
            </text>
            <text x={SIZE / 2} y={SIZE / 2 + 20} textAnchor="middle" fontSize={11} className="fill-[var(--text-muted)]">
              {subtitle.length > 24 ? subtitle.slice(0, 23) + '…' : subtitle}
            </text>
          </svg>
        </div>

        <div className="flex-1 w-full min-w-0">
          {goal === null ? (
            <p className="text-sm text-[var(--text-muted)] mb-3">
              No daily goal yet —{' '}
              <Link to="/food-log" className="font-medium hover:underline" style={{ color: 'var(--primary)' }}>set one in the Food Log</Link>
              {' '}to see how much of it you've eaten.
            </p>
          ) : (
            <p className="text-sm text-[var(--text-muted)] mb-3">
              {over
                ? <><span className="font-semibold text-amber-600">{percent}%</span> of your {goal.toLocaleString()} kcal goal</>
                : <><span className="font-semibold text-[var(--text-secondary)]">{(goal - total).toLocaleString()} kcal</span> left of {goal.toLocaleString()} ({percent}%)</>}
            </p>
          )}

          {records !== null && burned !== null && (
            <div className="grid grid-cols-3 gap-2 mb-3 text-center" aria-label="Net calories today">
              <NetStat label="Eaten" value={total} />
              <NetStat label="Burned" value={-burned} />
              <NetStat label="Net" value={total - burned} strong />
            </div>
          )}

          {records === null ? (
            <p className="text-sm text-[var(--text-muted)]">Loading…</p>
          ) : meals.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Nothing logged yet today. Put food on your scale to add it.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm max-h-44 overflow-y-auto pr-1">
              {meals.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-2 rounded-md px-1 cursor-default"
                  style={{ backgroundColor: hoverId === r.id ? 'var(--bg-inset)' : undefined }}
                  onPointerEnter={() => setHoverId(r.id)}
                  onPointerLeave={() => setHoverId((cur) => (cur === r.id ? null : cur))}
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorOf(r.id) }} />
                  <span className="truncate text-[var(--text-secondary)]">{mealName(r)}</span>
                  <span className="ml-auto tabular-nums text-[var(--text-muted)] shrink-0">
                    {new Date(r.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="w-16 text-right tabular-nums font-semibold text-[var(--text-secondary)] shrink-0">
                    {r.calories.toLocaleString()} kcal
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// One figure of the eaten / burned / net row; negative values get a real minus sign
function NetStat({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  const text = (value < 0 ? '−' : '') + Math.abs(value).toLocaleString()
  return (
    <div className="rounded-lg bg-[var(--bg-inset)] px-2 py-1.5">
      <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className={`tabular-nums ${strong ? 'font-bold text-[var(--text-primary)]' : 'font-semibold text-[var(--text-secondary)]'}`}>
        {text} <span className="text-xs font-normal text-[var(--text-muted)]">kcal</span>
      </p>
    </div>
  )
}
