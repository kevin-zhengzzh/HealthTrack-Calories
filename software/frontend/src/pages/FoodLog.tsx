import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { claimPairingCode, createDevice, deleteIntake, fetchIntakeImageUrl, getDevices, getIntakeHistory, revokeDevice, updateIntake } from '../api'
import { useStore } from '../store'
import { useLockBodyScroll } from '../hooks/useLockBodyScroll'
import type { CreatedDevice, Device, IntakeRecord } from '../types'

// Devices push meals in the background, so poll while the tab is visible
const POLL_MS = 5_000

function localDateStr(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatDay(dateStr: string) {
  const today = localDateStr()
  const yesterday = localDateStr(new Date(Date.now() - 86_400_000))
  if (dateStr === today) return 'Today'
  if (dateStr === yesterday) return 'Yesterday'
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

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
  if (record.confidence === 'low')
    return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800" title="The AI was unsure — worth checking">Check me</span>
  if (record.confidence === 'medium')
    return <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-inset)] text-[var(--text-secondary)]">AI estimate</span>
  return null
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[var(--bg-surface)] rounded-2xl shadow-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

const inputClass = 'border border-[var(--border-strong)] rounded-lg px-4 py-2 text-sm bg-[var(--bg-surface)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-green-500'
const secondaryBtn = 'flex-1 border border-[var(--border-strong)] text-[var(--text-secondary)] rounded-lg py-2 font-semibold hover:bg-[var(--bg-inset)] transition cursor-pointer'
const primaryBtn = 'flex-1 text-white rounded-lg py-2 font-semibold transition disabled:opacity-60 cursor-pointer'

export default function FoodLog() {
  const pushToast = useStore((s) => s.pushToast)
  const [records, setRecords] = useState<IntakeRecord[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)

  const [editing, setEditing] = useState<IntakeRecord | null>(null)
  const [editName, setEditName] = useState('')
  const [editWeight, setEditWeight] = useState('')
  const [editDensity, setEditDensity] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<IntakeRecord | null>(null)
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null)

  const [pairing, setPairing] = useState(false)
  // 'code': enter the code shown on the device (normal); 'key': create a key
  // by hand, for devices without a screen or for scripts
  const [pairMode, setPairMode] = useState<'code' | 'key'>('code')
  const [pairCode, setPairCode] = useState('')
  const [deviceName, setDeviceName] = useState('Stack-chan')
  const [newDevice, setNewDevice] = useState<CreatedDevice | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<Device | null>(null)
  const [busy, setBusy] = useState(false)

  useLockBodyScroll(editing !== null || confirmDelete !== null || viewingPhoto !== null || pairing || newDevice !== null || confirmRevoke !== null)

  // Devices change from the other end too (unpaired on the device, or
  // finishing pairing), so they're polled with the meals. Changes we didn't
  // make on this page are announced; our own edits update the list quietly.
  const devicesRef = useRef<Device[]>([])
  const applyDevices = useCallback((next: Device[], announce: boolean) => {
    if (announce) {
      const prev = devicesRef.current
      for (const d of prev) {
        if (!next.some((n) => n.id === d.id)) pushToast(`${d.name} was unpaired.`, 'success')
      }
      for (const d of next) {
        if (prev.find((p) => p.id === d.id)?.awaitingDevice && !d.awaitingDevice) pushToast(`${d.name} is connected.`, 'success')
      }
    }
    devicesRef.current = next
    setDevices(next)
  }, [pushToast])

  const refresh = useCallback(() => {
    return Promise.all([
      getIntakeHistory().then(setRecords).catch(console.error),
      getDevices().then((ds) => applyDevices(ds, true)).catch(console.error),
    ])
  }, [applyDevices])

  useEffect(() => {
    Promise.all([
      getIntakeHistory().then(setRecords).catch(console.error),
      getDevices().then((ds) => applyDevices(ds, false)).catch(console.error),
    ]).finally(() => setLoading(false))
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, POLL_MS)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh, applyDevices])

  const days = useMemo(() => {
    const byDay = new Map<string, IntakeRecord[]>()
    for (const r of records) {
      const list = byDay.get(r.date) ?? []
      list.push(r)
      byDay.set(r.date, list)
    }
    return [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a))
  }, [records])

  const today = localDateStr()
  const todayRecords = records.filter((r) => r.date === today)
  const todayTotal = todayRecords.reduce((sum, r) => sum + r.calories, 0)

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

  function openPairing() {
    setPairMode('code')
    setPairCode('')
    setPairing(true)
  }

  async function doClaim() {
    const digits = pairCode.replace(/\D/g, '')
    if (digits.length !== 6) return pushToast('Enter the 6-digit code shown on the device.')
    setBusy(true)
    try {
      const device = await claimPairingCode(digits, deviceName.trim())
      setPairing(false)
      pushToast(`${device.name} paired — it will finish setting up by itself.`, 'success')
      // Re-fetch rather than append: pairing the same device again replaces
      // its old record, which should just disappear, not be announced.
      // Polling then shows "connected" once the device collects its key.
      await getDevices().then((ds) => applyDevices(ds, false)).catch(console.error)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to pair device')
    } finally {
      setBusy(false)
    }
  }

  async function doPair() {
    if (!deviceName.trim()) return pushToast('Enter a device name.')
    setBusy(true)
    try {
      const created = await createDevice(deviceName.trim())
      applyDevices([...devicesRef.current, { id: created.id, name: created.name, keyPrefix: created.keyPrefix, createdAt: created.createdAt, lastSeenAt: null, awaitingDevice: false }], false)
      setPairing(false)
      setNewDevice(created)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to pair device')
    } finally {
      setBusy(false)
    }
  }

  async function doRevoke(d: Device) {
    setBusy(true)
    try {
      await revokeDevice(d.id)
      applyDevices(devicesRef.current.filter((x) => x.id !== d.id), false)
      setConfirmRevoke(null)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to remove device')
    } finally {
      setBusy(false)
    }
  }

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key)
      pushToast('Key copied', 'success')
    } catch {
      pushToast('Copy failed — select the key and copy it manually.')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold text-[var(--text-primary)]">Food Log</h1>

      <section className="bg-[var(--bg-surface)] rounded-2xl shadow p-5 flex items-end justify-between gap-4">
        <div>
          <p className="text-sm text-[var(--text-muted)]">Eaten today</p>
          <p className="text-4xl font-bold text-[var(--text-primary)] tabular-nums">
            {todayTotal.toLocaleString()} <span className="text-lg font-semibold text-[var(--text-secondary)]">kcal</span>
          </p>
        </div>
        <p className="text-sm text-[var(--text-muted)]">
          {todayRecords.length} item{todayRecords.length !== 1 ? 's' : ''}
        </p>
      </section>

      {loading ? (
        <p className="text-[var(--text-muted)]">Loading…</p>
      ) : days.length === 0 ? (
        <div className="bg-[var(--bg-surface)] rounded-2xl shadow p-6 text-[var(--text-secondary)] text-sm leading-relaxed">
          <p className="font-semibold text-[var(--text-primary)] mb-1">No meals yet</p>
          {devices.length === 0
            ? 'Pair your scale below, then put food on it — each weighed item shows up here with its photo and calories.'
            : 'Put food on your paired scale and take a photo — it will show up here within a few seconds.'}
        </div>
      ) : (
        days.map(([date, items]) => (
          <section key={date} className="bg-[var(--bg-surface)] rounded-2xl shadow p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">{formatDay(date)}</h2>
              <span className="text-sm font-semibold tabular-nums text-[var(--text-secondary)]">
                {items.reduce((s, r) => s + r.calories, 0).toLocaleString()} kcal
              </span>
            </div>
            <ul className="flex flex-col divide-y divide-[var(--border)]">
              {items.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-3">
                  {r.hasImage
                    ? <MealPhoto id={r.id} alt={r.foodName || 'meal'} onOpen={setViewingPhoto} />
                    : <div className="w-16 h-16 rounded-lg shrink-0 bg-[var(--bg-inset)]" aria-hidden />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-medium truncate ${isUnnamed(r) ? 'text-[var(--text-muted)] italic' : 'text-[var(--text-primary)]'}`}>
                        {isUnnamed(r) ? 'Unnamed food' : r.foodName}
                      </span>
                      <ConfidenceBadge record={r} />
                    </div>
                    <p className="text-xs text-[var(--text-muted)] tabular-nums mt-0.5">
                      {formatTime(r.createdAt)} · {r.weightGrams} g
                      {!isUnnamed(r) && ` · ${r.caloriesPer100g} kcal/100 g`}
                    </p>
                  </div>
                  <span className="font-semibold tabular-nums text-[var(--text-primary)] whitespace-nowrap">
                    {isUnnamed(r) ? '– kcal' : `${r.calories} kcal`}
                  </span>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => startEdit(r)} aria-label="Edit" title="Edit"
                      className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-inset)] cursor-pointer">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                        <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(r)} aria-label="Delete" title="Delete"
                      className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-inset)] hover:text-red-500 cursor-pointer">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                        <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <section className="bg-[var(--bg-surface)] rounded-2xl shadow p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Devices</h2>
          <button type="button" onClick={openPairing}
            className="text-sm font-semibold px-3 py-1.5 rounded-lg cursor-pointer"
            style={{ backgroundColor: 'var(--primary-light)', color: 'var(--primary-text)' }}>
            Add device
          </button>
        </div>
        {devices.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No devices yet. Turn on your Stack-chan, connect it to Wi-Fi, and enter the code it shows here.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium text-[var(--text-primary)] truncate">{d.name}</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {d.awaitingDevice
                      ? 'Waiting for the device to connect…'
                      : <><code>{d.keyPrefix}…</code> · {d.lastSeenAt ? `last seen ${new Date(d.lastSeenAt).toLocaleString()}` : 'never used'}</>}
                  </p>
                </div>
                <button type="button" onClick={() => setConfirmRevoke(d)}
                  className="text-sm text-[var(--text-muted)] hover:text-red-500 px-2 py-1 rounded-lg cursor-pointer">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

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
            <button type="button" onClick={() => doDelete(confirmDelete)} disabled={busy}
              className="flex-1 bg-red-500 text-white rounded-lg py-2 font-semibold hover:bg-red-600 transition disabled:opacity-60 cursor-pointer">
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Modal>
      )}

      {pairing && (
        <Modal onClose={() => setPairing(false)}>
          {pairMode === 'code' ? (
            <>
              <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Add a device</h2>
              <p className="text-sm text-[var(--text-secondary)] mb-4">Enter the 6-digit code shown on the device's screen.</p>
              <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)] mb-3">
                Pairing code
                <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={7}
                  placeholder="123 456" value={pairCode}
                  onChange={(e) => setPairCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') doClaim() }}
                  className={`${inputClass} text-2xl tracking-[0.3em] text-center tabular-nums`} />
              </label>
              <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)] mb-4">
                Name (optional)
                <input type="text" maxLength={40} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} className={inputClass} />
              </label>
              <div className="flex gap-3">
                <button type="button" onClick={() => setPairing(false)} className={secondaryBtn}>Cancel</button>
                <button type="button" onClick={doClaim} disabled={busy} className={primaryBtn} style={{ backgroundColor: 'var(--primary)' }}>
                  {busy ? 'Pairing…' : 'Pair'}
                </button>
              </div>
              <button type="button" onClick={() => setPairMode('key')}
                className="mt-4 text-xs text-[var(--text-muted)] hover:underline cursor-pointer">
                No screen on the device? Create a key manually
              </button>
            </>
          ) : (
            <>
              <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Create a device key</h2>
              <p className="text-sm text-[var(--text-secondary)] mb-4">For devices you configure by hand (firmware secrets or scripts).</p>
              <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)] mb-4">
                Device name
                <input type="text" maxLength={40} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} className={inputClass} />
              </label>
              <div className="flex gap-3">
                <button type="button" onClick={() => setPairMode('code')} className={secondaryBtn}>Back</button>
                <button type="button" onClick={doPair} disabled={busy} className={primaryBtn} style={{ backgroundColor: 'var(--primary)' }}>
                  {busy ? 'Creating…' : 'Create key'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {newDevice && (
        <Modal onClose={() => setNewDevice(null)}>
          <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Device key</h2>
          <p className="text-sm text-[var(--text-secondary)] mb-3">
            Put this key into <strong>{newDevice.name}</strong>'s firmware. It's shown <strong>only once</strong> — if you lose it, remove the device and pair again.
          </p>
          <code className="block break-all text-sm p-3 rounded-lg bg-[var(--bg-inset)] text-[var(--text-primary)] select-all mb-4">{newDevice.key}</code>
          <div className="flex gap-3">
            <button type="button" onClick={() => copyKey(newDevice.key)} className={secondaryBtn}>Copy</button>
            <button type="button" onClick={() => setNewDevice(null)} className={primaryBtn} style={{ backgroundColor: 'var(--primary)' }}>Done</button>
          </div>
        </Modal>
      )}

      {confirmRevoke && (
        <Modal onClose={() => setConfirmRevoke(null)}>
          <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Remove {confirmRevoke.name}?</h2>
          <p className="text-sm text-[var(--text-muted)] mb-4">Its key stops working immediately. Meals it already logged are kept.</p>
          <div className="flex gap-3">
            <button type="button" onClick={() => setConfirmRevoke(null)} className={secondaryBtn}>Cancel</button>
            <button type="button" onClick={() => doRevoke(confirmRevoke)} disabled={busy}
              className="flex-1 bg-red-500 text-white rounded-lg py-2 font-semibold hover:bg-red-600 transition disabled:opacity-60 cursor-pointer">
              {busy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
