"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MESSAGE_REACTION_OPTIONS, type MessageReactionCount, type MessageReactionKey } from "@/lib/message-reaction-options";

function PenisIcon() {
  return <svg className="messagePenisIcon" viewBox="0 0 32 32" width="23" height="23" aria-hidden="true">
    <ellipse cx="10.5" cy="24" rx="5.5" ry="5" fill="#e9a39f" stroke="#9f5c67" strokeWidth="1.4" />
    <ellipse cx="21.5" cy="24" rx="5.5" ry="5" fill="#e9a39f" stroke="#9f5c67" strokeWidth="1.4" />
    <rect x="11.5" y="7" width="9" height="18" rx="4.5" fill="#f0aaa6" stroke="#9f5c67" strokeWidth="1.4" />
    <path d="M11.6 11.5c1.3 2.1 7.5 2.1 8.8 0" fill="none" stroke="#b96b72" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="16" cy="7.9" r=".75" fill="#9f5c67" />
  </svg>;
}

function ReactionIcon({ reaction }: { reaction: MessageReactionKey }) {
  const option = MESSAGE_REACTION_OPTIONS.find((item) => item.key === reaction);
  return <span aria-hidden="true">{reaction === "eggplant_mouth" ? <PenisIcon /> : option?.emoji}</span>;
}

export default function MessageReactions({
  counts, mine, onSelect, disabled,
}: {
  counts: MessageReactionCount[];
  mine?: MessageReactionKey | null;
  onSelect?: (reaction: MessageReactionKey) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!onSelect && !counts.length) return null;

  return <div ref={rootRef} className="messageReactions" aria-label="Message reactions">
    {onSelect && <button
      type="button"
      className="messageReactionTrigger"
      aria-label="React to message"
      aria-expanded={open}
      aria-controls={menuId}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
    ><span aria-hidden="true">☺</span> React <span aria-hidden="true">▾</span></button>}
    {counts.map((count) => <span
      key={count.key}
      className={`messageReactionCount${mine === count.key ? " selected" : ""}`}
      aria-label={`${MESSAGE_REACTION_OPTIONS.find((item) => item.key === count.key)?.label}: ${count.count} reaction${count.count === 1 ? "" : "s"}`}
    ><ReactionIcon reaction={count.key} /><span aria-hidden="true">{count.count}</span></span>)}
    {onSelect && open && <div id={menuId} className="messageReactionMenu" role="group" aria-label="Choose a reaction">
      {MESSAGE_REACTION_OPTIONS.map((option) => <button
        key={option.key}
        type="button"
        className={mine === option.key ? "selected" : ""}
        aria-label={option.label}
        aria-pressed={mine === option.key}
        disabled={disabled}
        onClick={() => { onSelect(option.key); setOpen(false); }}
      ><ReactionIcon reaction={option.key} /><span>{option.label}</span></button>)}
    </div>}
  </div>;
}
