import { useEffect, useMemo, useState } from 'react'
import { getPointHistory } from '../api'
import { localDateStr } from '../intake'
import { useStore } from '../store'
import type { PointTransaction } from '../types'
import { EmptyCard, GroupCard, LoadingCard, Row, ShowMore, Tile } from '../components/HistoryParts'
import { formatDay, formatTime, groupBy, GROUPS_PER_PAGE } from '../historyFormat'

// The Points tab of History: points earned (check-ins, workouts) and spent
// (skins), a card per day like the Food Log. Opened from the user menu too.
const SPEND_COLOR = '#dc2626'
// Translucent, so it works on the light and the dark theme alike
const SPEND_TILE = 'rgba(220, 38, 38, 0.15)'

function icon(reason: string) {
  if (reason.startsWith('Daily check-in')) return '✓'
  if (reason.startsWith('Workout')) return '🏃'
  if (reason.startsWith('Purchased')) return '🎨'
  return '⭐'
}

const fmtPts = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString()} pts`

export default function PointsHistory() {
  const points = useStore((s) => s.user?.points)
  const leaderboardRefreshKey = useStore((s) => s.leaderboardRefreshKey)
  const [history, setHistory] = useState<PointTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [shownDays, setShownDays] = useState(GROUPS_PER_PAGE)

  // Refetched when rewards are claimed from Daily Tasks (which bumps this key)
  useEffect(() => {
    getPointHistory().then(setHistory).catch(console.error).finally(() => setLoading(false))
  }, [leaderboardRefreshKey])

  // Grouped by the local day the points changed
  const days = useMemo(
    () => groupBy([...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), (t) => localDateStr(new Date(t.createdAt))),
    [history],
  )

  return (
    <div className="flex flex-col gap-6">
      {points != null && (
        <p className="text-sm text-[var(--text-muted)] -mb-2">
          Balance <span className="font-semibold tabular-nums text-[var(--text-primary)]">{points.toLocaleString()} pts</span>
          {' '}· earn them by checking in and recording workouts, spend them on skins in the Store.
        </p>
      )}

      {loading ? (
        <LoadingCard />
      ) : history.length === 0 ? (
        <EmptyCard title="No points yet">Check in or record a workout, then claim the points in Daily Tasks.</EmptyCard>
      ) : (
        days.slice(0, shownDays).map(([date, items]) => (
          <GroupCard key={date} title={formatDay(date)} total={fmtPts(items.reduce((s, t) => s + t.amount, 0))}>
            {items.map((t) => (
              <Row
                key={t.id}
                tile={
                  <Tile color={t.amount < 0 ? SPEND_TILE : 'var(--primary-light)'}>
                    <span style={{ color: t.amount < 0 ? SPEND_COLOR : 'var(--primary-text)' }}>{icon(t.reason)}</span>
                  </Tile>
                }
                name={t.reason}
                detail={formatTime(t.createdAt)}
                figure={<span style={{ color: t.amount < 0 ? SPEND_COLOR : 'var(--primary-text)' }}>{fmtPts(t.amount)}</span>}
              />
            ))}
          </GroupCard>
        ))
      )}

      <ShowMore shown={shownDays} total={days.length} onMore={() => setShownDays((n) => n + GROUPS_PER_PAGE)} noun="days" />
    </div>
  )
}
