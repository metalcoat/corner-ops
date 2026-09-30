"use client";

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

export default function MessageReactions({
  counts, mine, onSelect, disabled,
}: {
  counts: MessageReactionCount[];
  mine?: MessageReactionKey | null;
  onSelect?: (reaction: MessageReactionKey) => void;
  disabled?: boolean;
}) {
  if (!onSelect && !counts.length) return null;
  return <div className="messageReactions" aria-label="Message reactions">
    {MESSAGE_REACTION_OPTIONS.map((option) => {
      const count = counts.find((item) => item.key === option.key)?.count || 0;
      if (!onSelect && !count) return null;
      return <button
        key={option.key}
        type="button"
        className={mine === option.key ? "selected" : ""}
        aria-label={`${option.label}: ${count} reaction${count === 1 ? "" : "s"}`}
        aria-pressed={onSelect ? mine === option.key : undefined}
        title={option.label}
        disabled={!onSelect || disabled}
        onClick={() => onSelect?.(option.key)}
      ><span aria-hidden="true">{option.key === "eggplant_mouth" ? <PenisIcon /> : option.emoji}</span>{count > 0 && <span>{count}</span>}</button>;
    })}
  </div>;
}
