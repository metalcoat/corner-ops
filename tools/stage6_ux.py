from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(p): return (ROOT/p).read_text()
def write(p,t): (ROOT/p).write_text(t)
def rep(p,o,n):
    t=read(p); c=t.count(o)
    if c!=1: raise RuntimeError(f'{p}: expected one match, got {c}: {o[:100]!r}')
    write(p,t.replace(o,n,1))

# CO-078: restore saved business theme before first paint, not after hydration.
rep('src/app/layout.tsx','import "./pwa.css";\n','import "./pwa.css";\n\nconst THEME_BOOTSTRAP = `try{var b=localStorage.getItem("corner-ops-business-theme");if(b==="Corner Deli"||b==="Tiki")document.documentElement.dataset.businessTheme=b}catch(e){}`;\n')
rep('src/app/layout.tsx','    <html lang="en" data-business-theme="Corner Deli">\n      <body>','    <html lang="en" data-business-theme="Corner Deli" suppressHydrationWarning>\n      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} /></head>\n      <body>')

# CO-073: shared modal focus trap / Escape / focus restoration.
rep('src/app/ops/workforce/schedule-board.tsx','import type { Business } from "@/lib/types";\n','import type { Business } from "@/lib/types";\nimport { useModalFocus } from "@/app/use-modal-focus";\n')
rep('src/app/ops/workforce/schedule-board.tsx','  const [dragTarget, setDragTarget] = useState<DragTarget>(null);\n','  const [dragTarget, setDragTarget] = useState<DragTarget>(null);\n  const scheduleModalRef = useModalFocus(Boolean(editor), () => setEditor(null));\n')
rep('src/app/ops/workforce/schedule-board.tsx','      <section className="scheduleModal" role="dialog" aria-modal="true" aria-labelledby="shift-editor-heading">','      <section ref={scheduleModalRef} tabIndex={-1} className="scheduleModal" role="dialog" aria-modal="true" aria-labelledby="shift-editor-heading">')

rep('src/app/ops/employees/employee-editor-overlay.tsx','import type { Business } from "@/lib/types";\n','import type { Business } from "@/lib/types";\nimport { useModalFocus } from "@/app/use-modal-focus";\n')
rep('src/app/ops/employees/employee-editor-overlay.tsx','  const businessRef = useRef<Business>(business);\n','  const businessRef = useRef<Business>(business);\n  const employeeModalRef = useModalFocus(Boolean(selected), () => { if (!busy) setSelected(null); });\n')
rep('src/app/ops/employees/employee-editor-overlay.tsx','      <section className="employeeEditorModal" role="dialog" aria-modal="true" aria-labelledby="employee-editor-title">','      <section ref={employeeModalRef} tabIndex={-1} className="employeeEditorModal" role="dialog" aria-modal="true" aria-labelledby="employee-editor-title">')

rep('src/app/employee/install-prompt.tsx','import { useEffect, useState } from "react";\n','import { useEffect, useState } from "react";\nimport { useModalFocus } from "@/app/use-modal-focus";\n')
rep('src/app/employee/install-prompt.tsx','  const [notice, setNotice] = useState("");\n','  const [notice, setNotice] = useState("");\n  const installModalRef = useModalFocus(visible, () => dismiss());\n')
rep('src/app/employee/install-prompt.tsx','  return <div className="employeeInstallOverlay" role="dialog" aria-modal="true" aria-labelledby="employee-install-title">\n    <section className="employeeInstallCard">','  return <div ref={installModalRef} tabIndex={-1} className="employeeInstallOverlay" role="dialog" aria-modal="true" aria-labelledby="employee-install-title">\n    <section className="employeeInstallCard">')

# CO-081: exactly the five unnamed inline controls documented by the review.
rep('src/app/deli-board/page.tsx','<form className="quickTask" onSubmit={addTask}><input name="title" placeholder="Add quick task…" autoComplete="off" />','<form className="quickTask" onSubmit={addTask}><input aria-label="Quick task title" name="title" placeholder="Add quick task…" autoComplete="off" />')
rep('src/app/page.tsx','<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, category, filename, or notes" />','<input aria-label="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, category, filename, or notes" />')
rep('src/app/page.tsx','<select value={status} onChange={(event) => setStatus(event.target.value as "All" | DocumentStatus)}>','<select aria-label="Filter documents by status" value={status} onChange={(event) => setStatus(event.target.value as "All" | DocumentStatus)}>')
rep('src/app/ops/finance-operations/page.tsx','<div className="foBillLine" key={index}><select value={line.inventoryItemId}','<div className="foBillLine" key={index}><select aria-label="Inventory item" value={line.inventoryItemId}')
rep('src/app/ops/finance-operations/page.tsx','</select><input placeholder="Description" value={line.description}','</select><input aria-label="Line description" placeholder="Description" value={line.description}')

# CO-070: remove all remaining client-side personal email -> name mappings.
needle='if (text.toLowerCase() === "crfrary@gmail.com") return "Chris";\n'
for path in ROOT.joinpath('src').rglob('*'):
    if path.suffix not in {'.ts','.tsx'}: continue
    text=path.read_text()
    if needle in text: path.write_text(text.replace(needle,''))
remaining=[]
for path in ROOT.joinpath('src').rglob('*'):
    if path.suffix in {'.ts','.tsx'} and 'crfrary@gmail.com' in path.read_text(): remaining.append(str(path.relative_to(ROOT)))
if remaining: raise RuntimeError(f'hard-coded owner email remains in source: {remaining}')

# CO-038: stale cancellation must also carry the version token.
rep('src/app/ops/workforce/schedule-board.tsx','runAction({ action: "shift-update", id: editor.shift?.id, status: "Cancelled" }, "Shift cancelled.")','runAction({ action: "shift-update", id: editor.shift?.id, status: "Cancelled", expectedUpdatedAt: editor.shift?.updatedAt || null }, "Shift cancelled.")')

print('Stage 6 UX/accessibility transformations applied')
