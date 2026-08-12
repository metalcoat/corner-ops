from pathlib import Path

path = Path('src/app/employee/messages-dock.tsx')
text = path.read_text()

text = text.replace(
    'import { CSSProperties, FormEvent, useCallback, useEffect, useRef, useState } from "react";',
    'import { ChangeEvent, CSSProperties, FormEvent, useCallback, useEffect, useRef, useState } from "react";'
)

old = '''  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const reportedSeen = useRef(new Set<string>());'''
new = '''  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<{ url: string; name: string; size: number } | null>(null);
  const reportedSeen = useRef(new Set<string>());'''
if old not in text:
    raise SystemExit('state insertion point not found')
text = text.replace(old, new, 1)

old = '''  const expandedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const loadedLatestIdRef = useRef<string | null>(null);
'''
new = '''  const expandedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const loadedLatestIdRef = useRef<string | null>(null);
  const cameraPhotoRef = useRef<HTMLInputElement | null>(null);
  const libraryPhotoRef = useRef<HTMLInputElement | null>(null);
  const photoPreviewUrlRef = useRef<string | null>(null);

  const clearPhotoAttachment = useCallback((resetInputs = true) => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    photoPreviewUrlRef.current = null;
    setPhotoPreview(null);
    if (resetInputs) {
      if (cameraPhotoRef.current) cameraPhotoRef.current.value = "";
      if (libraryPhotoRef.current) libraryPhotoRef.current.value = "";
    }
  }, []);

  function choosePhoto(event: ChangeEvent<HTMLInputElement>, source: "camera" | "library") {
    const file = event.currentTarget.files?.[0] || null;
    if (!file) return;
    if (source === "camera" && libraryPhotoRef.current) libraryPhotoRef.current.value = "";
    if (source === "library" && cameraPhotoRef.current) cameraPhotoRef.current.value = "";
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    const url = URL.createObjectURL(file);
    photoPreviewUrlRef.current = url;
    setPhotoPreview({ url, name: file.name || "Photo", size: file.size });
    setNotice("");
  }
'''
if old not in text:
    raise SystemExit('ref insertion point not found')
text = text.replace(old, new, 1)

old = '''  useEffect(() => {
    void checkSession().catch((error) => setNotice(error instanceof Error ? error.message : "Messages could not be loaded."));'''
new = '''  useEffect(() => () => {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
  }, []);

  useEffect(() => {
    void checkSession().catch((error) => setNotice(error instanceof Error ? error.message : "Messages could not be loaded."));'''
if old not in text:
    raise SystemExit('cleanup effect insertion point not found')
text = text.replace(old, new, 1)

old = '''      formElement.reset();
      await loadMessages();
      await loadStatus();
      setNotice(photo ? "Photo message sent." : "Message sent.");'''
new = '''      formElement.reset();
      clearPhotoAttachment(false);
      await loadMessages();
      await loadStatus();
      setNotice(photo ? "Photo message sent." : "Message sent.");'''
if old not in text:
    raise SystemExit('send reset block not found')
text = text.replace(old, new, 1)

old = '''        <div className="employeeMessagesPhotoControls">
          <label className="employeeMessagesPhotoButton">Take photo<input name="cameraPhoto" type="file" accept="image/*" capture="environment" /></label>
          <label className="employeeMessagesPhotoButton secondary">Choose photo<input name="photo" type="file" accept="image/*" /></label>
        </div>
        <button className="employeeMessagesSend" disabled={busy}>Send message</button>'''
new = '''        <div className="employeeMessagesPhotoControls">
          <label className="employeeMessagesPhotoButton">Take photo<input ref={cameraPhotoRef} name="cameraPhoto" type="file" accept="image/*" capture="environment" onChange={(event) => choosePhoto(event, "camera")} /></label>
          <label className="employeeMessagesPhotoButton secondary">Choose photo<input ref={libraryPhotoRef} name="photo" type="file" accept="image/*" onChange={(event) => choosePhoto(event, "library")} /></label>
        </div>
        {photoPreview && <div className="employeeMessagesAttachmentPreview">
          <div className="employeeMessagesAttachmentThumb"><img src={photoPreview.url} alt="Selected attachment preview" /></div>
          <div className="employeeMessagesAttachmentInfo"><strong>Photo attached</strong><span>{photoPreview.name}</span><small>{(photoPreview.size / 1024 / 1024).toFixed(1)} MB before upload resizing</small></div>
          <button type="button" disabled={busy} onClick={() => clearPhotoAttachment()}>Remove photo</button>
        </div>}
        <button className="employeeMessagesSend" disabled={busy}>Send message</button>'''
if old not in text:
    raise SystemExit('photo controls block not found')
text = text.replace(old, new, 1)
path.write_text(text)

css = Path('src/app/employee/messages-dock.css')
text = css.read_text()
old = '.employeeMessagesPhotoButton input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}\n.employeeMessagesSend{border:0;border-radius:10px;background:#f8fafc;color:#111827;font-weight:900;padding:10px 12px;cursor:pointer}'
new = '''.employeeMessagesPhotoButton input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.employeeMessagesAttachmentPreview{display:grid;grid-template-columns:68px minmax(0,1fr) auto;align-items:center;gap:10px;border:1px solid #53657b;border-radius:11px;background:#111827;padding:8px}
.employeeMessagesAttachmentThumb{width:68px;height:68px;border-radius:9px;overflow:hidden;border:1px solid #475569;background:#020617;display:grid;place-items:center}
.employeeMessagesAttachmentThumb img{display:block;width:100%;height:100%;object-fit:cover}
.employeeMessagesAttachmentInfo{display:grid;gap:2px;min-width:0}
.employeeMessagesAttachmentInfo strong{font-size:.78rem;color:#f8fafc}
.employeeMessagesAttachmentInfo span{overflow:hidden;color:#d8e0eb;font-size:.72rem;text-overflow:ellipsis;white-space:nowrap}
.employeeMessagesAttachmentInfo small{color:#94a3b8;font-size:.64rem}
.employeeMessagesAttachmentPreview button{border:1px solid #7f1d1d;border-radius:9px;background:#2a1116;color:#fecaca;padding:8px 9px;font-size:.7rem;font-weight:900;cursor:pointer}
.employeeMessagesAttachmentPreview button:disabled{cursor:wait;opacity:.55}
.employeeMessagesSend{border:0;border-radius:10px;background:#f8fafc;color:#111827;font-weight:900;padding:10px 12px;cursor:pointer}'''
if old not in text:
    raise SystemExit('css insertion point not found')
text = text.replace(old, new, 1)

old = '''  .employeeMessagesPhotoControls{grid-template-columns:1fr 1fr}
  .employeeMessageMeta{grid-template-columns:auto minmax(0,1fr)}'''
new = '''  .employeeMessagesPhotoControls{grid-template-columns:1fr 1fr}
  .employeeMessagesAttachmentPreview{grid-template-columns:58px minmax(0,1fr);gap:8px}
  .employeeMessagesAttachmentThumb{width:58px;height:58px}
  .employeeMessagesAttachmentPreview button{grid-column:1/-1;width:100%}
  .employeeMessageMeta{grid-template-columns:auto minmax(0,1fr)}'''
if old not in text:
    raise SystemExit('mobile css insertion point not found')
text = text.replace(old, new, 1)
css.write_text(text)
