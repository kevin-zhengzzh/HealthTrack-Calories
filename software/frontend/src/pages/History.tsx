import { useEffect, useMemo, useState } from 'react'
import { getCheckInHistory } from '../api'
import type { CheckIn } from '../types'
import { EmptyCard, GroupCard, LoadingCard, Row, ShowMore, Tile } from '../components/HistoryParts'
import { formatDay, formatMonth, formatTime, groupBy, GROUPS_PER_PAGE } from '../historyFormat'

// The Check-ins tab of History. One check-in a day, so the cards are per
// month (a card per day would hold a single row); rows look like the Food Log.
export default function History() {
  const [history, setHistory] = useState<CheckIn[]>([])
  const [loading, setLoading] = useState(true)
  const [shownMonths, setShownMonths] = useState(GROUPS_PER_PAGE)

  useEffect(() => {
    getCheckInHistory().then(setHistory).catch(console.error).finally(() => setLoading(false))
  }, [])

  const months = useMemo(
    () => groupBy([...history].sort((a, b) => b.date.localeCompare(a.date)), (c) => c.date.slice(0, 7)),
    [history],
  )

  return (
    <div className="flex flex-col gap-6">
      {loading ? (
        <LoadingCard />
      ) : history.length === 0 ? (
        <EmptyCard title="No check-ins yet">Check in from the Dashboard — each day you do shows up here.</EmptyCard>
      ) : (
        months.slice(0, shownMonths).map(([month, items]) => (
          <GroupCard key={month} title={formatMonth(month)} total={`${items.length} check-in${items.length !== 1 ? 's' : ''}`}>
            {items.map((c) => (
              <Row
                key={c.id}
                tile={<Tile color="var(--primary-light)"><span style={{ color: 'var(--primary-text)' }}>✓</span></Tile>}
                name={formatDay(c.date)}
                detail={<>Checked in at {formatTime(c.createdAt)}{c.note && ` · ${c.note}`}</>}
              />
            ))}
          </GroupCard>
        ))
      )}

      <ShowMore shown={shownMonths} total={months.length} onMore={() => setShownMonths((n) => n + GROUPS_PER_PAGE)} noun="months" />
    </div>
  )
}
