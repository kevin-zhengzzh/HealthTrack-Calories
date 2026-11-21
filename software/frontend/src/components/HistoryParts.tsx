import { inputClass } from '../historyFormat'

// Building blocks shared by the History tabs, so Food Log, Workouts and
// Check-ins look the same: a card per day (or month) with a title and a
// total, rows with a square tile, a name, a grey detail line, a figure on the
// right and icon buttons.

export function GroupCard({ title, total, children }: { title: string; total: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-[var(--bg-surface)] rounded-2xl shadow p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
        <span className="text-sm font-semibold tabular-nums text-[var(--text-secondary)]">{total}</span>
      </div>
      <ul className="flex flex-col divide-y divide-[var(--border)]">{children}</ul>
    </section>
  )
}

export function Row({
  tile,
  name,
  badge,
  detail,
  figure,
  actions,
}: {
  tile: React.ReactNode
  name: React.ReactNode
  badge?: React.ReactNode
  detail?: React.ReactNode
  figure?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <li className="flex items-center gap-3 py-3">
      {tile}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium truncate text-[var(--text-primary)]">{name}</span>
          {badge}
        </div>
        {detail && <p className="text-xs text-[var(--text-muted)] tabular-nums mt-0.5">{detail}</p>}
      </div>
      {figure !== undefined && <span className="font-semibold tabular-nums text-[var(--text-primary)] whitespace-nowrap">{figure}</span>}
      {actions && <div className="flex gap-1">{actions}</div>}
    </li>
  )
}

// A square tile with an emoji or symbol, the same size as a meal photo
export function Tile({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <div
      className="w-16 h-16 rounded-lg shrink-0 flex items-center justify-center text-2xl"
      style={{ backgroundColor: color ?? 'var(--bg-inset)' }}
      aria-hidden
    >
      {children}
    </div>
  )
}

export function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Edit" title="Edit"
      className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-inset)] cursor-pointer">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  )
}

export function DeleteButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label="Delete" title="Delete"
      className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-inset)] hover:text-red-500 cursor-pointer disabled:opacity-60">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
        <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      </svg>
    </button>
  )
}

export function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[var(--bg-surface)] rounded-2xl shadow-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className={`${inputClass} w-full`} />
  )
}

export function EmptyCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--bg-surface)] rounded-2xl shadow p-6 text-[var(--text-secondary)] text-sm leading-relaxed">
      <p className="font-semibold text-[var(--text-primary)] mb-1">{title}</p>
      {children}
    </div>
  )
}

export function LoadingCard() {
  return (
    <div className="bg-[var(--bg-surface)] rounded-2xl shadow p-5 flex flex-col gap-3" aria-label="Loading">
      <div className="h-5 w-28 rounded bg-[var(--bg-inset)] animate-pulse" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 py-1">
          <div className="w-16 h-16 rounded-lg bg-[var(--bg-inset)] animate-pulse shrink-0" />
          <div className="h-4 w-40 rounded bg-[var(--bg-inset)] animate-pulse" />
        </div>
      ))}
    </div>
  )
}

// "Show older days" under the list, while there are more groups
export function ShowMore({ shown, total, onMore, noun }: { shown: number; total: number; onMore: () => void; noun: string }) {
  if (shown >= total) return null
  return (
    <button type="button" onClick={onMore}
      className="self-center text-sm font-medium px-4 py-2 rounded-lg hover:bg-[var(--bg-inset)] cursor-pointer"
      style={{ color: 'var(--primary)' }}>
      Show older {noun} ({total - shown} more)
    </button>
  )
}
