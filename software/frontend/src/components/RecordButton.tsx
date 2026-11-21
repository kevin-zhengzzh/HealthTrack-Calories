import { useEffect, useRef, useState } from 'react'
import { addIntake, getTodayRewards, recordWorkout } from '../api'
import { INTAKE_COLOR } from '../goals'
import { useStore } from '../store'
import { WORKOUT_TYPES } from '../types'
import { useLockBodyScroll } from '../hooks/useLockBodyScroll'
import { inputClass, primaryBtn, secondaryBtn } from '../historyFormat'
import { Modal } from './HistoryParts'

// Floating + button on the Dashboard, Statistics, Plan, History and Device
// pages. It opens a small menu: add a meal (typed in, without the scale) or
// record a workout. The two dialogs' open state lives in the store, so the
// dashboard cards' "+ Add meal" / "+ Record workout" open the same ones.
// Saving bumps intakeRefreshKey / workoutRefreshKey so pages refetch.
export default function RecordButton() {
  const [menuOpen, setMenuOpen] = useState(false)
  const setRecordModalOpen = useStore((s) => s.setRecordModalOpen)
  const setMealModalOpen = useStore((s) => s.setMealModalOpen)
  const ref = useRef<HTMLDivElement>(null)

  // Close the menu on a click elsewhere or Esc
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setMenuOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const items = [
    { label: 'Add meal', icon: '🍽️', color: INTAKE_COLOR, open: () => setMealModalOpen(true) },
    { label: 'Record workout', icon: '🏃', color: 'var(--primary)', open: () => setRecordModalOpen(true) },
  ]

  return (
    <>
      <div ref={ref} className="fixed bottom-6 right-4 z-30 flex flex-col items-end gap-2">
        {menuOpen && items.map((it) => (
          <button
            key={it.label}
            type="button"
            onClick={() => { setMenuOpen(false); it.open() }}
            className="flex items-center gap-2 pl-3 pr-4 py-2 rounded-full shadow-lg bg-[var(--bg-surface)] text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-inset)] cursor-pointer animate-[fadeUp_150ms_ease-out]"
          >
            <span className="w-7 h-7 rounded-full flex items-center justify-center text-sm" style={{ backgroundColor: it.color }} aria-hidden>{it.icon}</span>
            {it.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label={menuOpen ? 'Close menu' : 'Add a meal or workout'}
          aria-expanded={menuOpen}
          title="Add a meal or workout"
          className="h-12 w-12 flex items-center justify-center text-white rounded-full shadow-lg transition-all duration-200 active:scale-95 cursor-pointer"
          style={{ backgroundColor: 'var(--primary)' }}
        >
          <span className={`text-2xl leading-none font-bold transition-transform duration-200 ${menuOpen ? 'rotate-45' : ''}`}>+</span>
        </button>
      </div>

      <WorkoutModal />
      <MealModal />
    </>
  )
}

function WorkoutModal() {
  const { pushToast, setRewardStatus, bumpWorkoutRefresh } = useStore()
  const open = useStore((s) => s.recordModalOpen)
  const setOpen = useStore((s) => s.setRecordModalOpen)
  const [workoutType, setWorkoutType] = useState<string>(WORKOUT_TYPES[0])
  const [calories, setCalories] = useState('')
  const [saving, setSaving] = useState(false)
  useLockBodyScroll(open)

  // Fresh form every time it opens, whoever opened it
  useEffect(() => {
    if (!open) return
    setWorkoutType(WORKOUT_TYPES[0])
    setCalories('')
  }, [open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const caloriesNum = Number(calories)
    if (!calories || !Number.isInteger(caloriesNum) || caloriesNum <= 0 || caloriesNum > 10000)
      return pushToast('Enter a valid calorie amount (1–10000).')
    setSaving(true)
    try {
      const result = await recordWorkout(workoutType, caloriesNum)
      getTodayRewards().then(setRewardStatus).catch(console.error)
      bumpWorkoutRefresh()
      pushToast(
        result.pointsEarned > 0
          ? `Workout recorded! Claim your +${result.pointsEarned} pts in Daily Tasks.`
          : "Workout saved! (You've already recorded a workout today.)",
        'success'
      )
      setOpen(false)
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to save workout')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null
  return (
    <Modal onClose={() => setOpen(false)}>
      <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">Record workout</h2>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
          Workout type
          <select value={workoutType} onChange={(e) => setWorkoutType(e.target.value)} className={inputClass}>
            {WORKOUT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
          Calories burned
          <input type="number" min={1} max={10000} step={1} placeholder="e.g. 300" value={calories} required
            onChange={(e) => setCalories(e.target.value)}
            onKeyDown={(e) => { if (['e', 'E', '+', '-', '.'].includes(e.key)) e.preventDefault() }}
            className={inputClass} />
        </label>
        <div className="flex gap-3 mt-2">
          <button type="button" onClick={() => setOpen(false)} className={secondaryBtn}>Cancel</button>
          <button type="submit" disabled={saving} className={primaryBtn} style={{ backgroundColor: 'var(--primary)' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// A meal typed in without the scale: name, grams and kcal per 100 g (as on
// a food label); the total is grams × kcal/100 g, worked out by the server
function MealModal() {
  const { pushToast, bumpIntakeRefresh } = useStore()
  const open = useStore((s) => s.mealModalOpen)
  const setOpen = useStore((s) => s.setMealModalOpen)
  const [name, setName] = useState('')
  const [grams, setGrams] = useState('')
  const [density, setDensity] = useState('')
  const [saving, setSaving] = useState(false)
  useLockBodyScroll(open)

  useEffect(() => {
    if (!open) return
    setName('')
    setGrams('')
    setDensity('')
  }, [open])

  const total = Math.round((Number(grams) * Number(density)) / 100)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const g = Number(grams)
    const d = Number(density)
    if (!name.trim()) return pushToast('Enter a food name.')
    if (!(g >= 1 && g <= 5000)) return pushToast('Weight must be 1–5000 g.')
    if (!(d >= 0 && d <= 900)) return pushToast('Calories per 100 g must be 0–900.')
    setSaving(true)
    try {
      const r = await addIntake(name.trim(), g, d)
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
      <h2 className="text-xl font-bold text-[var(--text-primary)] mb-1">Add meal</h2>
      <p className="text-sm text-[var(--text-muted)] mb-4">For food you didn't weigh on the scale. It's logged for today.</p>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
          Food
          <input type="text" maxLength={80} placeholder="e.g. Toast" value={name} autoFocus required
            onChange={(e) => setName(e.target.value)} className={inputClass} />
        </label>
        <div className="flex gap-3">
          <label className="flex-1 flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Weight (g)
            <input type="number" min={1} max={5000} step="0.1" placeholder="e.g. 60" value={grams} required
              onChange={(e) => setGrams(e.target.value)} className={inputClass} />
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
    </Modal>
  )
}
