// Regression from Chris's dev test call 2026-11-06 (f98e637f): mis-heard speech flipped the order between
// delivery and pickup twice. Once set, the order type changes only when the caller asks (serviceChangeRequested).
// Run: npx tsx scripts/ai-cart-regressions/service-type.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const service = async (orderId: string) => String((await h.sql`SELECT service_type FROM ordering_orders WHERE id=${orderId}`)[0].service_type);
  try {
    await h.check("a set order type doesn't flip without the caller asking", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", serviceType: "delivery", items: [{ name: "Turkey Big Boss", quantity: 1 }] });
      const r = await m.invoke({ operation: "read", serviceType: "pickup", items: [] });
      assert.ok(r.isError && r.body.error?.code === "SERVICE_ALREADY_SET", JSON.stringify(r.body));
      assert.equal(await service(r0.orderId!), "delivery");
    });
    await h.check("before anything is ordered, a correction to pickup is always taken", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "read", serviceType: "delivery", items: [] });
      const r = await m.invoke({ operation: "read", serviceType: "pickup", items: [] });
      assert.ok(!r.isError, JSON.stringify(r.body));
      if (r0.orderId) assert.equal(await service(r0.orderId), "pickup");
    });
    await h.check("'undecided' after it's set keeps the set type", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", serviceType: "pickup", items: [{ name: "Turkey Big Boss", quantity: 1 }] });
      const r = await m.invoke({ operation: "read", serviceType: "undecided", items: [] });
      assert.ok(!r.isError, JSON.stringify(r.body));
      assert.equal(await service(r0.orderId!), "pickup");
    });
    await h.check("the caller asking to switch does switch", async () => {
      const m = await h.newMcpCall();
      const r0 = await m.invoke({ operation: "add", serviceType: "delivery", items: [{ name: "Turkey Big Boss", quantity: 1 }] });
      const r = await m.invoke({ operation: "read", serviceType: "pickup", serviceChangeRequested: true, items: [] });
      assert.ok(!r.isError, JSON.stringify(r.body));
      assert.equal(await service(r0.orderId!), "pickup");
    });
  } finally {
    await h.cleanup();
  }
  h.summary();
  process.exit(process.exitCode || 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
