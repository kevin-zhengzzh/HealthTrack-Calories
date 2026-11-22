import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { addIntake, addPhotoMeal, recognizeMealPhoto } from '../api'
import { INTAKE_COLOR } from '../goals'
import { useStore } from '../store'
import type { PhotoRecognition } from '../types'
import { useLockBodyScroll } from '../hooks/useLockBodyScroll'
import { inputClass, primaryBtn, secondaryBtn } from '../historyFormat'
import { shrinkPhoto } from '../imageResize'
import { Modal } from './HistoryParts'

// Add meal, without the scale (AGENTS.md D-37). Two ways in:
// - Photo: take or pick a photo; it's shrunk in the browser (which also drops
//   its EXIF/GPS data) and the model names the food, its kcal/100 g and a
//   rough portion weight. Nothing is saved until the user checks the form
//   and presses Add; the meal is then stored with its photo.
// - Type it in: name, grams and kcal/100 g (as on a food label).
// Either way the total is grams × kcal/100 g, worked out by the server.

type Mode = 'photo' | 'type'
type PhotoState =
  | { step: 'pick' }
  | { step: 'working' }
  | { step: 'result'; ai: PhotoRecognition }
  | { step: 'not-food' }
  | { step: 'error'; message: string }

export default function MealModal() {
  const { pushToast, bumpIntakeRefresh } = useStore()
  const open = useStore((s) => s.mealModalOpen)
  const setOpen = useStore((s) => s.setMealModalOpen)
  const [mode, setMode] = useState<Mode>('photo')
  const [name, setName] = useState('')
  const [grams, setGrams] = useState('')
  const [density, setDensity] = useState('')
  const [saving, setSaving] = useState(false)
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [state, setState] = useState<PhotoState>({ step: 'pick' })
  const fileRef = useRef<HTMLInputElement>(null)
  useLockBodyScroll(open)

  // Fresh dialog every time it opens
  useEffect(() => {
    if (!open) return
    setMode('photo')
    setName('')
    setGrams('')
    setDensity('')
    setPhoto(null)
    setState({ step: 'pick' })
  }, [open])

  // The preview's object URL lives as long as the photo
  useEffect(() => {
    if (!photo) { setPreview(null); return }
    const url = URL.createObjectURL(photo)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  async function onPhotoChosen(file: File | undefined) {
    if (!file) return
    setState({ step: 'working' })
    let small: Blob
    try {
      small = await shrinkPhoto(file)
    } catch {
      setPhoto(null)
      setState({ step: 'error', message: "Couldn't read that photo. Try another one, or type the meal in." })
      return
    }
    setPhoto(small)
    try {
      const ai = await recognizeMealPhoto(small)
      if (!ai.isFood) {
        setState({ step: 'not-food' })
        return
      }
      setName(ai.foodName)
      setDensity(String(ai.caloriesPer100g))
      setGrams(ai.estimatedGrams ? String(ai.estimatedGrams) : '')
      setState({ step: 'result', ai })
    } catch (err: unknown) {
      setState({ step: 'error', message: err instanceof Error ? err.message : 'Recognition failed.' })
    }
  }

  function pickAnother() {
    if (fileRef.current) fileRef.current.value = ''
    fileRef.current?.click()
  }

  const total = Math.round((Number(grams) * Number(density)) / 100)
  const showForm = mode === 'type' || state.step === 'result'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const g = Number(grams)
    const d = Number(density)
    if (!name.trim()) return pushToast('Enter a food name.')
    if (!(g >= 1 && g <= 5000)) return pushToast('Weight must be 1–5000 g.')
    if (!(d >= 0 && d <= 900)) return pushToast('Calories per 100 g must be 0–900.')
    setSaving(true)
    try {
      const r = mode === 'photo' && state.step === 'result' && photo
        ? await addPhotoMeal(photo, {
          foodName: name.trim(),
          weightGrams: g,
          caloriesPer100g: d,
          confidence: state.ai.confidence,
          // The weight is expected to change; the name or density changing means the AI was corrected
          corrected: name.trim() !== state.ai.foodName || d !== state.ai.caloriesPer100g,
        })
        : await addIntake(name.trim(), g, d)
      bumpIntakeRefresh()
      pushToast(`${r.foodName} added — ${r.calories} kcal.`, 'success')
      setOpen(false)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to add meal')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null
  return (
    <Modal onClose={() => setOpen(false)}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-xl font-bold text-[var(--text-primary)]">Add meal</h2>
        <div className="inline-flex bg-[var(--bg-inset)] rounded-full p-1 text-xs" role="tablist" aria-label="How to add">
          {([['photo', '📷 Photo'], ['type', 'Type it in']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => setMode(id)}
              className={`px-3 py-1 rounded-full font-medium cursor-pointer ${mode === id ? 'shadow-sm' : 'text-[var(--text-muted)]'}`}
              style={mode === id ? { backgroundColor: 'var(--primary-light)', color: 'var(--primary-text)' } : undefined}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* capture: phones open the camera straight away; computers pick a file */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Meal photo"
        onChange={(e) => onPhotoChosen(e.target.files?.[0])} />

      {mode === 'photo' ? (
        <div className="flex flex-col gap-3 mb-4">
          {preview && (
            <img src={preview} alt="Your meal" className="w-full max-h-48 object-cover rounded-xl bg-[var(--bg-inset)]" />
          )}
          {state.step === 'pick' && (
            <>
              <button type="button" onClick={pickAnother}
                className="w-full rounded-xl border-2 border-dashed border-[var(--border-strong)] py-8 flex flex-col items-center gap-1 text-[var(--text-secondary)] hover:bg-[var(--bg-inset)] cursor-pointer">
                <span className="text-3xl" aria-hidden>📷</span>
                <span className="font-semibold">Take or choose a photo</span>
                <span className="text-xs text-[var(--text-muted)]">The AI names the food and estimates its calories</span>
              </button>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                You check everything before it's saved. Photos are shrunk on your device first, and location data is removed.
              </p>
            </>
          )}
          {state.step === 'working' && (
            <p className="text-sm text-[var(--text-secondary)] flex items-center gap-2" role="status">
              <span className="w-4 h-4 rounded-full border-2 border-[var(--border-strong)] border-t-transparent animate-spin" aria-hidden />
              Recognizing…
            </p>
          )}
          {state.step === 'not-food' && (
            <Notice>
              That doesn't look like food. <LinkButton onClick={pickAnother}>Try another photo</LinkButton> or{' '}
              <LinkButton onClick={() => setMode('type')}>type it in</LinkButton>.
            </Notice>
          )}
          {state.step === 'error' && (
            <Notice>
              {state.message} <LinkButton onClick={pickAnother}>Try again</LinkButton> or{' '}
              <LinkButton onClick={() => setMode('type')}>type it in</LinkButton>.
            </Notice>
          )}
          {state.step === 'result' && (
            <p className="text-xs text-[var(--text-muted)]">
              {state.ai.confidence === 'low' ? 'The AI isn\'t sure — please check. ' : ''}
              Check the details, then add. <LinkButton onClick={pickAnother}>Use another photo</LinkButton>
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm text-[var(--text-muted)] mb-3">
            Logged for today, without a photo; calories = weight × kcal per 100 g (from the food label, for example).
          </p>
          <p className="text-xs text-[var(--text-secondary)] bg-[var(--bg-inset)] rounded-lg px-3 py-2 mb-4 leading-relaxed">
            ⚖️ Have a Stack-chan scale? Put food on it and it's logged automatically, with a photo and the measured
            weight.{' '}
            <Link to="/device" onClick={() => setOpen(false)} className="font-semibold underline" style={{ color: 'var(--primary-text)' }}>
              Pair it on the Device page →
            </Link>
          </p>
        </>
      )}

      {showForm ? (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Food
            <input type="text" maxLength={80} placeholder="e.g. Toast" value={name} autoFocus={mode === 'type'} required
              onChange={(e) => setName(e.target.value)} className={inputClass} />
          </label>
          <div className="flex gap-3">
            <label className="flex-1 flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
              Weight (g)
              <input type="number" min={1} max={5000} step="0.1" placeholder="e.g. 60" value={grams} required
                onChange={(e) => setGrams(e.target.value)} className={inputClass} />
              {mode === 'photo' && state.step === 'result' && state.ai.estimatedGrams !== null && (
                <span className="text-xs text-amber-600">AI estimate — adjust</span>
              )}
            </label>
            <label className="flex-1 flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
              kcal / 100 g
              <input type="number" min={0} max={900} step="0.1" placeholder="e.g. 265" value={density} required
                onChange={(e) => setDensity(e.target.value)} className={inputClass} />
            </label>
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            Total: <span className="font-semibold tabular-nums">{grams && density && Number.isFinite(total) ? total.toLocaleString() : '–'} kcal</span>
          </p>
          <div className="flex gap-3">
            <button type="button" onClick={() => setOpen(false)} className={secondaryBtn}>Cancel</button>
            <button type="submit" disabled={saving} className={primaryBtn} style={{ backgroundColor: INTAKE_COLOR }}>
              {saving ? 'Saving…' : 'Add'}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex">
          <button type="button" onClick={() => setOpen(false)} className={secondaryBtn}>Cancel</button>
        </div>
      )}
    </Modal>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[var(--text-secondary)] bg-[var(--bg-inset)] rounded-lg px-3 py-2" role="alert">{children}</p>
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="font-semibold underline cursor-pointer" style={{ color: 'var(--primary-text)' }}>
      {children}
    </button>
  )
}
