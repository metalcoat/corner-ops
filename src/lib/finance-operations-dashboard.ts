import { thirteenWeekCashForecast } from "@/lib/cash-forecast";
import { getSql } from "@/lib/db";
import { ensureFinanceOperationsSchema } from "@/lib/finance-operations-schema";
import { financialStatements } from "@/lib/financial-statements";
import { ensureRezkuProductSalesSchema } from "@/lib/rezku-product-sales";
import { ensureSquareControlSchema } from "@/lib/square-control";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

type InventoryItemRow = {
  id: string;
  name: string;
  category: string;
  base_unit: string;
  par_quantity: string | number;
  current_quantity: string | number;
  reorder_point: string | number;
  preferred_vendor: string;
};

type PurchaseRow = {
  id: string;
  inventory_item_id: string;
  vendor: string;
  purchase_date: string;
  quantity: string | number;
  unit: string;
  unit_price: string | number;
  total_amount: string | number;
};

type RecipeRow = {
  id: string;
  product_name: string;
  yield_quantity: string | number;
  selling_price: string | number;
};

type ComponentRow = {
  id: string;
  recipe_id: string;
  inventory_item_id: string;
  quantity: string | number;
  unit: string;
  waste_percent: string | number;
};

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function roundNumber(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function validDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
  return value;
}

function dateText(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateText(date);
}

function todayLocal(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function normalized(value: string): string {
  return clean(value, 250).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function unitDefinition(value: string) {
  const key = value.toLowerCase().trim();
  const definitions: Record<string, { dimension: string; factor: number }> = {
    each: { dimension: "each", factor: 1 },
    ea: { dimension: "each", factor: 1 },
    count: { dimension: "each", factor: 1 },
    oz: { dimension: "weight", factor: 1 },
    ounce: { dimension: "weight", factor: 1 },
    ounces: { dimension: "weight", factor: 1 },
    lb: { dimension: "weight", factor: 16 },
    lbs: { dimension: "weight", factor: 16 },
    pound: { dimension: "weight", factor: 16 },
    pounds: { dimension: "weight", factor: 16 },
    ml: { dimension: "volume", factor: 1 },
    l: { dimension: "volume", factor: 1000 },
    liter: { dimension: "volume", factor: 1000 },
    litre: { dimension: "volume", factor: 1000 },
    tsp: { dimension: "volume", factor: 4.92892 },
    tbsp: { dimension: "volume", factor: 14.7868 },
    cup: { dimension: "volume", factor: 236.588 },
    pint: { dimension: "volume", factor: 473.176 },
    qt: { dimension: "volume", factor: 946.353 },
    quart: { dimension: "volume", factor: 946.353 },
    gal: { dimension: "volume", factor: 3785.41 },
    gallon: { dimension: "volume", factor: 3785.41 },
  };
  return definitions[key] || { dimension: key || "unknown", factor: 1 };
}

function convertQuantity(value: number, fromUnit: string, toUnit: string): number | null {
  const from = unitDefinition(fromUnit);
  const to = unitDefinition(toUnit);
  if (from.dimension !== to.dimension) return null;
  return value * from.factor / to.factor;
}

function percentChange(current: number, prior: number): number | null {
  if (!prior) return null;
  return roundNumber((current - prior) / Math.abs(prior) * 100, 1);
}

async function billDashboard(business: Business) {
  const today = todayLocal();
  const rows = await getSql()`
    SELECT b.id, b.vendor, b.invoice_number, b.invoice_date, b.due_date, b.subtotal,
      b.tax_amount, b.total_amount, b.category, b.account_code, b.status, b.notes,
      b.file_name, b.blob_url, b.paid_bank_transaction_id, b.created_at,
      paid.transaction_date AS paid_date, paid.description AS paid_description,
      paid.signed_amount AS paid_amount
    FROM vendor_bills b
    LEFT JOIN bank_transactions paid ON paid.id = b.paid_bank_transaction_id
    WHERE b.business = ${business} AND b.status <> 'Void'
    ORDER BY CASE WHEN b.status = 'Open' THEN 0 ELSE 1 END, b.due_date, b.vendor
    LIMIT 300
  ` as unknown as Array<Record<string, unknown>>;

  const bills = [];
  for (const row of rows) {
    const amount = roundMoney(numeric(row.total_amount));
    const candidates = row.status === "Open" ? await getSql()`
      SELECT id, transaction_date, merchant_name, description, signed_amount
      FROM bank_transactions
      WHERE business = ${business} AND removed = FALSE AND pending = FALSE
        AND signed_amount = ${-Math.abs(amount)}
        AND transaction_date BETWEEN ${String(row.invoice_date)}::date - 5 AND ${String(row.due_date)}::date + 45
      ORDER BY ABS(transaction_date - ${String(row.due_date)}::date), transaction_date
      LIMIT 5
    ` as unknown as Array<Record<string, unknown>> : [];
    bills.push({
      id: String(row.id),
      vendor: String(row.vendor),
      invoiceNumber: String(row.invoice_number || ""),
      invoiceDate: String(row.invoice_date).slice(0, 10),
      dueDate: String(row.due_date).slice(0, 10),
      subtotal: roundMoney(numeric(row.subtotal)),
      taxAmount: roundMoney(numeric(row.tax_amount)),
      totalAmount: amount,
      category: String(row.category || ""),
      accountCode: String(row.account_code || ""),
      status: String(row.status),
      notes: String(row.notes || ""),
      fileName: String(row.file_name || ""),
      hasFile: Boolean(row.blob_url),
      overdue: row.status === "Open" && String(row.due_date).slice(0, 10) < today,
      daysUntilDue: Math.round((new Date(`${String(row.due_date).slice(0, 10)}T12:00:00Z`).getTime() - new Date(`${today}T12:00:00Z`).getTime()) / 86_400_000),
      paidTransaction: row.paid_bank_transaction_id ? {
        id: String(row.paid_bank_transaction_id),
        date: String(row.paid_date).slice(0, 10),
        description: String(row.paid_description || ""),
        amount: roundMoney(numeric(row.paid_amount)),
      } : null,
      candidates: candidates.map((candidate) => ({
        id: String(candidate.id),
        date: String(candidate.transaction_date).slice(0, 10),
        merchant: String(candidate.merchant_name || candidate.description || "Bank payment"),
        description: String(candidate.description || ""),
        amount: roundMoney(numeric(candidate.signed_amount)),
      })),
      createdAt: String(row.created_at),
    });
  }
  const open = bills.filter((bill) => bill.status === "Open");
  return {
    summary: {
      totalOpen: roundMoney(open.reduce((sum, bill) => sum + bill.totalAmount, 0)),
      overdue: roundMoney(open.filter((bill) => bill.overdue).reduce((sum, bill) => sum + bill.totalAmount, 0)),
      overdueCount: open.filter((bill) => bill.overdue).length,
      due7Days: roundMoney(open.filter((bill) => bill.daysUntilDue >= 0 && bill.daysUntilDue <= 7).reduce((sum, bill) => sum + bill.totalAmount, 0)),
      due30Days: roundMoney(open.filter((bill) => bill.daysUntilDue >= 0 && bill.daysUntilDue <= 30).reduce((sum, bill) => sum + bill.totalAmount, 0)),
      openCount: open.length,
      paidCount: bills.filter((bill) => bill.status === "Paid").length,
    },
    bills,
  };
}

async function inventoryDashboard(business: Business) {
  const [itemRows, purchaseRows, recipeRows, componentRows] = await Promise.all([
    getSql()`
      SELECT id, name, category, base_unit, par_quantity, current_quantity,
        reorder_point, preferred_vendor
      FROM inventory_items
      WHERE business = ${business} AND active = TRUE
      ORDER BY category, name
    ` as unknown as InventoryItemRow[],
    getSql()`
      SELECT id, inventory_item_id, vendor, purchase_date, quantity, unit, unit_price, total_amount
      FROM inventory_purchases
      WHERE business = ${business}
      ORDER BY purchase_date DESC, created_at DESC
      LIMIT 5000
    ` as unknown as PurchaseRow[],
    getSql()`
      SELECT id, product_name, yield_quantity, selling_price
      FROM recipes
      WHERE business = ${business} AND active = TRUE
      ORDER BY product_name
    ` as unknown as RecipeRow[],
    getSql()`
      SELECT c.id, c.recipe_id, c.inventory_item_id, c.quantity, c.unit, c.waste_percent
      FROM recipe_components c
      JOIN recipes r ON r.id = c.recipe_id
      WHERE r.business = ${business} AND r.active = TRUE
      ORDER BY c.recipe_id, c.created_at
    ` as unknown as ComponentRow[],
  ]);

  const purchasesByItem = new Map<string, PurchaseRow[]>();
  for (const purchase of purchaseRows) {
    const list = purchasesByItem.get(purchase.inventory_item_id) || [];
    list.push(purchase);
    purchasesByItem.set(purchase.inventory_item_id, list);
  }
  const items = itemRows.map((row) => {
    const purchases = purchasesByItem.get(row.id) || [];
    const normalizedPurchases = purchases.map((purchase) => {
      const converted = convertQuantity(numeric(purchase.quantity), purchase.unit, row.base_unit);
      const total = numeric(purchase.total_amount) || numeric(purchase.quantity) * numeric(purchase.unit_price);
      return {
        id: purchase.id,
        vendor: purchase.vendor,
        date: String(purchase.purchase_date).slice(0, 10),
        quantity: numeric(purchase.quantity),
        unit: purchase.unit,
        unitPrice: numeric(purchase.unit_price),
        normalizedUnitPrice: converted && converted > 0 ? roundNumber(total / converted, 4) : null,
        totalAmount: roundMoney(total),
      };
    });
    const comparable = normalizedPurchases.filter((purchase) => purchase.normalizedUnitPrice !== null);
    const latest = comparable[0] || null;
    const prior = comparable[1] || null;
    const recent90 = comparable.filter((purchase) => purchase.date >= addDays(todayLocal(), -90));
    const lowest = [...recent90].sort((left, right) => (left.normalizedUnitPrice || 0) - (right.normalizedUnitPrice || 0))[0] || null;
    const currentQuantity = numeric(row.current_quantity);
    const reorderPoint = numeric(row.reorder_point);
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      baseUnit: row.base_unit,
      parQuantity: roundNumber(numeric(row.par_quantity), 4),
      currentQuantity: roundNumber(currentQuantity, 4),
      reorderPoint: roundNumber(reorderPoint, 4),
      preferredVendor: row.preferred_vendor,
      needsReorder: reorderPoint > 0 && currentQuantity <= reorderPoint,
      latestPrice: latest?.normalizedUnitPrice ?? null,
      latestVendor: latest?.vendor || "",
      latestDate: latest?.date || null,
      priorPrice: prior?.normalizedUnitPrice ?? null,
      priceChangePercent: latest && prior ? percentChange(latest.normalizedUnitPrice || 0, prior.normalizedUnitPrice || 0) : null,
      bestRecentVendor: lowest?.vendor || "",
      bestRecentPrice: lowest?.normalizedUnitPrice ?? null,
      potentialSavingsPerUnit: latest && lowest ? roundNumber(Math.max(0, (latest.normalizedUnitPrice || 0) - (lowest.normalizedUnitPrice || 0)), 4) : 0,
      purchases: normalizedPurchases.slice(0, 12),
    };
  });
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const itemRowsMap = new Map(itemRows.map((item) => [item.id, item]));
  const componentsByRecipe = new Map<string, ComponentRow[]>();
  for (const component of componentRows) {
    const list = componentsByRecipe.get(component.recipe_id) || [];
    list.push(component);
    componentsByRecipe.set(component.recipe_id, list);
  }
  const recipes = recipeRows.map((row) => {
    let totalCost = 0;
    let complete = true;
    const components = (componentsByRecipe.get(row.id) || []).map((component) => {
      const item = itemMap.get(component.inventory_item_id);
      const rawItem = itemRowsMap.get(component.inventory_item_id);
      const converted = rawItem ? convertQuantity(numeric(component.quantity), component.unit, rawItem.base_unit) : null;
      const baseCost = item?.latestPrice ?? null;
      const wasteMultiplier = 1 / Math.max(0.0001, 1 - numeric(component.waste_percent) / 100);
      const cost = converted !== null && baseCost !== null ? roundMoney(converted * baseCost * wasteMultiplier) : null;
      if (cost === null) complete = false;
      else totalCost += cost;
      return {
        id: component.id,
        inventoryItemId: component.inventory_item_id,
        itemName: item?.name || "Missing inventory item",
        quantity: roundNumber(numeric(component.quantity), 4),
        unit: component.unit,
        wastePercent: roundNumber(numeric(component.waste_percent), 2),
        cost,
        compatibleUnits: converted !== null,
      };
    });
    const yieldQuantity = Math.max(0.0001, numeric(row.yield_quantity));
    const unitCost = complete ? roundMoney(totalCost / yieldQuantity) : null;
    const sellingPrice = roundMoney(numeric(row.selling_price));
    return {
      id: row.id,
      productName: row.product_name,
      yieldQuantity,
      sellingPrice,
      totalBatchCost: complete ? roundMoney(totalCost) : null,
      unitCost,
      foodCostPercent: unitCost !== null && sellingPrice > 0 ? roundNumber(unitCost / sellingPrice * 100, 1) : null,
      contributionMargin: unitCost !== null ? roundMoney(sellingPrice - unitCost) : null,
      recommendedPriceAt30Percent: unitCost !== null ? roundMoney(unitCost / 0.3) : null,
      complete,
      components,
    };
  });

  return {
    summary: {
      activeItems: items.length,
      reorderCount: items.filter((item) => item.needsReorder).length,
      priceIncreaseCount: items.filter((item) => (item.priceChangePercent || 0) >= 5).length,
      recipes: recipes.length,
      incompleteRecipes: recipes.filter((recipe) => !recipe.complete).length,
      potentialSavings: roundMoney(items.reduce((sum, item) => sum + item.potentialSavingsPerUnit * Math.max(0, item.parQuantity - item.currentQuantity), 0)),
    },
    items,
    recipes,
  };
}

async function dailyPerformance(business: Business, start: string, end: string) {
  if (business === "Tiki") {
    await ensureSquareControlSchema();
    const [salesRows, laborRows] = await Promise.all([
      getSql()`
        SELECT TO_CHAR((created_at_square AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date, 'YYYY-MM-DD') AS day,
          COUNT(*)::INTEGER AS orders, COALESCE(SUM(total_amount), 0) AS sales
        FROM square_orders
        WHERE state = 'COMPLETED'
          AND created_at_square >= ${start}::date + INTERVAL '4 hours'
          AND created_at_square < ${end}::date + INTERVAL '1 day 4 hours'
        GROUP BY day ORDER BY day
      ` as unknown as Array<Record<string, unknown>>,
      getSql()`
        SELECT TO_CHAR((t.clock_in AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date, 'YYYY-MM-DD') AS day,
          COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.clock_out, NOW()) - t.clock_in)) / 3600), 0) AS labor_hours,
          COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.clock_out, NOW()) - t.clock_in)) / 3600 * COALESCE(e.hourly_rate, 0)), 0) AS labor_cost
        FROM time_entries t
        LEFT JOIN employees e ON e.id = t.employee_id
        WHERE t.business = 'Tiki'
          AND t.clock_in >= ${start}::date + INTERVAL '4 hours'
          AND t.clock_in < ${end}::date + INTERVAL '1 day 4 hours'
        GROUP BY day ORDER BY day
      ` as unknown as Array<Record<string, unknown>>,
    ]);
    return mergeDaily(salesRows, laborRows);
  }

  await ensureRezkuProductSalesSchema();
  const [salesRows, orderRows, laborRows] = await Promise.all([
    getSql()`
      SELECT TO_CHAR(business_date, 'YYYY-MM-DD') AS day, COALESCE(SUM(sales), 0) AS sales
      FROM rezku_product_sales
      WHERE business_date BETWEEN ${start}::date AND ${end}::date
      GROUP BY day ORDER BY day
    ` as unknown as Array<Record<string, unknown>>,
    getSql()`
      SELECT TO_CHAR((opened_at AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date, 'YYYY-MM-DD') AS day,
        COUNT(*)::INTEGER AS orders
      FROM rezku_orders
      WHERE opened_at >= ${start}::date + INTERVAL '4 hours'
        AND opened_at < ${end}::date + INTERVAL '1 day 4 hours'
      GROUP BY day ORDER BY day
    ` as unknown as Array<Record<string, unknown>>,
    getSql()`
      SELECT TO_CHAR((r.clock_in AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date, 'YYYY-MM-DD') AS day,
        COALESCE(SUM(CASE WHEN r.reported_hours > 0 THEN r.reported_hours ELSE EXTRACT(EPOCH FROM (r.clock_out - r.clock_in)) / 3600 END), 0) AS labor_hours,
        COALESCE(SUM((CASE WHEN r.reported_hours > 0 THEN r.reported_hours ELSE EXTRACT(EPOCH FROM (r.clock_out - r.clock_in)) / 3600 END) * COALESCE(e.hourly_rate, 0)), 0) AS labor_cost
      FROM rezku_shifts r
      LEFT JOIN employees e ON e.business = 'Corner Deli' AND LOWER(BTRIM(e.name)) = LOWER(BTRIM(r.employee_name))
      WHERE r.clock_in >= ${start}::date + INTERVAL '4 hours'
        AND r.clock_in < ${end}::date + INTERVAL '1 day 4 hours'
        AND r.clock_in IS NOT NULL AND r.clock_out IS NOT NULL
      GROUP BY day ORDER BY day
    ` as unknown as Array<Record<string, unknown>>,
  ]);
  const sales = mergeDaily(salesRows, laborRows);
  const orderMap = new Map(orderRows.map((row) => [String(row.day), numeric(row.orders)]));
  return sales.map((row) => ({ ...row, orders: orderMap.get(row.date) || 0, ordersPerLaborHour: row.laborHours ? roundNumber((orderMap.get(row.date) || 0) / row.laborHours, 2) : 0 }));
}

function mergeDaily(salesRows: Array<Record<string, unknown>>, laborRows: Array<Record<string, unknown>>) {
  const days = new Map<string, { date: string; sales: number; orders: number; laborHours: number; laborCost: number }>();
  const get = (date: string) => {
    const existing = days.get(date);
    if (existing) return existing;
    const created = { date, sales: 0, orders: 0, laborHours: 0, laborCost: 0 };
    days.set(date, created);
    return created;
  };
  for (const row of salesRows) {
    const day = get(String(row.day));
    day.sales = roundMoney(numeric(row.sales));
    day.orders = Math.round(numeric(row.orders));
  }
  for (const row of laborRows) {
    const day = get(String(row.day));
    day.laborHours = roundNumber(numeric(row.labor_hours), 2);
    day.laborCost = roundMoney(numeric(row.labor_cost));
  }
  return Array.from(days.values()).sort((left, right) => left.date.localeCompare(right.date)).map((row) => ({
    ...row,
    salesPerLaborHour: row.laborHours ? roundMoney(row.sales / row.laborHours) : 0,
    ordersPerLaborHour: row.laborHours ? roundNumber(row.orders / row.laborHours, 2) : 0,
    laborCostPercent: row.sales ? roundNumber(row.laborCost / row.sales * 100, 1) : null,
    weekday: new Date(`${row.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
  }));
}

async function laborDashboard(business: Business, start: string, end: string) {
  const daily = await dailyPerformance(business, start, end);
  const totalSales = roundMoney(daily.reduce((sum, row) => sum + row.sales, 0));
  const totalLaborHours = roundNumber(daily.reduce((sum, row) => sum + row.laborHours, 0), 2);
  const totalLaborCost = roundMoney(daily.reduce((sum, row) => sum + row.laborCost, 0));
  const totalOrders = daily.reduce((sum, row) => sum + row.orders, 0);
  const weekdayMap = new Map<string, typeof daily>();
  for (const row of daily) {
    const list = weekdayMap.get(row.weekday) || [];
    list.push(row);
    weekdayMap.set(row.weekday, list);
  }
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((weekday) => {
    const rows = weekdayMap.get(weekday) || [];
    const sales = rows.reduce((sum, row) => sum + row.sales, 0);
    const laborHours = rows.reduce((sum, row) => sum + row.laborHours, 0);
    const laborCost = rows.reduce((sum, row) => sum + row.laborCost, 0);
    const orders = rows.reduce((sum, row) => sum + row.orders, 0);
    return {
      weekday,
      days: rows.length,
      averageSales: rows.length ? roundMoney(sales / rows.length) : 0,
      averageLaborHours: rows.length ? roundNumber(laborHours / rows.length, 2) : 0,
      salesPerLaborHour: laborHours ? roundMoney(sales / laborHours) : 0,
      laborCostPercent: sales ? roundNumber(laborCost / sales * 100, 1) : null,
      ordersPerLaborHour: laborHours ? roundNumber(orders / laborHours, 2) : 0,
    };
  });
  const productiveDays = daily.filter((row) => row.laborHours > 0 && row.sales > 0);
  const averageProductivity = productiveDays.length ? productiveDays.reduce((sum, row) => sum + row.salesPerLaborHour, 0) / productiveDays.length : 0;
  const exceptions = productiveDays
    .filter((row) => row.salesPerLaborHour < averageProductivity * 0.7 || (row.laborCostPercent || 0) > 35)
    .sort((left, right) => left.salesPerLaborHour - right.salesPerLaborHour)
    .slice(0, 15)
    .map((row) => ({
      ...row,
      reason: (row.laborCostPercent || 0) > 35
        ? `Labor cost was ${row.laborCostPercent}% of sales.`
        : `Sales per labor hour were ${roundNumber((1 - row.salesPerLaborHour / Math.max(1, averageProductivity)) * 100, 1)}% below the period average.`,
    }));
  return {
    summary: {
      totalSales,
      totalOrders,
      totalLaborHours,
      totalLaborCost,
      salesPerLaborHour: totalLaborHours ? roundMoney(totalSales / totalLaborHours) : 0,
      ordersPerLaborHour: totalLaborHours ? roundNumber(totalOrders / totalLaborHours, 2) : 0,
      laborCostPercent: totalSales ? roundNumber(totalLaborCost / totalSales * 100, 1) : null,
    },
    daily,
    weekdays,
    exceptions,
  };
}

async function productProfitability(business: Business, start: string, end: string, recipes: Awaited<ReturnType<typeof inventoryDashboard>>["recipes"]) {
  const recipeMap = new Map(recipes.map((recipe) => [normalized(recipe.productName), recipe]));
  let productRows: Array<Record<string, unknown>> = [];
  let daypartRows: Array<Record<string, unknown>> = [];
  let daypartCoverage: "Sales" | "Orders only" = "Sales";
  if (business === "Tiki") {
    await ensureSquareControlSchema();
    [productRows, daypartRows] = await Promise.all([
      getSql()`
        SELECT COALESCE(NULLIF(l.item_name, ''), NULLIF(l.variation_name, ''), 'Unnamed item') AS product,
          COALESCE(SUM(l.quantity), 0) AS quantity, COALESCE(SUM(l.total_money), 0) AS sales
        FROM square_order_lines l
        JOIN square_orders o ON o.id = l.square_order_id
        WHERE o.state = 'COMPLETED'
          AND o.created_at_square >= ${start}::date + INTERVAL '4 hours'
          AND o.created_at_square < ${end}::date + INTERVAL '1 day 4 hours'
        GROUP BY product ORDER BY SUM(l.total_money) DESC
        LIMIT 250
      ` as unknown as Array<Record<string, unknown>>,
      getSql()`
        SELECT CASE
          WHEN EXTRACT(HOUR FROM created_at_square AT TIME ZONE 'America/New_York') BETWEEN 4 AND 10 THEN 'Morning'
          WHEN EXTRACT(HOUR FROM created_at_square AT TIME ZONE 'America/New_York') BETWEEN 11 AND 15 THEN 'Lunch'
          WHEN EXTRACT(HOUR FROM created_at_square AT TIME ZONE 'America/New_York') BETWEEN 16 AND 20 THEN 'Dinner'
          ELSE 'Late night' END AS daypart,
          COUNT(*)::INTEGER AS orders, COALESCE(SUM(total_amount), 0) AS sales
        FROM square_orders
        WHERE state = 'COMPLETED'
          AND created_at_square >= ${start}::date + INTERVAL '4 hours'
          AND created_at_square < ${end}::date + INTERVAL '1 day 4 hours'
        GROUP BY daypart
      ` as unknown as Array<Record<string, unknown>>,
    ]);
  } else {
    await ensureRezkuProductSalesSchema();
    productRows = await getSql()`
      SELECT product, COALESCE(SUM(quantity), 0) AS quantity, COALESCE(SUM(sales), 0) AS sales
      FROM rezku_product_sales
      WHERE business_date BETWEEN ${start}::date AND ${end}::date
      GROUP BY product ORDER BY SUM(sales) DESC
      LIMIT 250
    ` as unknown as Array<Record<string, unknown>>;
    daypartRows = await getSql()`
      SELECT CASE
        WHEN EXTRACT(HOUR FROM opened_at AT TIME ZONE 'America/New_York') BETWEEN 4 AND 10 THEN 'Morning'
        WHEN EXTRACT(HOUR FROM opened_at AT TIME ZONE 'America/New_York') BETWEEN 11 AND 15 THEN 'Lunch'
        WHEN EXTRACT(HOUR FROM opened_at AT TIME ZONE 'America/New_York') BETWEEN 16 AND 20 THEN 'Dinner'
        ELSE 'Late night' END AS daypart,
        COUNT(*)::INTEGER AS orders, 0::numeric AS sales
      FROM rezku_orders
      WHERE opened_at >= ${start}::date + INTERVAL '4 hours'
        AND opened_at < ${end}::date + INTERVAL '1 day 4 hours'
      GROUP BY daypart
    ` as unknown as Array<Record<string, unknown>>;
    daypartCoverage = "Orders only";
  }
  const products = productRows.map((row) => {
    const product = clean(row.product, 220) || "Unnamed item";
    const quantity = numeric(row.quantity);
    const sales = roundMoney(numeric(row.sales));
    const recipe = recipeMap.get(normalized(product)) || null;
    const estimatedCost = recipe?.unitCost !== null && recipe?.unitCost !== undefined ? roundMoney(recipe.unitCost * quantity) : null;
    const contribution = estimatedCost !== null ? roundMoney(sales - estimatedCost) : null;
    return {
      product,
      quantity: roundNumber(quantity, 2),
      sales,
      averagePrice: quantity ? roundMoney(sales / quantity) : 0,
      recipeId: recipe?.id || null,
      recipeCost: recipe?.unitCost ?? null,
      estimatedCost,
      contribution,
      marginPercent: contribution !== null && sales ? roundNumber(contribution / sales * 100, 1) : null,
      costCoverage: recipe?.complete ? "Complete" : recipe ? "Incomplete recipe" : "No recipe",
    };
  });
  return {
    summary: {
      products: products.length,
      sales: roundMoney(products.reduce((sum, product) => sum + product.sales, 0)),
      estimatedCost: roundMoney(products.reduce((sum, product) => sum + (product.estimatedCost || 0), 0)),
      contribution: roundMoney(products.reduce((sum, product) => sum + (product.contribution || 0), 0)),
      recipeCoveragePercent: products.length ? roundNumber(products.filter((product) => product.costCoverage === "Complete").length / products.length * 100, 1) : 0,
    },
    products,
    dayparts: ["Morning", "Lunch", "Dinner", "Late night"].map((daypart) => {
      const row = daypartRows.find((item) => String(item.daypart) === daypart);
      return { daypart, orders: Math.round(numeric(row?.orders)), sales: roundMoney(numeric(row?.sales)) };
    }),
    daypartCoverage,
  };
}

function buildBriefing(input: {
  business: Business;
  bills: Awaited<ReturnType<typeof billDashboard>>;
  inventory: Awaited<ReturnType<typeof inventoryDashboard>>;
  labor: Awaited<ReturnType<typeof laborDashboard>>;
  profitability: Awaited<ReturnType<typeof productProfitability>>;
  forecast: Awaited<ReturnType<typeof thirteenWeekCashForecast>>;
  statements: Awaited<ReturnType<typeof financialStatements>>;
  openIssues: Array<Record<string, unknown>>;
}) {
  const actions: Array<{ priority: "Critical" | "Warning" | "Opportunity" | "Info"; title: string; detail: string; href: string }> = [];
  if (input.forecast.summary.firstBelowMinimumWeek) actions.push({
    priority: "Critical",
    title: "Cash is projected below the minimum",
    detail: `The 13-week forecast first falls below the selected minimum in the week ending ${input.forecast.summary.firstBelowMinimumWeek}.`,
    href: "/ops/finance-operations#forecast",
  });
  if (input.bills.summary.overdueCount) actions.push({
    priority: "Critical",
    title: `${input.bills.summary.overdueCount} overdue bill${input.bills.summary.overdueCount === 1 ? "" : "s"}`,
    detail: `${input.bills.summary.overdue.toLocaleString("en-US", { style: "currency", currency: "USD" })} is past due.`,
    href: "/ops/finance-operations#bills",
  });
  if (input.inventory.summary.reorderCount) actions.push({
    priority: "Warning",
    title: `${input.inventory.summary.reorderCount} inventory item${input.inventory.summary.reorderCount === 1 ? "" : "s"} at reorder level`,
    detail: "Review current quantities before the next purchasing cycle.",
    href: "/ops/finance-operations#inventory",
  });
  if (input.inventory.summary.priceIncreaseCount) actions.push({
    priority: "Opportunity",
    title: `${input.inventory.summary.priceIncreaseCount} ingredient price increase${input.inventory.summary.priceIncreaseCount === 1 ? "" : "s"}`,
    detail: `Recent vendor comparisons indicate about ${input.inventory.summary.potentialSavings.toLocaleString("en-US", { style: "currency", currency: "USD" })} in replenishment savings at current par levels.`,
    href: "/ops/finance-operations#inventory",
  });
  if (input.labor.exceptions.length) actions.push({
    priority: "Warning",
    title: `${input.labor.exceptions.length} low-productivity labor day${input.labor.exceptions.length === 1 ? "" : "s"}`,
    detail: "Review the flagged dates and weekday staffing patterns before publishing the next schedule.",
    href: "/ops/finance-operations#labor",
  });
  if (input.profitability.summary.recipeCoveragePercent < 80) actions.push({
    priority: "Opportunity",
    title: "Recipe coverage is incomplete",
    detail: `${input.profitability.summary.recipeCoveragePercent}% of sold products have complete costed recipes. Product margin remains estimated until coverage improves.`,
    href: "/ops/finance-operations#profitability",
  });
  if (!input.statements.balanceSheet.balanced) actions.push({
    priority: "Critical",
    title: "Balance sheet is out of balance",
    detail: `Assets differ from liabilities plus equity by ${input.statements.balanceSheet.balanceDifference.toLocaleString("en-US", { style: "currency", currency: "USD" })}.`,
    href: "/ops/finance-operations#statements",
  });
  for (const issue of input.openIssues.slice(0, 6)) actions.push({
    priority: String(issue.severity) === "Error" ? "Critical" : "Warning",
    title: clean(issue.title, 180),
    detail: clean(issue.details, 400),
    href: String(issue.issue_type) === "Overtime Risk" ? "/ops/overtime" : "/ops/finance-operations",
  });
  if (!actions.length) actions.push({
    priority: "Info",
    title: "No immediate exceptions",
    detail: "Cash, bills, labor, inventory, and the ledger do not currently show a threshold exception. This is suspiciously civilized.",
    href: "/ops/finance-operations",
  });
  return {
    generatedAt: new Date().toISOString(),
    headline: {
      currentCash: input.forecast.summary.currentCash,
      forecastEndingCash: input.forecast.summary.endingCash,
      openBills: input.bills.summary.totalOpen,
      netIncome: input.statements.profitAndLoss.netIncome,
      laborCostPercent: input.labor.summary.laborCostPercent,
      contribution: input.profitability.summary.contribution,
    },
    actions: actions.sort((left, right) => {
      const rank = { Critical: 3, Warning: 2, Opportunity: 1, Info: 0 };
      return rank[right.priority] - rank[left.priority];
    }).slice(0, 12),
  };
}

export async function financeOperationsDashboard(input: {
  business: Business;
  start: string;
  end: string;
  salesAdjustmentPercent?: number;
  expenseAdjustmentPercent?: number;
  minimumCash?: number;
}) {
  await ensureFinanceOperationsSchema();
  const start = validDate(input.start, "Start date");
  const end = validDate(input.end, "End date");
  if (end < start) throw new Error("End date must not precede start date.");
  const [bills, inventory, labor, forecast, statements, openIssues] = await Promise.all([
    billDashboard(input.business),
    inventoryDashboard(input.business),
    laborDashboard(input.business, start, end),
    thirteenWeekCashForecast({
      business: input.business,
      salesAdjustmentPercent: input.salesAdjustmentPercent,
      expenseAdjustmentPercent: input.expenseAdjustmentPercent,
      minimumCash: input.minimumCash,
    }),
    financialStatements({ business: input.business, start, end }),
    getSql()`
      SELECT issue_type, severity, title, details, last_seen_at
      FROM operation_issues
      WHERE business = ${input.business} AND status = 'Open'
      ORDER BY CASE severity WHEN 'Error' THEN 0 ELSE 1 END, last_seen_at DESC
      LIMIT 20
    ` as unknown as Array<Record<string, unknown>>,
  ]);
  const profitability = await productProfitability(input.business, start, end, inventory.recipes);
  const briefing = buildBriefing({ business: input.business, bills, inventory, labor, profitability, forecast, statements, openIssues });
  return {
    business: input.business,
    range: { start, end },
    generatedAt: new Date().toISOString(),
    briefing,
    forecast,
    bills,
    inventory,
    labor,
    profitability,
    statements,
  };
}
