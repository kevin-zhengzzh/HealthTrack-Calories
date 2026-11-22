import { useEffect, useRef, useState } from 'react'
import { getTodayRewards, recordWorkout } from '../api'
import { INTAKE_COLOR } from '../goals'
import { useStore } from '../store'
import { WORKOUT_TYPES } from '../types'
import { useLockBodyScroll } from '../hooks/useLockBodyScroll'
import { inputClass, primaryBtn, secondaryBtn } from '../historyFormat'
import { Modal } from './HistoryParts'
import { useMediaQuery } from '../hooks/useMediaQuery'
import MealModal from './MealModal'

// Floating + button on the Dashboard, Statistics, Plan, History and Device
// pages. Two buttons fan out to its left — add a meal (typed in, without the
// scale) or record a workout: on hover with a mouse, on tap on touch screens. The two dialogs' open state lives in the store, so the
// dashboard cards' "+ Add meal" / "+ Record workout" open the same ones.
// Saving bumps intakeRefreshKey / workoutRefreshKey so pages refetch.
export default function RecordButton() {
  const [menuOpen, setMenuOpen] = useState(false)
  const setRecordModalOpen = useStore((s) => s.setRecordModalOpen)
  const setMealModalOpen = useStore((s) => s.setMealModalOpen)
  const ref = useRef<HTMLDivElement>(null)
  // Mouse users get the menu on hover; leaving closes it after a moment, so
  // crossing the small gap between the buttons doesn't flicker it shut
  const canHover = useMediaQuery('(hover: hover) and (pointer: fine)')
  const closeTimer = useRef<number | undefined>(undefined)
  const hoverOpen = () => {
    if (!canHover) return
    window.clearTimeout(closeTimer.current)
    setMenuOpen(true)
  }
  const hoverClose = () => {
    if (!canHover) return
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), 250)
  }
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

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
      {/* Row, right to left: the + itself, then Add meal, then Record workout */}
      <div ref={ref} onMouseEnter={hoverOpen} onMouseLeave={hoverClose}
        className="fixed bottom-6 right-4 z-30 flex flex-row-reverse items-center gap-2">
        <button
          type="button"
          // With a mouse the menu opens on hover; a click then shouldn't shut it
          onClick={() => setMenuOpen((o) => (canHover ? true : !o))}
          aria-label={menuOpen ? 'Close menu' : 'Add a meal or workout'}
          aria-expanded={menuOpen}
          title="Add a meal or workout"
          className="h-12 w-12 flex items-center justify-center text-white rounded-full shadow-lg transition-all duration-200 active:scale-95 cursor-pointer"
          style={{ backgroundColor: 'var(--primary)' }}
        >
          <span className={`text-2xl leading-none font-bold transition-transform duration-200 ${menuOpen ? 'rotate-45' : ''}`}>+</span>
        </button>
        {menuOpen && items.map((it, i) => (
          <button
            key={it.label}
            type="button"
            onClick={() => { setMenuOpen(false); it.open() }}
            className="flex items-center gap-2 pl-2 pr-4 py-2 rounded-full shadow-lg bg-[var(--bg-surface)] text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-inset)] cursor-pointer whitespace-nowrap animate-[fadeLeft_160ms_ease-out_backwards]"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <span className="w-7 h-7 rounded-full flex items-center justify-center text-sm" style={{ backgroundColor: it.color }} aria-hidden>{it.icon}</span>
            {it.label}
          </button>
        ))}
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
