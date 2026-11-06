#!/usr/bin/env node
// Text-only eval: can Claude run the AI phone ordering line as well as the Gemini Live bridge?
// Replays scripted caller lines (conversations.ts) turn by turn with the same instructions the Gemini bridge
// gets from /api/internal/ai-phone (session) and the same ordering MCP tools (/api/openai/ordering/mcp),
// executed in-process against the dev database inside a transaction that is always rolled back.
// Payment, transfer, send and end-of-call tools are stubbed; nothing is charged, printed or sent.
//
//   npx tsx scripts/claude-phone-eval/run.ts --gemini-only        grade the logged Gemini calls (no API key)
//   npx tsx scripts/claude-phone-eval/run.ts --dry-run            prompt/tool plumbing check (no API key)
//   ANTHROPIC_API_KEY=... npx tsx scripts/claude-phone-eval/run.ts [--models haiku,sonnet] [--only key,key]
//
// The key is read from ANTHROPIC_API_KEY or /opt/corner-ops/config/anthropic-dev.env. Spend stops at $3.
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { localValidationEnv } from "../validation-env";
import { conversations, type Conversation, type LineMatcher } from "./conversations";

localValidationEnv();
process.env.OPENAI_ORDERING_MCP_TOKEN = `claude-eval-${randomUUID()}`;
const KEY_FILE = "/opt/corner-ops/config/anthropic-dev.env";
if (!process.env.ANTHROPIC_API_KEY && existsSync(KEY_FILE)) loadEnvFile(KEY_FILE);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const BUDGET_USD = Number(option("--budget") || 3);
// Every conversation uses one call id: each runs in its own rolled-back transaction, and an identical
// system prompt lets the cached prefix carry from one conversation to the next.
const CALL_ID = "claude-phone-eval";
const NEW_CALLER_PHONE = "3155550142";
const GREETING = "Thanks for calling Corner Deli, is this going to be pickup or delivery?";

const MODELS = {
  haiku: {
    id: "claude-haiku-5-5",
    // $ per million tokens; cache writes 1.25x input, cache reads 10% of input.
    price: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    request: { output_config: { effort: "low" as const } },
  },
  sonnet: {
    id: "claude-sonnet-5-5",
    price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    request: { thinking: { type: "between_tools" as const }, output_config: { effort: "low" as const } },
  },
  // between_tools let Sonnet write its reasoning into the spoken reply on 2026-11-06; adaptive keeps it in thinking.
  "sonnet-adaptive": {
    id: "claude-sonnet-5-5",
    price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    request: { thinking: { type: "adaptive" as const }, output_config: { effort: "low" as const } },
  },
};
type ModelKey = keyof typeof MODELS;

type CartLine = { name: string; variant: string; quantity: number; lineTotalCents: number; mods: string[] };
type Cart = { lines: CartLine[]; serviceType: string; address: string; totalCents: number; tipCents: number };
type ToolCall = { name: string; input: unknown; ms: number; error?: string };
type TurnRecord = {
  caller: string;
  assistant: string;
  firstTextMs: number | null;
  firstTokenMs: number | null;
  totalMs: number;
  requests: number;
  tools: ToolCall[];
};

async function main() {
  const [{ getSql, withTransaction }, prompt, config, customers, route, cart] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/openai-phone-prompt"),
    import("../../src/lib/ordering-ai-phone-config"),
    import("../../src/lib/ordering-customers"),
    import("../../src/app/api/openai/ordering/mcp/route"),
    import("../../src/lib/ordering-ai-schema"),
  ]);
  await cart.ensureOrderingAiSchema();
  // getSql() returns the open transaction's client only when called inside it, so resolve it per query.
  const sql = (strings: TemplateStringsArray, ...values: any[]) => getSql()(strings, ...values);

  // The returning caller is whoever placed the logged Gemini test calls (read here, never stored in git).
  const returningPhone = String(
    (await sql`SELECT caller_phone FROM ordering_call_sessions WHERE three_cx_call_id=${conversations[0].geminiCallId}`)[0]
      ?.caller_phone || "",
  );
  const settings = await config.getAiPhoneSettings();
  // Fixed open-store state so results don't depend on what time the eval runs.
  const business = {
    ...(await config.realtimeBusinessContext()),
    pickupAvailable: true,
    deliveryAvailable: true,
    pickupWait: "about 15 to 20 minutes",
    deliveryWait: "about 40 to 55 minutes",
  };
  const instructionsFor = async (phone: string) => {
    const customer = await customers.phoneOrderingCustomerContext("Corner Deli", phone);
    return {
      matched: Boolean(customer),
      text: `${prompt.buildPhoneInstructions({ callId: CALL_ID, callerPhone: phone, lineLabel: "TEST", settings, business, customer })}\nAfter speaking the exact final closing sentence, call complete_call.`,
    };
  };

  const mcp = async (body: Record<string, unknown>) => {
    const response = await route.POST(
      new Request("http://localhost/api/openai/ordering/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENAI_ORDERING_MCP_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), ...body }),
      }),
    );
    return (await response.json()) as any;
  };
  const tools = toAnthropicTools((await mcp({ method: "tools/list" })).result.tools);

  const readCart = async (orderId: string | null): Promise<Cart> => {
    if (!orderId) return { lines: [], serviceType: "", address: "", totalCents: 0, tipCents: 0 };
    const order = (await sql`SELECT service_type,total_cents,tip_cents FROM ordering_orders WHERE id=${orderId}`)[0] || {};
    const address = (await sql`SELECT COALESCE(formatted_address,entered_address,line1,'') address FROM ordering_order_delivery_addresses WHERE order_id=${orderId} LIMIT 1`)[0];
    const lines = await sql`SELECT i.item_name_snapshot,i.variant_name_snapshot,i.quantity,i.line_total_cents,COALESCE((SELECT json_agg(m.option_name_snapshot ORDER BY m.created_at,m.id) FROM ordering_order_item_modifiers m WHERE m.order_item_id=i.id AND m.selection_state='selected'),'[]') mods FROM ordering_order_items i WHERE i.order_id=${orderId} ORDER BY i.sort_order,i.created_at,i.id`;
    return {
      lines: lines.map((row: any) => ({
        name: String(row.item_name_snapshot),
        variant: String(row.variant_name_snapshot || ""),
        quantity: Number(row.quantity),
        lineTotalCents: Number(row.line_total_cents),
        mods: (typeof row.mods === "string" ? JSON.parse(row.mods) : row.mods).map(String),
      })),
      serviceType: String(order.service_type || ""),
      address: String(address?.address || ""),
      totalCents: Number(order.total_cents || 0),
      tipCents: Number(order.tip_cents || 0),
    };
  };

  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), conversations: {} };

  // ---- Gemini baseline: the logged dev calls these scripts were taken from, graded the same way ----
  const gemini: Record<string, unknown> = {};
  for (const conversation of conversations.filter((row) => row.geminiCallId)) {
    const orderId = (await sql`SELECT order_id FROM ordering_call_sessions WHERE three_cx_call_id=${conversation.geminiCallId}`)[0]?.order_id;
    const events = await sql`SELECT transcript FROM ordering_call_transcript_segments WHERE call_id=${conversation.geminiCallId} AND speaker='assistant' ORDER BY completed_at`;
    const said = events.map((row: any) => String(row.transcript)).join(" ");
    const loggedCart = await readCart(orderId ? String(orderId) : null);
    // The logged call only shows the outcome through what was said: a tip prompt means it reached payment.
    const outcome = /secure payment|tip/i.test(said) ? "payment" : /connect you with someone/i.test(said) ? "handoff" : "none";
    gemini[conversation.key] = { callId: conversation.geminiCallId, cart: loggedCart, outcome, grade: grade(conversation, loggedCart, outcome, null, true) };
  }
  report.gemini = gemini;
  printGrades("gemini (logged dev calls)", gemini);
  if (flag("--gemini-only")) return save(report);

  // ---- Plumbing check without an API key ----
  if (flag("--dry-run") || !process.env.ANTHROPIC_API_KEY) {
    const returning = await instructionsFor(returningPhone);
    const fresh = await instructionsFor(NEW_CALLER_PHONE);
    let probe: unknown = null;
    await rolledBack(withTransaction, async () => {
      await registerCall(sql, returningPhone);
      const result = await executeTool(mcp, "price_order", {
        operation: "add",
        serviceType: "pickup",
        firstName: "Eval",
        lastName: "Probe",
        items: [{ name: "Turkey Big Boss", quantity: 1, modifiers: [{ name: "no tomato" }] }],
      });
      const orderId = (await sql`SELECT order_id FROM ordering_call_sessions WHERE three_cx_call_id=${CALL_ID}`)[0]?.order_id;
      probe = { result, cart: await readCart(orderId ? String(orderId) : null) };
    });
    const leftover = await sql`SELECT count(*)::int n FROM ordering_call_sessions WHERE three_cx_call_id=${CALL_ID}`;
    report.dryRun = {
      apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      returningCallerMatched: returning.matched,
      newCallerMatched: fresh.matched,
      instructionChars: returning.text.length,
      toolNames: tools.map((tool) => tool.name),
      toolJsonChars: JSON.stringify(tools).length,
      probe,
      rowsLeftAfterRollback: leftover[0].n,
    };
    console.log(JSON.stringify(report.dryRun, null, 2));
    if (!process.env.ANTHROPIC_API_KEY) console.log(`\nNo ANTHROPIC_API_KEY (env or ${KEY_FILE}); stopping before any model call.`);
    return save(report);
  }

  // ---- Claude runs ----
  const client = new Anthropic();
  const modelKeys = (option("--models") || "haiku,sonnet").split(",") as ModelKey[];
  const only = option("--only")?.split(",");
  let spent = 0;
  for (const modelKey of modelKeys) {
    const model = MODELS[modelKey];
    const results: Record<string, unknown> = {};
    for (const conversation of conversations.filter((row) => !only || only.includes(row.key))) {
      if (spent >= BUDGET_USD * 0.9) {
        console.log(`Budget guard: $${spent.toFixed(3)} spent of $${BUDGET_USD}; stopping.`);
        break;
      }
      const phone = conversation.caller === "returning" ? returningPhone : NEW_CALLER_PHONE;
      const instructions = await instructionsFor(phone);
      const run = await rolledBack(withTransaction, async () => {
        await registerCall(sql, phone);
        const result = await converse(client, model, tools, instructions.text, conversation, mcp);
        const orderId = (await sql`SELECT order_id FROM ordering_call_sessions WHERE three_cx_call_id=${CALL_ID}`)[0]?.order_id;
        return { ...result, cart: await readCart(orderId ? String(orderId) : null) };
      });
      const cost = costOf(model.price, run.usage);
      spent += cost;
      results[conversation.key] = { ...run, costUsd: cost, grade: grade(conversation, run.cart, run.outcome, run.tipCents, false) };
      const g = (results[conversation.key] as any).grade;
      console.log(`${modelKey} ${conversation.key}: ${g.pass ? "PASS" : "FAIL"} $${cost.toFixed(4)}${g.problems.length ? " - " + g.problems.join("; ") : ""}`);
    }
    (report.conversations as any)[modelKey] = results;
    printGrades(modelKey, results);
  }
  report.totalSpendUsd = spent;
  save(report);
}

// ---------------------------------------------------------------------------------------------------------

function save(report: Record<string, unknown>) {
  const path = new URL(`./results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\nSaved ${path.pathname}`);
  process.exit(0);
}

const ROLLBACK = "claude-phone-eval:rollback";
async function rolledBack<T>(withTransaction: <R>(run: () => Promise<R>) => Promise<R>, run: () => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await withTransaction(async () => {
      value = await run();
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  return value as T;
}

async function registerCall(sql: any, phone: string) {
  // Same row /api/internal/ai-phone inserts when a call is routed to the Gemini bridge; shadow mode, so even a
  // confirmed `send` would only park the order for review (and `send` is stubbed anyway).
  await sql`INSERT INTO ordering_call_sessions(id,business,three_cx_call_id,caller_phone,called_did,line_label,selected_model,selected_provider,operating_mode,state,owner_type,owner_id,bridge_action) VALUES(${randomUUID()},'Corner Deli',${CALL_ID},${phone},'','CLAUDE EVAL','claude','gemini','shadow','ai','ai',${`gemini:${CALL_ID}`},'') ON CONFLICT(three_cx_call_id) DO UPDATE SET caller_phone=EXCLUDED.caller_phone,order_id=NULL,pending_item=NULL,state='ai',operating_mode='shadow',updated_at=NOW()`;
}

// MCP tools/list -> Anthropic tool definitions, mirroring declarations() in asterisk/gemini-phone.py:
// callId is filled in by the bridge, request_human_handoff is replaced by the bridge's own version, and
// the bridge-only payment and end-of-call tools are added.
function toAnthropicTools(mcpTools: any[]): Anthropic.Tool[] {
  const rows: Anthropic.Tool[] = mcpTools
    .filter((tool) => tool.name !== "request_human_handoff")
    .map((tool) => {
      const schema = JSON.parse(JSON.stringify(tool.inputSchema || { type: "object" }));
      delete schema.$schema;
      if (schema.properties) delete schema.properties.callId;
      if (Array.isArray(schema.required)) schema.required = schema.required.filter((name: string) => name !== "callId");
      return { name: tool.name, description: tool.description || "", input_schema: schema };
    });
  rows.push(
    {
      name: "request_human_handoff",
      description: "Transfer the caller to a Corner Deli employee.",
      input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    },
    {
      name: "request_secure_voice_payment",
      description: "Leave AI and start isolated card collection after a confirmed card order.",
      input_schema: { type: "object", properties: { tipCents: { type: "integer" } }, required: ["tipCents"] },
    },
    {
      name: "complete_call",
      description: "End the call only after the complete closing sentence has played.",
      input_schema: { type: "object", properties: {} },
    },
  );
  rows[rows.length - 1].cache_control = { type: "ephemeral" };
  return rows;
}

const ENDING_TOOLS = new Set(["request_human_handoff", "request_secure_voice_payment", "complete_call"]);

async function executeTool(mcp: (body: Record<string, unknown>) => Promise<any>, name: string, input: Record<string, unknown>) {
  if (name === "request_human_handoff") return { ok: true, status: "TRANSFERRING", closeBridge: true };
  if (name === "request_secure_voice_payment") return { ok: true, status: "PAYMENT_STARTED", closeBridge: true };
  if (name === "complete_call") return { ok: true, closeBridge: true };
  if (name === "send")
    return input.customerConfirmed === true
      ? { status: "ORDER_REVIEW_PENDING", mode: "shadow", message: "The confirmed order is visible to Corner Deli staff for review." }
      : { error: { code: "SEND_BLOCKED", message: "Explicit customer confirmation is required after the complete readback." } };
  const body = await mcp({ method: "tools/call", params: { name, arguments: { ...input, callId: CALL_ID } } });
  const text = body.result?.content?.[0]?.text;
  if (!text) return body;
  try {
    return voiceSafe(JSON.parse(text));
  } catch {
    return { text };
  }
}

// voice_safe_tool_result() from asterisk/gemini-phone.py, so Claude sees exactly what Gemini sees.
const DROPPED_RESULT_KEYS = new Set(["totalCents", "amountDueCents"]);
function compact(value: any, top = true): any {
  if (Array.isArray(value)) return value.map((item) => compact(item, false));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (top && DROPPED_RESULT_KEYS.has(key)) continue;
    if (key === "quantity" && raw === 1 && "group" in value) continue;
    const item = compact(raw, false);
    if (item === null || item === undefined || item === "" || (Array.isArray(item) && !item.length) || (typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length)) continue;
    out[key] = item;
  }
  return out;
}
function scrub(value: any): any {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    let item = raw;
    if (typeof item === "string" && /draft/i.test(item)) {
      if (key.toLowerCase() === "status") continue;
      if (["message", "instruction", "remedy"].includes(key.toLowerCase())) item = item.replace(/\bdraft(s?)\b/gi, "order$1");
    }
    out[key] = scrub(item);
  }
  return out;
}
const failed = (value: any) => value && typeof value === "object" && ("error" in value || value.ok === false || value.pending === true);
function voiceSafe(value: any) {
  const safe = compact(scrub(value));
  if (safe && typeof safe === "object" && !Array.isArray(safe))
    safe.voiceInstruction = failed(safe)
      ? "Do not narrate internal order state. Fix or ask about this before continuing."
      : "Do not narrate internal order state. Continue the customer-facing checkout sequence only.";
  return safe;
}

type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number; requests: number };
function costOf(price: (typeof MODELS)[ModelKey]["price"], usage: Usage) {
  return (usage.input * price.input + usage.output * price.output + usage.cacheWrite * price.cacheWrite + usage.cacheRead * price.cacheRead) / 1e6;
}

async function converse(
  client: Anthropic,
  model: (typeof MODELS)[ModelKey],
  tools: Anthropic.Tool[],
  instructions: string,
  conversation: Conversation,
  mcp: (body: Record<string, unknown>) => Promise<any>,
) {
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: instructions, cache_control: { type: "ephemeral" } }];
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Say exactly: "${GREETING}"` },
    { role: "assistant", content: GREETING },
  ];
  const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0 };
  const turns: TurnRecord[] = [];
  const pending = [...conversation.lines];
  const usedAnswers = new Set<number>();
  let lastAssistant = GREETING;
  let outcome = "none";
  let tipCents: number | null = null;
  let extraTurns = 0;

  while (outcome === "none") {
    // Pick the caller's next words: a scripted answer to a question the script didn't plan for, else the next line.
    const answer = (conversation.answers || []).findIndex((rule, index) => !usedAnswers.has(index) && rule.when.test(lastAssistant));
    let caller: string;
    if (answer >= 0 && /\?\s*$/.test(lastAssistant.trim())) {
      usedAnswers.add(answer);
      caller = conversation.answers![answer].say;
    } else if (pending.length) caller = pending.shift()!;
    else if (extraTurns++ < 2) caller = "That's everything, thanks.";
    else break;

    messages.push({ role: "user", content: caller });
    const turn: TurnRecord = { caller, assistant: "", firstTextMs: null, firstTokenMs: null, totalMs: 0, requests: 0, tools: [] };
    const started = performance.now();
    for (let request = 0; request < 8 && outcome === "none"; request++) {
      turn.requests++;
      const stream = client.messages.stream({
        model: model.id,
        max_tokens: 4096,
        system,
        tools,
        tool_choice: { type: "auto" },
        cache_control: { type: "ephemeral" },
        messages,
        ...model.request,
      });
      stream.on("streamEvent", (event) => {
        if (turn.firstTokenMs === null && event.type === "content_block_delta") turn.firstTokenMs = performance.now() - started;
        if (turn.firstTextMs === null && event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text.trim())
          turn.firstTextMs = performance.now() - started;
      });
      const message = await stream.finalMessage();
      usage.requests++;
      usage.input += message.usage.input_tokens;
      usage.output += message.usage.output_tokens;
      usage.cacheWrite += message.usage.cache_creation_input_tokens || 0;
      usage.cacheRead += message.usage.cache_read_input_tokens || 0;
      messages.push({ role: "assistant", content: message.content });
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ").trim();
      if (text) turn.assistant = [turn.assistant, text].filter(Boolean).join(" ");
      const uses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      if (message.stop_reason !== "tool_use" || !uses.length) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const toolStarted = performance.now();
        let result: any;
        try {
          result = await executeTool(mcp, use.name, (use.input || {}) as Record<string, unknown>);
        } catch (error) {
          result = { error: { code: "HARNESS_ERROR", message: String((error as Error)?.message || error) } };
        }
        turn.tools.push({ name: use.name, input: use.input, ms: Math.round(performance.now() - toolStarted), error: failed(result) ? JSON.stringify(result.error || result).slice(0, 300) : undefined });
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result), is_error: Boolean(result?.error) });
        if (use.name === "request_secure_voice_payment") {
          outcome = "payment";
          tipCents = Number((use.input as any)?.tipCents ?? 0);
        } else if (use.name === "request_human_handoff") outcome = "handoff";
        else if (use.name === "complete_call") outcome = "complete";
      }
      messages.push({ role: "user", content: results });
      if (uses.some((use) => ENDING_TOOLS.has(use.name))) break;
    }
    turn.totalMs = performance.now() - started;
    lastAssistant = turn.assistant || lastAssistant;
    turns.push(turn);
  }
  return { turns, outcome, tipCents, usage };
}

// ---- Grading ----
function lineMatches(matcher: LineMatcher, line: CartLine) {
  const text = [line.variant, ...line.mods].join(" | ");
  return (
    matcher.item.test(line.name) &&
    (!matcher.variant || matcher.variant.test(line.variant)) &&
    (matcher.quantity === undefined || matcher.quantity === line.quantity) &&
    (matcher.has || []).every((pattern) => pattern.test(text)) &&
    !(matcher.not || []).some((pattern) => pattern.test(text))
  );
}

function grade(conversation: Conversation, cart: Cart, outcome: string, tipCents: number | null, logged: boolean) {
  const problems: string[] = [];
  const expect = conversation.expect;
  const nonWing = cart.lines.filter((line) => !/^wings$/i.test(line.name));
  // Two matchers for the same item each need their own line; quantity-2 matchers may also be two lines of 1.
  const used = new Set<number>();
  for (const matcher of expect.lines) {
    let index = nonWing.findIndex((line, i) => !used.has(i) && lineMatches(matcher, line));
    if (index < 0 && matcher.quantity && matcher.quantity > 1) {
      const singles = nonWing.map((line, i) => [line, i] as const).filter(([line, i]) => !used.has(i) && lineMatches({ ...matcher, quantity: 1 }, line));
      if (singles.length >= matcher.quantity) {
        singles.slice(0, matcher.quantity).forEach(([, i]) => used.add(i));
        continue;
      }
    }
    if (index < 0) problems.push(`missing/wrong ${matcher.item.source}${matcher.has ? " with " + matcher.has.map((p) => p.source).join("+") : ""}`);
    else used.add(index);
  }
  nonWing.forEach((line, i) => {
    if (!used.has(i)) problems.push(`unexpected ${line.quantity}x ${line.name} ${line.variant} [${line.mods.join(", ")}]`);
  });
  const wingLines = cart.lines.filter((line) => /^wings$/i.test(line.name));
  if (expect.wings || wingLines.length) {
    const want = expect.wings || {};
    const got: Record<string, number> = {};
    const sauces = Object.keys(want);
    for (const line of wingLines) {
      const count = Number(line.variant.match(/\d+/)?.[0] || 0) * line.quantity;
      const lineSauces = line.mods.filter((mod) => sauces.includes(mod) || /^(mild|medium|hot|suicide|bbq|open pit bbq|sweet & sassy|plain|garlic parm\w*|cajun|honey bbq|teriyaki|buffalo)$/i.test(mod));
      const share = lineSauces.length ? count / lineSauces.length : count;
      for (const sauce of lineSauces.length ? lineSauces : ["(no sauce)"]) got[sauce] = (got[sauce] || 0) + share;
    }
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const key of keys) if ((want[key] || 0) !== (got[key] || 0)) problems.push(`wings ${key}: want ${want[key] || 0}, got ${got[key] || 0}`);
  }
  if (expect.service && cart.lines.length && cart.serviceType !== expect.service) problems.push(`service ${cart.serviceType || "unset"}, want ${expect.service}`);
  if (expect.address && !expect.address.test(cart.address)) problems.push(`address "${cart.address}"`);
  const okOutcome = expect.outcome === "payment_or_complete" ? ["payment", "complete"].includes(outcome) : outcome === expect.outcome;
  if (!okOutcome) problems.push(`outcome ${outcome}, want ${expect.outcome}`);
  if (!logged && expect.tipCents !== undefined && outcome === "payment" && tipCents !== expect.tipCents) problems.push(`tip ${tipCents}, want ${expect.tipCents}`);
  return { pass: problems.length === 0, problems };
}

function printGrades(label: string, rows: Record<string, any>) {
  const values = Object.entries(rows);
  const passed = values.filter(([, row]) => row.grade.pass).length;
  console.log(`\n== ${label}: ${passed}/${values.length} orders exactly right`);
  for (const [key, row] of values) console.log(`  ${row.grade.pass ? "PASS" : "FAIL"} ${key}${row.grade.problems.length ? " - " + row.grade.problems.join("; ") : ""}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
