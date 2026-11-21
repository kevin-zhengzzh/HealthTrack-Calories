import { useEffect, useMemo, useState } from 'react'
import { deleteWorkout, getWorkoutHistory, updateWorkout } from '../api'
import { useStore } from '../store'
import { WORKOUT_TYPES, type WorkoutRecord } from '../types'
import { useLockBodyScroll } from '../hooks/useLockBodyScroll'
import { DeleteButton, EditButton, EmptyCard, GroupCard, LoadingCard, Modal, Row, SearchBox, ShowMore, Tile } from '../components/HistoryParts'
import { dangerBtn, formatDay, formatTime, fuzzyMatch, groupBy, GROUPS_PER_PAGE, inputClass, primaryBtn, secondaryBtn } from '../historyFormat'

const WORKOUT_EMOJI: Record<string, string> = {
  Running: '🏃', Cycling: '🚴', Swimming: '🏊', Gym: '🏋️', Yoga: '🧘', Other: '💪',
}

// The Workouts tab of History: a card per day, like the Food Log
export default function RecordHistory() {
  const pushToast = useStore((s) => s.pushToast)
  const workoutRefreshKey = useStore((s) => s.workoutRefreshKey)
  const [history, setHistory] = useState<WorkoutRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [shownDays, setShownDays] = useState(GROUPS_PER_PAGE)
  const [editing, setEditing] = useState<WorkoutRecord | null>(null)
  const [editType, setEditType] = useState<string>(WORKOUT_TYPES[0])
  const [editCalories, setEditCalories] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<WorkoutRecord | null>(null)
  const [busy, setBusy] = useState(false)
  useLockBodyScroll(editing !== null || confirmDelete !== null)

  // Refetched when a workout is recorded from the shared + menu
  useEffect(() => {
    getWorkoutHistory().then(setHistory).catch(console.error).finally(() => setLoading(false))
  }, [workoutRefreshKey])

  const days = useMemo(
    () => groupBy(history.filter((w) => fuzzyMatch(search, w.workoutType)), (w) => w.date),
    [history, search],
  )

  function startEdit(w: WorkoutRecord) {
    setEditing(w)
    setEditType(w.workoutType)
    setEditCalories(String(w.calories))
  }

  async function saveEdit() {
    if (!editing) return
    const caloriesNum = Number(editCalories)
    if (!editCalories || !Number.isInteger(caloriesNum) || caloriesNum <= 0 || caloriesNum > 10000)
      return pushToast('Enter a valid calorie amount (1–10000).')
    setSaving(true)
    try {
      const updated = await updateWorkout(editing.id, editType, caloriesNum)
      setHistory((h) => h.map((w) => (w.id === updated.id ? updated : w)))
      setEditing(null)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to save changes')
    } finally {
      setSaving(false)
    }
  }

  async function doDelete(w: WorkoutRecord) {
    setBusy(true)
    try {
      await deleteWorkout(w.id)
      setHistory((h) => h.filter((x) => x.id !== w.id))
      setConfirmDelete(null)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to delete record')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {!loading && history.length > 0 && <SearchBox value={search} onChange={(v) => { setSearch(v); setShownDays(GROUPS_PER_PAGE) }} placeholder="Search by workout type…" />}

      {loading ? (
        <LoadingCard />
      ) : history.length === 0 ? (
        <EmptyCard title="No workouts yet">Record one with the + button — it shows up here, a card per day.</EmptyCard>
      ) : days.length === 0 ? (
        <EmptyCard title="Nothing found">No workouts match "{search}".</EmptyCard>
      ) : (
        days.slice(0, shownDays).map(([date, items]) => (
          <GroupCard key={date} title={formatDay(date)} total={`${items.reduce((s, w) => s + w.calories, 0).toLocaleString()} kcal`}>
            {items.map((w) => (
              <Row
                key={w.id}
                tile={<Tile>{WORKOUT_EMOJI[w.workoutType] ?? '💪'}</Tile>}
                name={w.workoutType}
                detail={formatTime(w.createdAt)}
                figure={`${w.calories} kcal`}
                actions={<>
                  <EditButton onClick={() => startEdit(w)} />
                  <DeleteButton onClick={() => setConfirmDelete(w)} />
                </>}
              />
            ))}
          </GroupCard>
        ))
      )}

      <ShowMore shown={shownDays} total={days.length} onMore={() => setShownDays((n) => n + GROUPS_PER_PAGE)} noun="days" />

      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">Edit workout</h2>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
              Workout type
              <select value={editType} onChange={(e) => setEditType(e.target.value)} className={inputClass}>
                {WORKOUT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
              Calories burned
              <input type="number" min={1} max={10000} step={1} value={editCalories}
                onChange={(e) => setEditCalories(e.target.value)}
                onKeyDown={(e) => { if (['e', 'E', '+', '-', '.'].includes(e.key)) e.preventDefault() }}
                className={inputClass} />
            </label>
            <div className="flex gap-3">
              <button type="button" onClick={() => setEditing(null)} className={secondaryBtn}>Cancel</button>
              <button type="button" onClick={saveEdit} disabled={saving} className={primaryBtn} style={{ backgroundColor: 'var(--primary)' }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)}>
          <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Delete {confirmDelete.workoutType}?</h2>
          <p className="text-sm text-[var(--text-muted)] mb-4">This can't be undone.</p>
          <div className="flex gap-3">
            <button type="button" onClick={() => setConfirmDelete(null)} className={secondaryBtn}>Cancel</button>
            <button type="button" onClick={() => doDelete(confirmDelete)} disabled={busy} className={dangerBtn}>
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
