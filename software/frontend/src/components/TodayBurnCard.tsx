import { Link } from 'react-router-dom'
import { useGoals } from '../goals'
import { useStore } from '../store'
import type { WorkoutRecord } from '../types'
import InfoTip from './InfoTip'
import TodayCard, { type Period } from './TodayCard'

// Workouts for today or this week against the burn goal (Plan page). The
// ring counts workouts only — the goal is a workout goal — and a line below
// adds the base burn (body details on the Plan page) for the full figure.
// records: the period's workouts; days: days of the period so far (1 for
// today, 1–7 for this week), for the base burn.
export default function TodayBurnCard({
  records,
  period,
  days,
  base,
  loading,
}: {
  records: WorkoutRecord[]
  period: Period
  days: number
  base: number | null // base burn kcal/day, null = body details incomplete
  loading: boolean
}) {
  const { burn } = useGoals()
  const setRecordModalOpen = useStore((s) => s.setRecordModalOpen)
  const workouts = records.reduce((s, r) => s + r.calories, 0)
  const baseTotal = base === null ? null : base * days

  return (
    <TodayCard
      title={period === 'day' ? "Today's burn" : "This week's burn"}
      headerAction={
        <button
          onClick={() => setRecordModalOpen(true)}
          className="text-sm font-medium hover:underline cursor-pointer"
          style={{ color: 'var(--primary)' }}
        >
          + Record workout
        </button>
      }
      color="var(--primary)"
      period={period}
      entries={loading ? null : records.map((r) => ({ id: r.id, label: r.workoutType, time: r.createdAt, date: r.date, kcal: r.calories }))}
      goal={(period === 'day' ? burn?.perDay : burn?.perWeek) ?? null}
      noun="burned"
      noGoal={<>No burn goal yet — <Link to="/plan" className="font-medium hover:underline" style={{ color: 'var(--primary)' }}>set one in Plan</Link>.</>}
      emptyText={period === 'day' ? 'No workouts yet today.' : 'No workouts yet this week.'}
      footer={
        <>
          <p className="text-xs text-[var(--text-muted)]">
            {baseTotal === null ? (
              <>
                Add your body details on the <Link to="/plan" className="underline">Plan</Link> page to count your base
                burn too.
              </>
            ) : (
              <>
                With base burn {period === 'day' ? baseTotal.toLocaleString() : `${base!.toLocaleString()} × ${days} day${days === 1 ? '' : 's'}`}:{' '}
                <span className="tabular-nums font-semibold text-[var(--text-secondary)]">{(baseTotal + workouts).toLocaleString()} kcal</span>{' '}
                {period === 'day' ? 'today' : 'so far'}{' '}
                <InfoTip label="About base burn">
                  The energy your body uses in a whole day without workouts (resting metabolism × everyday activity),
                  estimated from your body details on the <Link to="/plan" className="underline">Plan</Link> page. It
                  counts towards Burned and Net, but not towards your burn goal, which is for workouts.
                </InfoTip>
              </>
            )}
          </p>
          <Link to="/history/workouts" className="text-xs text-[var(--text-muted)] hover:underline self-start">
            All workouts →
          </Link>
        </>
      }
    />
  )
}
