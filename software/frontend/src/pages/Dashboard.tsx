import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { checkInToday, getIntakeHistory, getMe, getTodayRewards, getTodayStatus, getWorkoutHistory } from '../api'
import { useStore } from '../store'
import type { CheckInResult, IntakeRecord, WorkoutRecord } from '../types'
import NetBanner from '../components/NetBanner'
import TodayIntakeCard from '../components/TodayIntakeCard'
import TodayBurnCard from '../components/TodayBurnCard'
import { localDateStr } from '../intake'
import InfoTip from '../components/InfoTip'

// Devices log meals in the background
const INTAKE_POLL_MS = 30_000

// Monday of the week containing d, as yyyy-MM-dd
function mondayOf(d: Date) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7))
  return localDateStr(m)
}

// Ticks every second so the header clock stays live while the page is open.
function useNow() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

// Today at a glance: net calories, today's intake and burn against the
// daily goals, and the check-in. Trends live on the Statistics page.
export default function Dashboard() {
  const { user, setUser, checkedInToday, setCheckedInToday, setRewardStatus, pushToast, setStoreOpen, workoutRefreshKey } = useStore()
  const now = useNow()
  const [loading, setLoading] = useState(false)
  const [lastResult, setLastResult] = useState<CheckInResult | null>(null)
  const [workoutHistory, setWorkoutHistory] = useState<WorkoutRecord[]>([])
  const [intake, setIntake] = useState<IntakeRecord[] | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)

  // Re-runs whenever the calendar date changes, not just on mount — a tab
  // left open (or a laptop woken up) past midnight would otherwise keep
  // showing yesterday's state indefinitely, since this page never remounts
  // on its own.
  const todayStr = now.toDateString()
  useEffect(() => {
    Promise.allSettled([
      getMe().then(setUser),
      getTodayStatus().then((r) => {
        setCheckedInToday(r.checkedIn)
        setLastResult(r.result ?? null)
      }),
      getWorkoutHistory().then(setWorkoutHistory),
    ]).then(() => setInitialLoading(false))
  }, [todayStr])

  // A workout recorded from the shared Record modal (which can be opened
  // from any page) doesn't touch this page's local state directly.
  useEffect(() => {
    if (workoutRefreshKey === 0) return
    getWorkoutHistory().then(setWorkoutHistory).catch(console.error)
  }, [workoutRefreshKey])

  const loadIntake = useCallback(() => getIntakeHistory().then(setIntake).catch(console.error), [])
  useEffect(() => {
    loadIntake()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') loadIntake() }, INTAKE_POLL_MS)
    window.addEventListener('focus', loadIntake)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', loadIntake)
    }
  }, [loadIntake, todayStr])

  async function handleCheckIn() {
    if (checkedInToday) {
      pushToast('Already checked in today. Come back tomorrow!')
      return
    }
    setLoading(true)
    try {
      const result = await checkInToday()
      setLastResult(result)
      setCheckedInToday(true)
      pushToast(`+${result.pointsEarned} pts ready to claim in Daily Tasks · ${result.streak}-day streak`, 'success')
      getTodayRewards().then(setRewardStatus).catch(console.error)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Check-in failed')
    } finally {
      setLoading(false)
    }
  }

  // The backend only updates streak at check-in time, so it still holds
  // yesterday's value until today's check-in happens — show 0 until then
  // rather than a stale streak that looks "already earned" for today.
  const displayStreak = checkedInToday ? (user?.streak ?? 0) : 0

  // Today's meals and workouts (both dated by the user's local day)
  const today = localDateStr(now)
  const weekStart = mondayOf(now)
  const todayMeals = useMemo(() => intake?.filter((r) => r.date === today) ?? null, [intake, today])
  const todayWorkouts = useMemo(() => workoutHistory.filter((r) => r.date === today), [workoutHistory, today])
  const weekBurned = workoutHistory.filter((r) => r.date >= weekStart && r.date <= today).reduce((s, r) => s + r.calories, 0)
  const eaten = (todayMeals ?? []).reduce((s, r) => s + r.calories, 0)
  const burned = todayWorkouts.reduce((s, r) => s + r.calories, 0)

  return (
    <div className="flex flex-col gap-6">
      {/* Top row: today's check-in (the one thing to do), Points and Streak.
          No page title — the sidebar already says where you are. */}
      <div className="grid grid-cols-2 lg:grid-cols-[1fr_auto_auto] gap-4">
        <div className="col-span-2 lg:col-span-1">
          <CheckInBar
            loading={initialLoading}
            checkedIn={checkedInToday}
            busy={loading}
            lastResult={lastResult}
            onCheckIn={handleCheckIn}
          />
        </div>
        {user && (
          <>
            <StatCard
              label="Points"
              value={user.points}
              tip={
                <ul className="list-disc pl-4 space-y-1">
                  <li>10 base points per check-in</li>
                  <li>+streak × 2 bonus (e.g. 5-day streak = +10)</li>
                  <li>Recording a workout earns +10 points, once a day</li>
                  <li>
                    Spend them in the{' '}
                    <button onClick={() => setStoreOpen(true)} className="font-semibold underline cursor-pointer text-green-300">
                      Store
                    </button>{' '}
                    to unlock app skins
                  </li>
                </ul>
              }
            />
            <StatCard label="Current streak" value={`${displayStreak} day${displayStreak === 1 ? '' : 's'}`} />
          </>
        )}
      </div>

      <NetBanner
        eaten={eaten}
        burned={burned}
        meals={todayMeals?.length ?? 0}
        workouts={todayWorkouts.length}
        loading={todayMeals === null || initialLoading}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TodayIntakeCard records={todayMeals} />
        <TodayBurnCard today={todayWorkouts} weekTotal={weekBurned} loading={initialLoading} />
      </div>

    </div>
  )
}

function StatCard({ label, value, tip }: { label: string; value: string | number; tip?: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-4 lg:min-w-40 flex flex-col justify-center" style={{ backgroundColor: 'var(--primary-light)', color: 'var(--primary-text)' }}>
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</p>
        {tip && <InfoTip label={`About ${label}`} align="right">{tip}</InfoTip>}
      </div>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  )
}

// Today's check-in as one row: status on the left, the button on the right.
// Same structure in both states so it never changes size; after checking in
// the button stays, greyed out.
function CheckInBar({
  loading,
  checkedIn,
  busy,
  lastResult,
  onCheckIn,
}: {
  loading: boolean
  checkedIn: boolean
  busy: boolean
  lastResult: CheckInResult | null
  onCheckIn: () => void
}) {
  if (loading) {
    return (
      <div className="h-full bg-[var(--bg-surface)] rounded-2xl shadow p-5 flex items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-[var(--bg-inset)] animate-pulse" />
        <div className="flex-1 flex flex-col gap-2">
          <div className="h-5 w-48 rounded bg-[var(--bg-inset)] animate-pulse" />
          <div className="h-4 w-72 max-w-full rounded bg-[var(--bg-inset)] animate-pulse" />
        </div>
      </div>
    )
  }
  return (
    <div className="h-full bg-[var(--bg-surface)] rounded-2xl shadow p-5 flex flex-col sm:flex-row sm:items-center gap-4">
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <div className="w-12 h-12 shrink-0 flex items-center justify-center">
          {checkedIn ? (
            <div className="w-12 h-12 rounded-full flex items-center justify-center text-white" style={{ backgroundColor: 'var(--primary)' }}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
          ) : (
            <span className="text-4xl leading-none">🏃</span>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-lg font-semibold text-[var(--text-secondary)]">
            {checkedIn ? 'You checked in today!' : 'Did you exercise today?'}
          </p>
          <p className="text-sm text-[var(--text-muted)]">
            {checkedIn
              ? lastResult
                ? <>You've surpassed <Link to="/rank" className="font-bold hover:underline" style={{ color: 'var(--primary)' }}>{lastResult.percentSurpassed}%</Link> of users today. Come back tomorrow!</>
                : 'Come back tomorrow to keep your streak going.'
              : 'Check in to keep your streak and earn points.'}
          </p>
        </div>
      </div>
      <button
        onClick={onCheckIn}
        disabled={busy}
        className="shrink-0 text-white font-bold px-8 py-3 rounded-xl shadow transition-transform active:scale-95 disabled:opacity-60 cursor-pointer"
        style={{ backgroundColor: checkedIn ? 'var(--border-strong)' : 'var(--primary)' }}
        onMouseEnter={(e) => { if (!checkedIn) e.currentTarget.style.backgroundColor = 'var(--primary-hover)' }}
        onMouseLeave={(e) => { if (!checkedIn) e.currentTarget.style.backgroundColor = 'var(--primary)' }}
      >
        {checkedIn ? '✓ Checked In' : busy ? 'Checking in…' : '✓ Check In'}
      </button>
    </div>
  )
}
