/** 未实现区域的诚实占位:明确标注「建设中」与交付工单 */
export function PlaceholderPage({ title, note }: { title: string; note: string }) {
  return (
    <div className="page">
      <div className="placeholder-card">
        <p className="placeholder-title">{title}</p>
        <p className="placeholder-note">建设中 · {note}</p>
      </div>
    </div>
  )
}
