/**
 * Per-call OpenAI Realtime cost, summed from each response.done usage block. Logged as an
 * `openai.callUsage` event beside Gemini's `gemini.callUsage` so the two lines can be compared.
 * OpenAI caches repeated prompt/history automatically; cached tokens bill at the cached rate.
 */
type Rates = { text: number; cachedText: number; audio: number; cachedAudio: number; textOut: number; audioOut: number };

// USD per 1M tokens (developers.openai.com/api/docs/pricing, 2026-10-28).
const MINI: Rates = { text: 0.6, cachedText: 0.06, audio: 10, cachedAudio: 0.3, textOut: 2.4, audioOut: 20 };
const FULL: Rates = { text: 4, cachedText: 0.4, audio: 32, cachedAudio: 0.4, textOut: 16, audioOut: 64 };
const FULL_2: Rates = { ...FULL, textOut: 24 };

export function openAiRealtimeRates(model: string): Rates {
  if (/mini/i.test(model)) return MINI;
  if (/gpt-realtime-2/i.test(model)) return FULL_2;
  return FULL;
}

export type OpenAiCallUsage = {
  responses: number;
  input: { TEXT: number; AUDIO: number };
  cached: { TEXT: number; AUDIO: number };
  output: { TEXT: number; AUDIO: number };
};

export function newOpenAiCallUsage(): OpenAiCallUsage {
  return { responses: 0, input: { TEXT: 0, AUDIO: 0 }, cached: { TEXT: 0, AUDIO: 0 }, output: { TEXT: 0, AUDIO: 0 } };
}

const count = (value: unknown) => Math.max(0, Math.trunc(Number(value) || 0));

export function addOpenAiUsage(usage: OpenAiCallUsage, raw: unknown) {
  if (!raw || typeof raw !== "object") return;
  const row = raw as Record<string, any>,
    input = row.input_token_details || {},
    cached = input.cached_tokens_details || {},
    output = row.output_token_details || {};
  usage.responses += 1;
  usage.input.TEXT += count(input.text_tokens);
  usage.input.AUDIO += count(input.audio_tokens);
  usage.cached.TEXT += count(cached.text_tokens);
  usage.cached.AUDIO += count(cached.audio_tokens);
  usage.output.TEXT += count(output.text_tokens);
  usage.output.AUDIO += count(output.audio_tokens);
}

/** input counts include cached tokens; only the uncached remainder bills at the full input rate. */
export function openAiUsageSummary(usage: OpenAiCallUsage, model: string) {
  const rates = openAiRealtimeRates(model),
    freshText = Math.max(0, usage.input.TEXT - usage.cached.TEXT),
    freshAudio = Math.max(0, usage.input.AUDIO - usage.cached.AUDIO),
    cost =
      (freshText * rates.text +
        usage.cached.TEXT * rates.cachedText +
        freshAudio * rates.audio +
        usage.cached.AUDIO * rates.cachedAudio +
        usage.output.TEXT * rates.textOut +
        usage.output.AUDIO * rates.audioOut) /
      1_000_000;
  return {
    model,
    responses: usage.responses,
    input: usage.input,
    cached: usage.cached,
    output: usage.output,
    // Input transcription (gpt-transcribe) is billed separately per minute and is not included.
    estimatedCostUsd: Math.round(cost * 10_000) / 10_000,
  };
}
