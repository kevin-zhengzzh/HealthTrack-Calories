import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { deleteIntake, fetchIntakeImageUrl, getIntakeHistory, updateIntake } from '../api'
import { useStore } from '../store'
import { useLockBodyScroll } from '../hooks/useLockBodyScroll'
import type { IntakeRecord } from '../types'
import { DeleteButton, EditButton, EmptyCard, GroupCard, LoadingCard, Modal, Row, SearchBox, ShowMore } from '../components/HistoryParts'
import { dangerBtn, formatDay, formatTime, fuzzyMatch, groupBy, GROUPS_PER_PAGE, inputClass, primaryBtn, secondaryBtn } from '../historyFormat'

// Devices push meals in the background, so poll while the tab is visible
const POLL_MS = 5_000

// Uploads stored as photo + weight only have no name or calories yet
const isUnnamed = (r: IntakeRecord) => r.foodName === ''

function MealPhoto({ id, alt, onOpen }: { id: number; alt: string; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | null = null
    fetchIntakeImageUrl(id, controller.signal)
      .then((u) => { objectUrl = u; setUrl(u) })
      .catch(() => {})
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id])

  return url
    ? (
      <button type="button" onClick={() => onOpen(url)} className="shrink-0 cursor-zoom-in" aria-label={`View photo of ${alt}`}>
        <img src={url} alt={alt} className="w-16 h-16 rounded-lg object-cover bg-[var(--bg-inset)]" />
      </button>
    )
    : <div className="w-16 h-16 rounded-lg shrink-0 bg-[var(--bg-inset)]" aria-hidden />
}

function ConfidenceBadge({ record }: { record: IntakeRecord }) {
  if (isUnnamed(record))
    return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Add details</span>
  if (record.corrected)
    return <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-inset)] text-[var(--text-secondary)]">Edited</span>
  if (record.confidence === 'manual')
    return <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-inset)] text-[var(--text-secondary)]">Typed in</span>
  if (record.confidence === 'low')
    return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800" title="The AI was unsure — worth checking">Check me</span>
  if (record.confidence === 'medium')
    return <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-inset)] text-[var(--text-secondary)]">AI estimate</span>
  return null
}

export default function FoodLog() {
  const pushToast = useStore((s) => s.pushToast)
  const intakeRefreshKey = useStore((s) => s.intakeRefreshKey)
  const [records, setRecords] = useState<IntakeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [shownDays, setShownDays] = useState(GROUPS_PER_PAGE)

  const [editing, setEditing] = useState<IntakeRecord | null>(null)
  const [editName, setEditName] = useState('')
  const [editWeight, setEditWeight] = useState('')
  const [editDensity, setEditDensity] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<IntakeRecord | null>(null)
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useLockBodyScroll(editing !== null || confirmDelete !== null || viewingPhoto !== null)

  const refresh = useCallback(() => getIntakeHistory().then(setRecords).catch(console.error), [])

  useEffect(() => {
    refresh().finally(() => setLoading(false))
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  // A meal added from the + menu elsewhere on the page
  useEffect(() => {
    if (intakeRefreshKey > 0) refresh()
  }, [intakeRefreshKey, refresh])

  const days = useMemo(
    () => groupBy(records.filter((r) => fuzzyMatch(search, r.foodName || 'Unnamed food')), (r) => r.date),
    [records, search],
  )

  function startEdit(r: IntakeRecord) {
    setEditing(r)
    setEditName(r.foodName)
    setEditWeight(String(r.weightGrams))
    setEditDensity(String(r.caloriesPer100g))
  }

  const previewCalories = Math.round((Number(editWeight) * Number(editDensity)) / 100)

  async function saveEdit() {
    if (!editing) return
    const weight = Number(editWeight)
    const density = Number(editDensity)
    if (!editName.trim()) return pushToast('Enter a food name.')
    if (!(weight >= 1 && weight <= 5000)) return pushToast('Weight must be 1–5000 g.')
    if (!(density >= 0 && density <= 900)) return pushToast('Calories per 100 g must be 0–900.')
    setSaving(true)
    try {
      const updated = await updateIntake(editing.id, editName.trim(), weight, density)
      setRecords((rs) => rs.map((r) => (r.id === updated.id ? updated : r)))
      setEditing(null)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to save changes')
    } finally {
      setSaving(false)
    }
  }

  async function doDelete(r: IntakeRecord) {
    setBusy(true)
    try {
      await deleteIntake(r.id)
      setRecords((rs) => rs.filter((x) => x.id !== r.id))
      setConfirmDelete(null)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {!loading && records.length > 0 && (
        <div className="flex flex-col gap-2">
          <SearchBox value={search} onChange={(v) => { setSearch(v); setShownDays(GROUPS_PER_PAGE) }} placeholder="Search by food…" />
          <p className="text-xs text-[var(--text-muted)] px-1">
            Calories are estimates: the AI names the food from the photo, times the weight (measured by the scale, or
            typed in for phone photos). Tap ✎ to correct an entry. <Link to="/disclaimer" className="underline">Disclaimer</Link>
          </p>
        </div>
      )}

      {loading ? (
        <LoadingCard />
      ) : records.length === 0 ? (
        <EmptyCard title="No meals yet">
          Put food on your paired scale (pair one on the <Link to="/device" className="underline">Device</Link> page) —
          each weighed item shows up here with its photo and calories. You can also add a meal by hand with the + button.
        </EmptyCard>
      ) : days.length === 0 ? (
        <EmptyCard title="Nothing found">No meals match "{search}".</EmptyCard>
      ) : (
        days.slice(0, shownDays).map(([date, items]) => (
          <GroupCard key={date} title={formatDay(date)} total={`${items.reduce((s, r) => s + r.calories, 0).toLocaleString()} kcal`}>
            {items.map((r) => (
              <Row
                key={r.id}
                tile={r.hasImage
                  ? <MealPhoto id={r.id} alt={r.foodName || 'meal'} onOpen={setViewingPhoto} />
                  : <div className="w-16 h-16 rounded-lg shrink-0 bg-[var(--bg-inset)] flex items-center justify-center text-2xl" aria-hidden>🍽️</div>}
                name={isUnnamed(r) ? <span className="text-[var(--text-muted)] italic">Unnamed food</span> : r.foodName}
                badge={<>
                  <ConfidenceBadge record={r} />
                  {r.source === 'photo' && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-inset)] text-[var(--text-secondary)]"
                      title="Added from a phone photo: the weight was typed in or estimated, not measured by the scale">
                      Phone photo
                    </span>
                  )}
                </>}
                detail={<>{formatTime(r.createdAt)} · {r.weightGrams} g{!isUnnamed(r) && ` · ${r.caloriesPer100g} kcal/100 g`}</>}
                figure={isUnnamed(r) ? '– kcal' : `${r.calories} kcal`}
                actions={<>
                  <EditButton onClick={() => startEdit(r)} />
                  <DeleteButton onClick={() => setConfirmDelete(r)} />
                </>}
              />
            ))}
          </GroupCard>
        ))
      )}

      <ShowMore shown={shownDays} total={days.length} onMore={() => setShownDays((n) => n + GROUPS_PER_PAGE)} noun="days" />

      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">{isUnnamed(editing) ? 'Add details' : 'Correct entry'}</h2>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
              Food
              <input type="text" maxLength={80} value={editName} onChange={(e) => setEditName(e.target.value)} className={inputClass} />
            </label>
            <div className="flex gap-3">
              <label className="flex-1 flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
                Weight (g)
                <input type="number" min={1} max={5000} step="0.1" value={editWeight} onChange={(e) => setEditWeight(e.target.value)} className={inputClass} />
              </label>
              <label className="flex-1 flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
                kcal / 100 g
                <input type="number" min={0} max={900} step="0.1" value={editDensity} onChange={(e) => setEditDensity(e.target.value)} className={inputClass} />
              </label>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              Total: <span className="font-semibold tabular-nums">{Number.isFinite(previewCalories) ? previewCalories : '–'} kcal</span>
            </p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setEditing(null)} className={secondaryBtn}>Cancel</button>
              <button type="button" onClick={saveEdit} disabled={saving} className={primaryBtn} style={{ backgroundColor: 'var(--primary)' }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {viewingPhoto && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 cursor-zoom-out" onClick={() => setViewingPhoto(null)}>
          <img src={viewingPhoto} alt="Meal photo" className="max-w-full max-h-full rounded-xl shadow-xl" />
        </div>
      )}

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)}>
          <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Delete {confirmDelete.foodName || 'this entry'}?</h2>
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
