// Throwaway reproduction harness for AI phone cart edits (independent verification).
// Drives the two real entry points the voice model uses:
//  - MCP:      POST /api/openai/ordering/mcp  tools/call price_order  (real route handler)
//  - Sideband: the exact executePriceOrder pipeline from openai-phone-sideband.ts
//              (applyFryPlacementSpeech -> applyPendingModifierAnswer ->
//               attachStandaloneModifierAnswer -> incrementalSpokenCart ->
//               priceSpokenOrder -> compactPhoneOrderResult + wing add-on follow-up).
//              executePriceOrder is a closure over a live OpenAI websocket, so its body
//              is replicated here step-for-step (src/lib/openai-phone-sideband.ts:672-860).
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "../validation-env";
localValidationEnv();
process.env.OPENAI_ORDERING_MCP_TOKEN = `repro-${randomUUID()}`;

export async function loadHarness() {
  const [{ getSql }, tools, cart, phone, route] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/ordering-ai-tools"),
    import("../../src/lib/openai-phone-sideband"),
    import("../../src/lib/openai-phone-ordering"),
    import("../../src/app/api/openai/ordering/mcp/route"),
  ]);
  const sql = getSql();
  const orders = new Set<string>();
  const calls = new Set<string>();
  let passed = 0,
    failed = 0;
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];

  async function check(name: string, run: () => unknown | Promise<unknown>) {
    try {
      await run();
      passed++;
      results.push({ name, ok: true });
      console.log(`PASS ${name}`);
    } catch (error: any) {
      failed++;
      results.push({ name, ok: false, error: String(error?.message || error) });
      console.error(`FAIL ${name}\n   ${String(error?.message || error).split("\n").join("\n   ")}`);
    }
  }

  async function snapshot(orderId: string) {
    return JSON.stringify({
      order: (await sql`SELECT * FROM ordering_orders WHERE id=${orderId}`)[0],
      lines: await sql`SELECT * FROM ordering_order_items WHERE order_id=${orderId} ORDER BY id`,
      modifiers:
        await sql`SELECT mod.* FROM ordering_order_item_modifiers mod JOIN ordering_order_items item ON item.id=mod.order_item_id WHERE item.order_id=${orderId} ORDER BY mod.id`,
    });
  }
  async function readCart(orderId: string) {
    return cart.incrementalSpokenCart(orderId, "read", "", []);
  }
  async function dbLines(orderId: string) {
    const lines = await sql`SELECT id,cart_line_id,item_name_snapshot,variant_name_snapshot,quantity,line_total_cents FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`;
    const mods = await sql`SELECT mod.order_item_id,mod.group_name_snapshot,mod.option_name_snapshot,mod.selection_state,mod.unit_price_delta_cents FROM ordering_order_item_modifiers mod JOIN ordering_order_items item ON item.id=mod.order_item_id WHERE item.order_id=${orderId} ORDER BY mod.created_at,mod.id`;
    return lines.map((l: any) => ({
      lineId: String(l.cart_line_id),
      name: String(l.item_name_snapshot),
      variant: String(l.variant_name_snapshot || ""),
      quantity: Number(l.quantity),
      lineTotal: Number(l.line_total_cents),
      mods: mods
        .filter((m: any) => String(m.order_item_id) === String(l.id))
        .map((m: any) => `${m.group_name_snapshot}:${m.option_name_snapshot}[${m.selection_state}]`),
    }));
  }

  // ---------- MCP entry point ----------
  async function newMcpCall() {
    const callId = `rtc_repro_${randomUUID()}`;
    await phone.registerOpenAiCall(callId, "3155550142", "", "REPRO");
    calls.add(callId);
    let rpcId = 1;
    const invoke = async (args: Record<string, unknown>) => {
      const response = await route.POST(
        new Request("http://localhost/api/openai/ordering/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.OPENAI_ORDERING_MCP_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: rpcId++,
            method: "tools/call",
            params: {
              name: "price_order",
              arguments: { callId, serviceType: "pickup", firstName: "Repro", lastName: "Cart", ...args },
            },
          }),
        }),
      );
      const json = await response.json();
      const text = json.result?.content?.[0]?.text || "{}";
      const body = JSON.parse(text);
      const orderId = (await sql`SELECT order_id FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`)[0]?.order_id;
      if (orderId) orders.add(String(orderId));
      return { isError: Boolean(json.result?.isError), body, orderId: orderId ? String(orderId) : null };
    };
    return { callId, invoke };
  }

  // ---------- Sideband entry point (executePriceOrder replica) ----------
  function newSidebandCall() {
    const state: { orderId: string | null; pendingItem: any; deferred: string[] } = {
      orderId: null,
      pendingItem: null,
      deferred: [],
    };
    const actor = { id: `openai:repro`, name: "Corner Deli AI Phone", type: "employee" as const, role: "employee" as const };
    const invoke = async (args: Record<string, any>, customerText = "") => {
      try {
        let spokenItems = Array.isArray(args.items) ? args.items : [];
        let operation = cart.parseCartOperation(args.operation);
        let targetItem = String(args.targetLineId || args.targetItem || "");
        spokenItems = cart.applyFryPlacementSpeech(spokenItems, customerText);
        const pendingApplied = await cart.applyPendingModifierAnswer({
          orderId: state.orderId,
          pendingItem: state.pendingItem,
          customerText,
          operation,
          targetItem,
          items: spokenItems,
        });
        operation = pendingApplied.operation;
        targetItem = pendingApplied.targetItem;
        spokenItems = pendingApplied.items;
        const resolved = new Set<string>(state.deferred);
        for (const q of pendingApplied.resolvedPendingQuestions || []) resolved.add(q);
        const attached = await cart.attachStandaloneModifierAnswer(state.orderId, operation, spokenItems);
        if (attached) {
          operation = attached.operation;
          targetItem = attached.targetItem;
          spokenItems = attached.items;
        }
        const touchedItems = spokenItems;
        spokenItems = await cart.incrementalSpokenCart(state.orderId, operation, targetItem, touchedItems);
        const result: any = await tools.priceSpokenOrder({
          business: "Corner Deli",
          actor,
          service: tools.serviceType(args.serviceType || "pickup"),
          items: spokenItems,
          orderId: state.orderId,
          customerId: null,
          callerPhone: "3155550142",
          firstName: "Repro",
          lastName: "Cart",
          resolvedPendingQuestions: [...resolved],
          customerText,
        });
        state.orderId = String(result.id);
        orders.add(state.orderId);
        state.pendingItem = result.pending_item || null;
        // wing add-on follow-up: the sideband's own exported check
        const wingNeedsAddOn =
          args.wingAddOnDecision !== "declined" &&
          cart.wingNeedsAddOnQuestion(operation, targetItem, touchedItems, spokenItems);
        if (wingNeedsAddOn) result.required_follow_up = "Would you like blue cheese, ranch, or celery with that?";
        const compact: any = await cart.compactPhoneOrderResult(result, operation);
        if (result.required_follow_up) compact.requiredFollowUp = result.required_follow_up;
        return { ok: true as const, compact, error: null as any };
      } catch (error: any) {
        if (error?.details?.pendingItem) state.pendingItem = error.details.pendingItem;
        return { ok: false as const, compact: null as any, error };
      }
    };
    return { state, invoke };
  }

  async function wingSauceOptions() {
    return (
      await sql`SELECT o.name FROM ordering_modifier_options o JOIN ordering_modifier_groups g ON g.id=o.group_id WHERE g.business='Corner Deli' AND g.name='Wing Sauce' AND o.active=TRUE AND o.available=TRUE ORDER BY o.sort_order,o.name`
    ).map((r: any) => String(r.name));
  }

  async function cleanup() {
    for (const callId of calls) {
      const row = (await sql`SELECT order_id FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`)[0];
      if (row?.order_id) orders.add(String(row.order_id));
      await sql`DELETE FROM ordering_call_sessions WHERE three_cx_call_id=${callId}`;
    }
    for (const id of orders) {
      // audit rows written by the MCP route for these throwaway repro calls only
      await sql`DELETE FROM ordering_ai_tool_events WHERE order_id=${id} AND conversation_id LIKE 'rtc_repro_%'`;
      await sql`DELETE FROM ordering_orders WHERE id=${id} AND status='draft'`;
    }
  }
  function summary() {
    console.log(JSON.stringify({ passed, failed }));
    if (failed) process.exitCode = 1;
  }
  return { sql, tools, cart, check, snapshot, readCart, dbLines, newMcpCall, newSidebandCall, wingSauceOptions, cleanup, summary, orders };
}
