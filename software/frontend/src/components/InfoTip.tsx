// A small "?" that explains a term on hover (or keyboard focus / tap).
// align: which way the bubble opens, so it stays on screen near an edge.
export default function InfoTip({
  label,
  children,
  align = 'center',
}: {
  label: string
  children: React.ReactNode
  align?: 'center' | 'left' | 'right'
}) {
  const pos = align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
  return (
    <span className="relative inline-flex group align-middle">
      <button
        type="button"
        aria-label={label}
        className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold leading-none cursor-help bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
      >
        ?
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full mt-2 ${pos} z-30 w-64 max-w-[80vw] rounded-lg bg-gray-800 text-white text-xs font-normal normal-case tracking-normal leading-relaxed px-3 py-2 shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-opacity`}
      >
        {children}
      </span>
    </span>
  )
}
