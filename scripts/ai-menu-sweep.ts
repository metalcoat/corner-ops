// Orders every active menu item (each size) through the phone AI's price_order path, answering each
// required follow-up with the first offered choice, and reports what can't be ordered.
// Runs against the dev database; all orders and test calls are cleaned up. Run: npx tsx scripts/ai-menu-sweep.ts
import { loadHarness } from "./ai-cart-regressions/harness";

async function main() {
  const h = await loadHarness();
  const { menuCatalog } = h.tools as any;
  const items = (await menuCatalog("Corner Deli", new Date())).flatMap((category: any) =>
    (category.items || []).map((item: any) => ({ ...item, category: category.name })),
  );
  const results: any[] = [];
  try {
    for (const item of items) {
      if (!item.available) { results.push({ item: item.name, outcome: "unavailable_now" }); continue; }
      const variants = (item.variants || []).filter((v: any) => v.active !== false && v.available !== false);
      for (const variant of variants.length ? variants : [null]) {
        let request: any = { name: item.name, quantity: 1, ...(variant ? { variant: variant.name } : {}), modifiers: [] };
        let outcome = "", detail = "";
        const asked: string[] = [];
        // Yes/no questions the caller answers in words (sub condiments, toppings) are answered "no thanks".
        const decisions: Record<string, string> = {};
        for (let round = 0; round < 10; round++) {
          const m = await h.newMcpCall();
          const r = await m.invoke({ operation: "add", items: [request], ...decisions });
          if (r.isError) { outcome = r.body.error?.code || "error"; detail = r.body.error?.message || ""; break; }
          if (!r.body.pending) { outcome = "ok"; break; }
          const d = r.body.details || {};
          const question = String(r.body.requiredFollowUp || "");
          if (asked.includes(question)) { outcome = "stuck"; detail = question; break; }
          asked.push(question);
          const options: string[] = (d.options || []).map(String);
          const choice = options.find((option) => !/^no\b/i.test(option)) || options[0];
          if (!choice) {
            const before = Object.keys(decisions).length;
            for (const key of ["coldSubCondimentsDecision", "coldSubVegetablesDecision", "steakStyleCondimentDecision", "steakStyleToppingsDecision", "steakStyleCheeseDecision", "steakStyleDoubleMeatDecision", "burgerToppingsDecision", "burgerFriesDecision", "wingAddOnDecision", "hamburgerSteakToppingsDecision"])
              decisions[key] = "declined";
            if (Object.keys(decisions).length > before) continue;
            outcome = "follow_up_without_options"; detail = question; break;
          }
          if (d.group) request = { ...request, modifiers: [...request.modifiers, { name: choice, group: d.group }] };
          else request = { ...request, name: choice, variant: undefined };
        }
        if (!outcome) outcome = "too_many_follow_ups";
        results.push({ item: item.name, category: item.category, variant: variant?.name || "", outcome, detail, followUps: asked.length });
        await h.cleanup();
      }
    }
  } finally {
    await h.cleanup();
  }
  const counts = results.reduce((acc: any, row) => ((acc[row.outcome] = (acc[row.outcome] || 0) + 1), acc), {});
  console.log(JSON.stringify({ counts, problems: results.filter((row) => !["ok", "unavailable_now"].includes(row.outcome)) }, null, 1));
  process.exit(0);
}
main();
