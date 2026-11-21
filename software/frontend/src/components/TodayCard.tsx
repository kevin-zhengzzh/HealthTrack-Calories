import { useEffect, useMemo, useState } from 'react'

// Shared layout of the dashboard's "Today's intake" and "Today's burn" cards,
// so the two always look and behave the same: a ring where the full circle
// is the daily goal and each entry adds a slice (one colour per card, gaps
// between entries), a status line, and the list of today's entries. Past
// the goal the ring is full and the slices share it.

export interface TodayEntry {
  id: number
  label: string
  time: string // ISO
  kcal: number
}

const SIZE = 168
const STROKE = 16
const R = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * R
const GAP = 3

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

export default function TodayCard({
  title,
  headerAction,
  color,
  entries,
  goal,
  noun,
  noGoal,
  emptyText,
  loading,
  footer,
}: {
  title: string
  headerAction: React.ReactNode
  color: string
  entries: TodayEntry[] | null // null = loading
  goal: number | null // daily goal, null = not set
  noun: string // "eaten" / "burned"
  noGoal: React.ReactNode
  emptyText: string
  loading?: boolean
  footer?: React.ReactNode
}) {
  const [hoverId, setHoverId] = useState<number | null>(null)
  const list = useMemo(() => entries ?? [], [entries])
  const total = list.reduce((s, e) => s + e.kcal, 0)

  // Grow in from empty once data is there; later changes animate via CSS
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    if (entries === null) return
    const t = setTimeout(() => setGrown(true), 30)
    return () => clearTimeout(t)
  }, [entries])

  // Slices in time order, oldest first, clockwise from 12 o'clock
  const scale = Math.max(goal ?? 0, total)
  const segments = useMemo(() => {
    let cursor = 0
    return [...list]
      .sort((a, b) => a.time.localeCompare(b.time))
      .filter((e) => e.kcal > 0)
      .map((e) => {
        const raw = grown && scale > 0 ? (e.kcal / scale) * CIRCUMFERENCE : 0
        const length = Math.max(0, raw - GAP)
        const seg = { entry: e, length, offset: cursor + (raw - length) / 2 }
        cursor += raw
        return seg
      })
  }, [list, scale, grown])

  const over = goal !== null && total > goal
  const percent = goal ? Math.round((total / goal) * 100) : null
  const hovered = list.find((e) => e.id === hoverId) ?? null
  const accent = over ? '#d97706' : color

  let subtitle: string
  if (hovered) subtitle = hovered.label
  else if (goal === null) subtitle = `kcal ${noun}`
  else subtitle = `of ${goal.toLocaleString()} kcal`

  // Newest first in the list, like the Food Log
  const rows = useMemo(() => [...list].sort((a, b) => b.time.localeCompare(a.time)), [list])

  return (
    <div className="bg-[var(--bg-surface)] rounded-2xl shadow p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-[var(--text-secondary)] flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
          {title}
        </h2>
        {headerAction}
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-5 flex-1">
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            width={SIZE}
            height={SIZE}
            role="img"
            aria-label={goal ? `${total} of ${goal} kcal ${noun} today (${percent}%)` : `${total} kcal ${noun} today`}
          >
            <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
            <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
              {segments.map((s) => (
                <circle
                  key={s.entry.id}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={R}
                  fill="none"
                  stroke={accent}
                  strokeWidth={STROKE}
                  strokeDasharray={`${s.length} ${CIRCUMFERENCE - s.length}`}
                  strokeDashoffset={-s.offset}
                  opacity={hoverId === null || hoverId === s.entry.id ? 1 : 0.3}
                  onPointerEnter={() => setHoverId(s.entry.id)}
                  onPointerLeave={() => setHoverId((cur) => (cur === s.entry.id ? null : cur))}
                  className="cursor-pointer transition-[stroke-dasharray,stroke-dashoffset,opacity] duration-700 ease-out"
                />
              ))}
            </g>
            <text
              x={SIZE / 2}
              y={SIZE / 2 - 4}
              textAnchor="middle"
              fontSize={28}
              fontWeight={700}
              style={{ fill: over && !hovered ? accent : 'var(--text-primary)' }}
            >
              {(hovered ? hovered.kcal : total).toLocaleString()}
            </text>
            <text x={SIZE / 2} y={SIZE / 2 + 18} textAnchor="middle" fontSize={11} className="fill-[var(--text-muted)]">
              {subtitle.length > 22 ? subtitle.slice(0, 21) + '…' : subtitle}
            </text>
          </svg>
        </div>

        <div className="flex-1 w-full min-w-0 flex flex-col">
          {goal === null ? (
            <p className="text-sm text-[var(--text-muted)] mb-3">{noGoal}</p>
          ) : (
            <p className="text-sm text-[var(--text-muted)] mb-3">
              {over
                ? <><span className="font-semibold" style={{ color: accent }}>{(total - goal).toLocaleString()} kcal over</span> today's goal ({percent}%)</>
                : <><span className="font-semibold text-[var(--text-secondary)]">{(goal - total).toLocaleString()} kcal</span> to go ({percent}%)</>}
            </p>
          )}

          {entries === null || loading ? (
            <p className="text-sm text-[var(--text-muted)]">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">{emptyText}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm max-h-40 overflow-y-auto pr-1">
              {rows.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center gap-2 rounded-md px-1 py-0.5 cursor-default"
                  style={{ backgroundColor: hoverId === e.id ? 'var(--bg-inset)' : undefined }}
                  onPointerEnter={() => setHoverId(e.id)}
                  onPointerLeave={() => setHoverId((cur) => (cur === e.id ? null : cur))}
                >
                  <span className="tabular-nums text-xs text-[var(--text-muted)] w-10 shrink-0">{fmtTime(e.time)}</span>
                  <span className="truncate text-[var(--text-secondary)]">{e.label}</span>
                  <span className="ml-auto tabular-nums font-semibold text-[var(--text-secondary)] shrink-0">
                    {e.kcal.toLocaleString()} kcal
                  </span>
                </li>
              ))}
            </ul>
          )}

          {footer && <div className="mt-auto pt-3">{footer}</div>}
        </div>
      </div>
    </div>
  )
}
