export type RezkuReceivedEmail = {
  id: string;
  createdAt?: string | null;
};

export type RezkuTrackedEmail = {
  emailId: string;
  status: string;
  updatedAt?: string | null;
};

export function rezkuRecoveryCandidates(input: {
  received: RezkuReceivedEmail[];
  tracked: RezkuTrackedEmail[];
  now?: number;
  processingStaleMs?: number;
  maxEmails?: number;
}): RezkuReceivedEmail[] {
  const now = input.now ?? Date.now();
  const processingStaleMs = input.processingStaleMs ?? 15 * 60_000;
  const maximum = Math.max(0, Math.floor(input.maxEmails ?? input.received.length));
  const tracked = new Map(input.tracked.map((row) => [row.emailId, row]));

  return [...input.received]
    .filter((email) => {
      const state = tracked.get(email.id);
      if (!state) return true;
      if (state.status === "Processed") return false;
      if (state.status !== "Processing") return true;
      const updatedAt = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
      return !updatedAt || now - updatedAt >= processingStaleMs;
    })
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
    .slice(0, maximum);
}
