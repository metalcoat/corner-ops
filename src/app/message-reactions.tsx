"use client";

import { MESSAGE_REACTION_OPTIONS, type MessageReactionCount, type MessageReactionKey } from "@/lib/message-reaction-options";

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
      ><span aria-hidden="true">{option.emoji}</span>{count > 0 && <span>{count}</span>}</button>;
    })}
  </div>;
}
