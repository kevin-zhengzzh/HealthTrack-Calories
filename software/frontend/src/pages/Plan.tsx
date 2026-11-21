import { useEffect, useState } from 'react'
import { INTAKE_COLOR, MAX_GOAL_PER_DAY, MAX_GOAL_PER_WEEK, perDay, useGoals, type Goal } from '../goals'
import { useStore } from '../store'
import type { GoalKind } from '../types'

const inputClass = 'w-full border border-[var(--border-strong)] rounded-lg px-3 py-2 text-right tabular-nums bg-[var(--bg-surface)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-green-500'

const blockNonDigits = (e: React.KeyboardEvent) => {
  if (['e', 'E', '+', '-', '.'].includes(e.key)) e.preventDefault()
}

// One goal: per-day and per-week inputs kept in step (×7 / ÷7). Whichever was
// typed in last is what gets saved; the backend stores the weekly figure.
function GoalCard({
  kind,
  title,
  blurb,
  accent,
  goal,
  clearable,
}: {
  kind: GoalKind
  title: string
  blurb: string
  accent: string
  goal: Goal | null
  clearable: boolean
}) {
  const { save } = useGoals()
  const pushToast = useStore((s) => s.pushToast)
  const [day, setDay] = useState('')
  const [week, setWeek] = useState('')
  const [edited, setEdited] = useState<'day' | 'week' | null>(null)
  const [saving, setSaving] = useState(false)

  // Show the saved goal whenever it changes (load, save, clear). Numbers, not
  // the goal object: that's rebuilt on every render.
  const savedDay = goal?.perDay
  const savedWeek = goal?.perWeek
  useEffect(() => {
    setDay(savedDay != null ? String(savedDay) : '')
    setWeek(savedWeek != null ? String(savedWeek) : '')
    setEdited(null)
  }, [savedDay, savedWeek])

  function onDay(v: string) {
    setDay(v)
    setEdited('day')
    const n = Number(v)
    setWeek(v && Number.isFinite(n) ? String(n * 7) : '')
  }

  function onWeek(v: string) {
    setWeek(v)
    setEdited('week')
    const n = Number(v)
    setDay(v && Number.isFinite(n) ? String(perDay(n)) : '')
  }

  const value = edited === 'day' ? Number(day) : edited === 'week' ? Number(week) : NaN
  const max = edited === 'day' ? MAX_GOAL_PER_DAY : MAX_GOAL_PER_WEEK
  const valid = Number.isInteger(value) && value >= 1 && value <= max
  const changed = edited !== null && (edited === 'day' ? value !== goal?.perDay : value !== goal?.perWeek)

  async function run(v: { perDay: number } | { perWeek: number } | null, done: string) {
    setSaving(true)
    try {
      await save(kind, v)
      pushToast(done, 'success')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to update goal')
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid || !changed) return
    run(edited === 'day' ? { perDay: value } : { perWeek: value }, `${title} updated!`)
  }

  return (
    <section className="bg-[var(--bg-surface)] rounded-2xl shadow p-5 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="mt-1.5 w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: accent }} aria-hidden />
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
          <p className="text-sm text-[var(--text-muted)]">{blurb}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Per day (kcal)
            <input
              type="number" min={1} max={MAX_GOAL_PER_DAY} step={1} inputMode="numeric"
              value={day} placeholder="—"
              onChange={(e) => onDay(e.target.value)} onKeyDown={blockNonDigits}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Per week (kcal)
            <input
              type="number" min={1} max={MAX_GOAL_PER_WEEK} step={1} inputMode="numeric"
              value={week} placeholder="—"
              onChange={(e) => onWeek(e.target.value)} onKeyDown={blockNonDigits}
              className={inputClass}
            />
          </label>
        </div>
        <p className="text-xs text-[var(--text-muted)] min-h-4">
          {edited && !valid
            ? `Enter a whole number from 1 to ${max.toLocaleString()}.`
            : edited === 'week' && valid && value % 7 !== 0
              ? `≈ ${perDay(value).toLocaleString()} a day (weekly ÷ 7, rounded).`
              : goal
                ? `Change either one — the other follows.`
                : 'Not set yet.'}
        </p>
        <div className="flex gap-3">
          {clearable && goal && (
            <button
              type="button"
              disabled={saving}
              onClick={() => run(null, `${title} cleared.`)}
              className="border border-[var(--border-strong)] text-[var(--text-secondary)] rounded-lg py-2 px-4 font-semibold hover:bg-[var(--bg-inset)] transition cursor-pointer disabled:opacity-60"
            >
              Clear
            </button>
          )}
          <button
            type="submit"
            disabled={saving || !valid || !changed}
            className="ml-auto text-white rounded-lg py-2 px-6 font-semibold transition disabled:opacity-50 cursor-pointer disabled:cursor-default"
            style={{ backgroundColor: 'var(--primary)' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  )
}

export default function Plan() {
  const { loaded, intake, burn } = useGoals()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold text-[var(--text-primary)]">Plan</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Set each goal per day or per week; the other is worked out for you. Goals carry over until you change them.
        </p>
      </div>

      {!loaded ? (
        <p className="text-[var(--text-muted)]">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <GoalCard
            kind="intake"
            title="Intake goal"
            blurb="How much you plan to eat. Shown on the dashboard, the Food Log and your Stack-chan."
            accent={INTAKE_COLOR}
            goal={intake}
            clearable
          />
          <GoalCard
            kind="burn"
            title="Burn goal"
            blurb="How much you plan to burn in workouts. Used by the weekly goal chart and the AI assistant."
            accent="var(--primary)"
            goal={burn}
            clearable={false}
          />
        </div>
      )}
    </div>
  )
}
