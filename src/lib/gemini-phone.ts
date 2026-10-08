export const DEFAULT_GEMINI_PHONE_MODEL = "gemini-3.1-flash-live-preview";

const apiRoot = "https://generativelanguage.googleapis.com/v1beta";

export function geminiPhoneReadiness(model = DEFAULT_GEMINI_PHONE_MODEL) {
  const configured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const liveBridgeReady = process.env.GEMINI_PHONE_BRIDGE_ENABLED === "true";
  return {
    configured,
    ready: configured && liveBridgeReady,
    liveBridgeReady,
    model,
  };
}

export async function testGeminiPhoneConnection(
  model = DEFAULT_GEMINI_PHONE_MODEL,
) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("Gemini API key is not configured.");
  const response = await fetch(`${apiRoot}/models?pageSize=100`, {
    headers: { "x-goog-api-key": apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Gemini rejected the connection (${response.status}).`);
  const body = (await response.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  const expected = `models/${model.replace(/^models\//, "")}`;
  const selected = (body.models || []).find((entry) => entry.name === expected);
  if (!selected)
    throw new Error(`Gemini model ${model} is not available to this API key.`);
  return {
    connected: true,
    model: expected.replace(/^models\//, ""),
    methods: selected.supportedGenerationMethods || [],
  };
}
