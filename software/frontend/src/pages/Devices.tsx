import { useCallback, useEffect, useRef, useState } from 'react'
import { claimPairingCode, createDevice, getDevices, revokeDevice } from '../api'
import { useStore } from '../store'
import { useLockBodyScroll } from '../hooks/useLockBodyScroll'
import type { CreatedDevice, Device } from '../types'
import { Modal, Tile } from '../components/HistoryParts'
import { dangerBtn, inputClass, primaryBtn, secondaryBtn } from '../historyFormat'

// Devices (the Stack-chan scale): pairing, the list, removing. Its own page
// so device features (status, firmware, settings) have somewhere to grow.
// Devices also change from the other end (unpaired on the device, finishing
// pairing), so the list is polled while the page is open.
const POLL_MS = 5_000

// Same bands as the bars on the device's Wi-Fi list
function signal(rssi: number) {
  if (rssi > -55) return 'strong'
  if (rssi > -67) return 'good'
  if (rssi > -75) return 'fair'
  return 'weak'
}

// "Firmware 0.6.0 · Wi-Fi fair (−71 dBm) · Scale connected · 2 meals waiting to upload"
function StatusLine({ d }: { d: Device }) {
  if (!d.statusAt) {
    return <p className="text-xs text-[var(--text-muted)] mt-0.5">Status shows up after the device next checks in (needs firmware 0.6 or newer).</p>
  }
  const parts: React.ReactNode[] = []
  if (d.firmwareVersion) parts.push(`Firmware ${d.firmwareVersion}`)
  if (d.wifiRssi != null) {
    const s = signal(d.wifiRssi)
    parts.push(<span key="wifi" className={s === 'weak' ? 'text-amber-600' : undefined}>Wi-Fi {s} ({d.wifiRssi} dBm)</span>)
  }
  if (d.scaleConnected != null) {
    parts.push(d.scaleConnected
      ? 'Scale connected'
      : <span key="scale" className="text-amber-600">Scale not connected</span>)
  }
  if (d.pendingUploads) {
    parts.push(<span key="queue" className="text-amber-600">{d.pendingUploads} meal{d.pendingUploads === 1 ? '' : 's'} waiting to upload</span>)
  }
  return (
    <p className="text-xs text-[var(--text-muted)] mt-0.5 tabular-nums">
      {parts.map((p, i) => <span key={i}>{i > 0 && ' · '}{p}</span>)}
      <span className="block">as of {fmtSeen(d.statusAt)}</span>
    </p>
  )
}

const fmtSeen = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

export default function Devices() {
  const pushToast = useStore((s) => s.pushToast)
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [pairing, setPairing] = useState(false)
  // 'code': enter the code shown on the device (normal); 'key': create a key
  // by hand, for devices without a screen or for scripts
  const [pairMode, setPairMode] = useState<'code' | 'key'>('code')
  const [pairCode, setPairCode] = useState('')
  const [deviceName, setDeviceName] = useState('Stack-chan')
  const [newDevice, setNewDevice] = useState<CreatedDevice | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<Device | null>(null)
  const [busy, setBusy] = useState(false)

  useLockBodyScroll(pairing || newDevice !== null || confirmRevoke !== null)

  // Changes we didn't make on this page are announced; our own edits update
  // the list quietly
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

  useEffect(() => {
    getDevices().then((ds) => applyDevices(ds, false)).catch(console.error).finally(() => setLoading(false))
    const refresh = () => getDevices().then((ds) => applyDevices(ds, true)).catch(console.error)
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [applyDevices])

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

  async function doCreateKey() {
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
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-3xl font-bold text-[var(--text-primary)]">Device</h1>
        <button type="button" onClick={openPairing}
          className="text-sm font-semibold px-4 py-2 rounded-lg cursor-pointer"
          style={{ backgroundColor: 'var(--primary-light)', color: 'var(--primary-text)' }}>
          + Add device
        </button>
      </div>

      <section className="bg-[var(--bg-surface)] rounded-2xl shadow p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Paired devices</h2>
          <span className="text-sm font-semibold tabular-nums text-[var(--text-secondary)]">{loading ? '' : `${devices.length} of 5`}</span>
        </div>
        {loading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            No devices yet. Turn on your Stack-chan, connect it to Wi-Fi, then press <b>+ Add device</b> and enter the
            code it shows. Food you weigh on it then appears in your Food Log with its photo and calories.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-3">
                <Tile>⚖️</Tile>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate text-[var(--text-primary)]">{d.name}</span>
                    {d.awaitingDevice
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Connecting…</span>
                      : <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--primary-light)', color: 'var(--primary-text)' }}>Paired</span>}
                  </div>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    {d.awaitingDevice
                      ? 'Waiting for the device to collect its key…'
                      : <><code>{d.keyPrefix}…</code> · {d.lastSeenAt ? `last seen ${fmtSeen(d.lastSeenAt)}` : 'never used'}</>}
                  </p>
                  {!d.awaitingDevice && <StatusLine d={d} />}
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
                <button type="button" onClick={doCreateKey} disabled={busy} className={primaryBtn} style={{ backgroundColor: 'var(--primary)' }}>
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
            <button type="button" onClick={() => doRevoke(confirmRevoke)} disabled={busy} className={dangerBtn}>
              {busy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
