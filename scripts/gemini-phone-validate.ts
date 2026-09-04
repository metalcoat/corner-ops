#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { localValidationEnv } from "./validation-env";

async function main() {
  localValidationEnv();
  const key = process.env.GEMINI_API_KEY || "";
  assert.ok(key, "GEMINI_API_KEY is required for the live validation.");
  process.env.OPENAI_ORDERING_MCP_TOKEN = `gemini-validation-${randomUUID()}`;
  const { POST } = await import("../src/app/api/openai/ordering/mcp/route");
  const listed = await POST(
    new Request("http://localhost/api/openai/ordering/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_ORDERING_MCP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tools",
        method: "tools/list",
      }),
    }),
  );
  const listedBody = await listed.json();
  const geminiSchema = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(geminiSchema);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !["$schema", "additionalProperties"].includes(key))
        .map(([key, entry]) => [key, geminiSchema(entry)]),
    );
  };
  const declarations = (listedBody.result?.tools || []).map(
    (tool: { name: string; description?: string; inputSchema?: object }) => ({
      name: tool.name,
      description: tool.description || "",
      parameters: geminiSchema(tool.inputSchema || { type: "object" }),
    }),
  );
  assert.ok(declarations.length > 0, "Shared ordering tools were not listed.");
  const model = "gemini-3.1-flash-live-preview";
  const socket = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`,
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Gemini Live setup timed out.")),
      15_000,
    );
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: { responseModalities: ["AUDIO"] },
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                prefixPaddingMs: 40,
                silenceDurationMs: 350,
              },
              activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
            },
            inputAudioTranscription: {},
            tools: [{ functionDeclarations: declarations }],
          },
        }),
      );
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.setupComplete !== undefined) {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", (code, reason) => {
      if (code !== 1000) {
        clearTimeout(timer);
        reject(new Error(`Gemini Live closed ${code}: ${String(reason)}`));
      }
    });
  });
  socket.close();
  const dialplan = readFileSync("asterisk/extensions.conf.template", "utf8");
  const bridge = readFileSync("asterisk/gemini-phone.py", "utf8");
  const phonePrompt = readFileSync("src/lib/openai-phone-prompt.ts", "utf8");
  const { callerFromSipHeaders } = await import(
    "../src/lib/openai-phone-ordering"
  );
  assert.match(
    dialplan,
    /TryExec\(AudioSocket\(\$\{AI_CALL_ID\},127\.0\.0\.1:9092\)\)/,
  );
  assert.match(bridge, /functionDeclarations/);
  assert.match(bridge, /request_secure_voice_payment/);
  assert.match(bridge, /terminate_audiosocket/);
  assert.match(bridge, /writer\.write\(b"\\x00\\x00\\x00"\)/);
  assert.match(bridge, /await writer\.wait_closed\(\)/);
  assert.match(bridge, /if value\.get\("closeBridge"\)/);
  assert.match(
    bridge,
    /if close_requested\.is_set\(\):\s+[\s\S]*?await terminate_audiosocket\(writer\)/,
    "A committed payment or handoff must immediately release AudioSocket.",
  );
  assert.match(
    bridge,
    /if responses and not close_requested\.is_set\(\):/,
    "Gemini must not delay bridge closure by sending a response after handoff.",
  );
  assert.match(bridge, /request_human_handoff/);
  assert.match(bridge, /server\.get\("interrupted"\) is True/);
  assert.match(bridge, /START_SENSITIVITY_LOW/);
  assert.match(bridge, /class SpeechOutput/);
  assert.match(bridge, /await playback\.wait_until_complete\(\)/);
  assert.match(bridge, /audio\/pcm;rate=16000/);
  assert.match(bridge, /generation_complete_and_buffer_drained/);
  assert.match(bridge, /bufferUnderrun/);
  assert.match(bridge, /order_mutation_lock/);
  assert.match(bridge, /def logical_tool_key/);
  assert.match(phonePrompt, /sour cream on the side/);
  assert.match(phonePrompt, /current totalDisplay before any tip/);
  assert.equal(
    callerFromSipHeaders([
      {
        name: "X-Corner-Ops-Caller",
        value:
          '"FraryFH"<sip:FraryFH@192.168.1.237:5060>;party=calling',
      },
    ]),
    "",
    "An internal SIP username/IP must never be converted into a customer phone number.",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      model,
      liveWebSocketSetup: true,
      audioSocketRouting: true,
      sharedOrderingTools: declarations.length,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
