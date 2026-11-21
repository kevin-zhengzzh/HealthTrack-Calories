import { useEffect, useMemo, useState } from 'react'
import { WORKOUT_TYPE_COLORS, WORKOUT_TYPES, type WorkoutRecord } from '../types'
import { Link } from 'react-router-dom'

function parseLocalDate(dateStr: string) {
  return new Date(`${dateStr}T00:00:00`)
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

// Monday-start week containing `d`
function startOfWeek(d: Date) {
  const s = startOfDay(d)
  const dow = (s.getDay() + 6) % 7 // 0 = Monday
  s.setDate(s.getDate() - dow)
  return s
}

const SIZE = 180
const STROKE = 18
const R = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * R

export default function WeeklyGoalDonut({
  records,
  goal,
}: {
  records: WorkoutRecord[]
  goal: number | null // null = no burn goal set (Plan page)
}) {
  const [hoverType, setHoverType] = useState<string | null>(null)

  const weekRecords = useMemo(() => {
    const weekStart = startOfWeek(new Date())
    return records.filter((r) => startOfDay(parseLocalDate(r.date)) >= weekStart)
  }, [records])

  const weekTotal = weekRecords.reduce((sum, r) => sum + r.calories, 0)

  const percent = goal ? Math.round((weekTotal / goal) * 100) : 0
  const ringPercent = Math.min(100, percent)

  // Ring sweeps in from empty on first load; CSS transition on the segment
  // circles then also animates any later change to the underlying data.
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setGrown(true), 30)
    return () => clearTimeout(t)
  }, [])
  const filledLength = grown ? (ringPercent / 100) * CIRCUMFERENCE : 0

  // Fixed categorical order (never re-sorted by size) — a type keeps the
  // same color and relative position regardless of which types have data.
  const GAP = 3
  const typeSegments = useMemo(() => {
    const byType = new Map<string, number>()
    for (const r of weekRecords) byType.set(r.workoutType, (byType.get(r.workoutType) ?? 0) + r.calories)

    let cursor = 0
    const segments: { type: string; value: number; color: string; length: number; offset: number; midAngle: number }[] = []
    for (const type of WORKOUT_TYPES) {
      const value = byType.get(type) ?? 0
      if (value <= 0) continue
      const rawLength = weekTotal > 0 ? (value / weekTotal) * filledLength : 0
      const length = Math.max(0, rawLength - GAP)
      const offset = cursor + (rawLength - length) / 2
      segments.push({
        type,
        value,
        color: WORKOUT_TYPE_COLORS[type] ?? '#9ca3af',
        length,
        offset,
        midAngle: -90 + ((offset + length / 2) / CIRCUMFERENCE) * 360,
      })
      cursor += rawLength
    }
    return segments
  }, [weekRecords, weekTotal, filledLength])

  const hovered = typeSegments.find((s) => s.type === hoverType) ?? null

  return (
    <div className="bg-[var(--bg-surface)] rounded-2xl shadow p-5 h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-[var(--text-secondary)]">Weekly burn goal</h2>
        <Link
          to="/plan"
          aria-label="Edit burn goal on the Plan page"
          title="Edit burn goal (Plan)"
          className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] p-1"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        </Link>
      </div>

      <div className="flex flex-col items-center">
        <div className="relative" style={{ width: SIZE, height: SIZE }}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="img" aria-label={`${percent}% of weekly calorie goal completed`}>
            <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
            <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
              {typeSegments.map((s) => (
                <circle
                  key={s.type}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={R}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={STROKE}
                  strokeLinecap="butt"
                  strokeDasharray={`${s.length} ${CIRCUMFERENCE - s.length}`}
                  strokeDashoffset={-s.offset}
                  opacity={hoverType === null || hoverType === s.type ? 1 : 0.35}
                  onPointerEnter={() => setHoverType(s.type)}
                  onPointerLeave={() => setHoverType((cur) => (cur === s.type ? null : cur))}
                  onFocus={() => setHoverType(s.type)}
                  onBlur={() => setHoverType((cur) => (cur === s.type ? null : cur))}
                  tabIndex={0}
                  className="cursor-pointer outline-none transition-[stroke-dasharray,stroke-dashoffset,opacity] duration-700 ease-out"
                />
              ))}
            </g>
            <text x={SIZE / 2} y={SIZE / 2 - 6} textAnchor="middle" fontSize={30} fontWeight={700} className="fill-[var(--text-primary)]">
              {goal ? `${percent}%` : "—"}
            </text>
            <text x={SIZE / 2} y={SIZE / 2 + 18} textAnchor="middle" fontSize={11} className="fill-[var(--text-muted)]">
              {goal ? 'of weekly goal' : 'no goal set'}
            </text>
          </svg>

          {hovered && (
            <div
              className="absolute pointer-events-none -translate-x-1/2 -translate-y-full bg-gray-800 text-white text-xs rounded-lg px-2.5 py-1.5 shadow-lg whitespace-nowrap"
              style={{
                left: SIZE / 2 + (R + STROKE / 2 + 8) * Math.cos((hovered.midAngle * Math.PI) / 180),
                top: SIZE / 2 + (R + STROKE / 2 + 8) * Math.sin((hovered.midAngle * Math.PI) / 180),
                marginTop: '-6px',
              }}
            >
              <span className="font-semibold">{hovered.value.toLocaleString()} kcal</span>
              <span className="text-gray-300"> · {hovered.type} · {weekTotal > 0 ? Math.round((hovered.value / weekTotal) * 100) : 0}%</span>
            </div>
          )}
        </div>

        <p className="text-sm text-[var(--text-muted)] mt-2">
          <span className="font-semibold text-[var(--text-secondary)]">{weekTotal.toLocaleString()}</span>
          {goal ? <> / {goal.toLocaleString()} kcal this week</> : <> kcal this week · <Link to="/plan" className="font-medium hover:underline" style={{ color: 'var(--primary)' }}>set a goal</Link></>}
        </p>

        {typeSegments.length > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 mt-3 text-xs text-[var(--text-muted)]">
            {typeSegments.map((s) => (
              <span
                key={s.type}
                className="flex items-center gap-1.5 cursor-pointer"
                onPointerEnter={() => setHoverType(s.type)}
                onPointerLeave={() => setHoverType((cur) => (cur === s.type ? null : cur))}
              >
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                {s.type} <span className="text-[var(--text-muted)]">({s.value.toLocaleString()})</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[var(--text-muted)] mt-3">No workouts recorded this week yet.</p>
        )}
      </div>
    </div>
  )
}
