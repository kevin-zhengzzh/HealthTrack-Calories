import { useState } from 'react'
import { MAX_INTAKE_GOAL } from '../intake'
import { useLockBodyScroll } from '../hooks/useLockBodyScroll'

// Sets the daily intake goal. It applies from today on, and stays the same on
// later days until it's changed again.
export default function IntakeGoalDialog({
  goal,
  onSave,
  onClose,
}: {
  goal: number | null
  onSave: (goal: number | null) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState(goal ? String(goal) : '2000')
  const [saving, setSaving] = useState(false)
  useLockBodyScroll(true)

  async function save(value: number | null) {
    setSaving(true)
    try {
      await onSave(value)
      onClose()
    } catch {
      // the toast already says why
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const value = Number(draft)
    if (!draft || !Number.isInteger(value) || value < 1 || value > MAX_INTAKE_GOAL) return
    save(value)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[var(--bg-surface)] rounded-2xl shadow-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-bold text-[var(--text-primary)] mb-1">Daily intake goal</h2>
        <p className="text-sm text-[var(--text-muted)] mb-4">Starts today and carries over to the following days until you change it.</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Goal (kcal per day)
            <input
              type="number"
              min={1}
              max={MAX_INTAKE_GOAL}
              step={1}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (['e', 'E', '+', '-', '.'].includes(e.key)) e.preventDefault() }}
              required
              className="border border-[var(--border-strong)] rounded-lg px-4 py-2 text-sm bg-[var(--bg-surface)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </label>
          <div className="flex gap-3 mt-2">
            {goal !== null && (
              <button
                type="button"
                disabled={saving}
                onClick={() => save(null)}
                className="border border-[var(--border-strong)] text-[var(--text-secondary)] rounded-lg py-2 px-3 font-semibold hover:bg-[var(--bg-inset)] transition cursor-pointer disabled:opacity-60"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-[var(--border-strong)] text-[var(--text-secondary)] rounded-lg py-2 font-semibold hover:bg-[var(--bg-inset)] transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 text-white rounded-lg py-2 font-semibold transition disabled:opacity-60 cursor-pointer"
              style={{ backgroundColor: 'var(--primary)' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
