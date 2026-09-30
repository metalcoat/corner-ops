export const MESSAGE_REACTION_OPTIONS = [
  { key: "thumbs_up", emoji: "👍", label: "Thumbs up" },
  { key: "thumbs_down", emoji: "👎", label: "Thumbs down" },
  { key: "heart", emoji: "❤️", label: "Heart" },
  { key: "laugh", emoji: "😂", label: "Laugh" },
  { key: "eggplant_mouth", emoji: "🍆👄", label: "Penis in mouth" },
] as const;

export type MessageReactionKey = typeof MESSAGE_REACTION_OPTIONS[number]["key"];
export type MessageReactionCount = { key: MessageReactionKey; count: number };

export function isMessageReactionKey(value: unknown): value is MessageReactionKey {
  return MESSAGE_REACTION_OPTIONS.some((option) => option.key === value);
}
