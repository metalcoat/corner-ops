import { getSql } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { ensureFinanceOperationsSchema } from "@/lib/finance-operations-schema";
import type { Business } from "@/lib/types";

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown): number {
  return Math.round(Math.max(0, numeric(value)) * 100) / 100;
}

function quantity(value: unknown): number {
  return Math.round(Math.max(0, numeric(value)) * 10_000) / 10_000;
}

function validDate(value: unknown, label: string): string {
  const text = clean(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must use YYYY-MM-DD.`);
  return text;
}

export type BillLineInput = {
  inventoryItemId?: string | null;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
};

export async function createVendorBill(input: {
  business: Business;
  vendor: string;
  invoiceNumber?: string;
  invoiceDate: string;
  dueDate: string;
  subtotal?: number;
  taxAmount?: number;
  totalAmount: number;
  category?: string;
  accountCode?: string;
  notes?: string;
  fileName?: string;
  contentType?: string;
  blobUrl?: string;
  blobPathname?: string;
  lines?: BillLineInput[];
  actor: string;
}) {
  await ensureFinanceOperationsSchema();
  const vendor = clean(input.vendor, 180);
  if (!vendor) throw new Error("Vendor is required.");
  const invoiceNumber = clean(input.invoiceNumber, 100);
  const invoiceDate = validDate(input.invoiceDate, "Invoice date");
  const dueDate = validDate(input.dueDate, "Due date");
  const totalAmount = money(input.totalAmount);
  if (totalAmount <= 0) throw new Error("Bill total must be greater than zero.");
  const taxAmount = money(input.taxAmount);
  const subtotal = money(input.subtotal) || money(totalAmount - taxAmount);
  const lines = (input.lines || []).map((line) => {
    const lineQuantity = quantity(line.quantity) || 1;
    const unitPrice = Math.round(Math.max(0, numeric(line.unitPrice)) * 10_000) / 10_000;
    return {
      inventoryItemId: clean(line.inventoryItemId, 80) || null,
      description: clean(line.description, 300),
      quantity: lineQuantity,
      unit: clean(line.unit, 40) || "each",
      unitPrice,
      lineTotal: money(lineQuantity * unitPrice),
    };
  }).filter((line) => line.description && line.lineTotal >= 0);

  if (invoiceNumber) {
    const duplicate = await getSql()`
      SELECT id, status, total_amount
      FROM vendor_bills
      WHERE business = ${input.business}
        AND LOWER(vendor) = LOWER(${vendor})
        AND invoice_number = ${invoiceNumber}
        AND status <> 'Void'
      LIMIT 1
    ` as unknown as Array<{ id: string; status: string; total_amount: string | number }>;
    if (duplicate[0]) {
      throw new Error(`${vendor} invoice ${invoiceNumber} already exists as a ${duplicate[0].status.toLowerCase()} bill for $${Number(duplicate[0].total_amount).toFixed(2)}.`);
    }
  }

  const inventoryChecks = await Promise.all(lines.map(async (line, index) => {
    if (!line.inventoryItemId) return null;
    const item = await getSql()`
      SELECT id FROM inventory_items
      WHERE id = ${line.inventoryItemId} AND business = ${input.business} AND active = TRUE
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (!item[0]) throw new Error(`Inventory item on line ${index + 1} was not found for ${input.business}.`);
    return item[0].id;
  }));
  void inventoryChecks;

  const id = crypto.randomUUID();
  const sql = getSql();
  const queries = [
    sql`
      INSERT INTO vendor_bills (
        id, business, vendor, invoice_number, invoice_date, due_date, subtotal, tax_amount,
        total_amount, category, account_code, status, notes, file_name, content_type,
        blob_url, blob_pathname, created_by
      ) VALUES (
        ${id}, ${input.business}, ${vendor}, ${invoiceNumber}, ${invoiceDate}, ${dueDate},
        ${subtotal}, ${taxAmount}, ${totalAmount}, ${clean(input.category, 120) || "Other Expense"},
        ${clean(input.accountCode, 20) || "5900"}, 'Open', ${clean(input.notes, 1500)},
        ${clean(input.fileName, 255)}, ${clean(input.contentType, 160)}, ${clean(input.blobUrl, 1000)},
        ${clean(input.blobPathname, 1000)}, ${clean(input.actor, 240)}
      )
    `,
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    queries.push(sql`
      INSERT INTO vendor_bill_lines (
        id, bill_id, line_number, inventory_item_id, description, quantity, unit, unit_price, line_total
      ) VALUES (
        ${crypto.randomUUID()}, ${id}, ${index + 1}, ${line.inventoryItemId}, ${line.description},
        ${line.quantity}, ${line.unit}, ${line.unitPrice}, ${line.lineTotal}
      )
    `);
    if (line.inventoryItemId && line.unitPrice > 0) {
      queries.push(sql`
        INSERT INTO inventory_purchases (
          id, business, inventory_item_id, vendor, purchase_date, quantity, unit,
          unit_price, total_amount, bill_id, source
        ) VALUES (
          ${crypto.randomUUID()}, ${input.business}, ${line.inventoryItemId}, ${vendor}, ${invoiceDate},
          ${line.quantity}, ${line.unit}, ${line.unitPrice}, ${line.lineTotal}, ${id}, 'Vendor bill'
        )
      `);
      queries.push(sql`
        UPDATE inventory_items SET
          current_quantity = current_quantity + ${line.quantity},
          preferred_vendor = CASE WHEN preferred_vendor = '' THEN ${vendor} ELSE preferred_vendor END,
          updated_at = NOW()
        WHERE id = ${line.inventoryItemId} AND business = ${input.business}
      `);
    }
  }
  await sql.transaction(queries);

  return { id, created: true, lines: lines.length, totalAmount };
}

export async function updateVendorBillStatus(input: {
  business: Business;
  billId: string;
  status: "Open" | "Paid" | "Void";
  bankTransactionId?: string | null;
  actor: string;
}) {
  await ensureFinanceOperationsSchema();
  const rows = await getSql()`
    SELECT id, total_amount, status
    FROM vendor_bills
    WHERE id = ${input.billId} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<{ id: string; total_amount: string | number; status: string }>;
  const bill = rows[0];
  if (!bill) throw new Error("Bill was not found.");
  let bankTransactionId = clean(input.bankTransactionId, 80) || null;
  if (input.status === "Paid" && bankTransactionId) {
    const matches = await getSql()`
      SELECT id, signed_amount
      FROM bank_transactions
      WHERE id = ${bankTransactionId} AND business = ${input.business} AND removed = FALSE
      LIMIT 1
    ` as unknown as Array<{ id: string; signed_amount: string | number }>;
    if (!matches[0]) throw new Error("The selected bank transaction was not found.");
    const difference = Math.abs(Math.abs(Number(matches[0].signed_amount)) - Number(bill.total_amount));
    if (difference > 0.01) throw new Error("The bank transaction amount does not equal the bill total.");
  }
  if (input.status !== "Paid") bankTransactionId = null;
  await getSql()`
    UPDATE vendor_bills SET
      status = ${input.status}, paid_bank_transaction_id = ${bankTransactionId}, updated_at = NOW()
    WHERE id = ${input.billId} AND business = ${input.business}
  `;
  await recordAuditEvent({ business: input.business, entityType: "vendor_bill", entityId: input.billId, action: `status_${input.status.toLowerCase()}`, actor: input.actor, details: { priorStatus: bill.status, bankTransactionId } });
  return { updated: true, status: input.status };
}

export async function createInventoryItem(input: {
  business: Business;
  name: string;
  category?: string;
  baseUnit?: string;
  parQuantity?: number;
  currentQuantity?: number;
  reorderPoint?: number;
  preferredVendor?: string;
}) {
  await ensureFinanceOperationsSchema();
  const name = clean(input.name, 180);
  if (!name) throw new Error("Inventory item name is required.");
  const rows = await getSql()`
    INSERT INTO inventory_items (
      id, business, name, category, base_unit, par_quantity, current_quantity,
      reorder_point, preferred_vendor
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${name}, ${clean(input.category, 120)},
      ${clean(input.baseUnit, 40) || "each"}, ${quantity(input.parQuantity)},
      ${quantity(input.currentQuantity)}, ${quantity(input.reorderPoint)}, ${clean(input.preferredVendor, 180)}
    )
    ON CONFLICT (business, name) DO UPDATE SET
      category = EXCLUDED.category,
      base_unit = EXCLUDED.base_unit,
      par_quantity = EXCLUDED.par_quantity,
      reorder_point = EXCLUDED.reorder_point,
      preferred_vendor = CASE WHEN EXCLUDED.preferred_vendor = '' THEN inventory_items.preferred_vendor ELSE EXCLUDED.preferred_vendor END,
      active = TRUE,
      updated_at = NOW()
    RETURNING id, name
  ` as unknown as Array<{ id: string; name: string }>;
  return rows[0];
}

export async function recordInventoryPurchase(input: {
  business: Business;
  inventoryItemId: string;
  vendor: string;
  purchaseDate: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  source?: string;
}) {
  await ensureFinanceOperationsSchema();
  const itemRows = await getSql()`
    SELECT id, name FROM inventory_items
    WHERE id = ${input.inventoryItemId} AND business = ${input.business} AND active = TRUE
    LIMIT 1
  ` as unknown as Array<{ id: string; name: string }>;
  if (!itemRows[0]) throw new Error("Inventory item was not found.");
  const purchaseQuantity = quantity(input.quantity);
  const unitPrice = Math.round(Math.max(0, numeric(input.unitPrice)) * 10_000) / 10_000;
  if (purchaseQuantity <= 0) throw new Error("Purchase quantity must be greater than zero.");
  if (unitPrice <= 0) throw new Error("Unit price must be greater than zero.");
  const total = money(purchaseQuantity * unitPrice);
  await getSql()`
    INSERT INTO inventory_purchases (
      id, business, inventory_item_id, vendor, purchase_date, quantity, unit,
      unit_price, total_amount, source
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.inventoryItemId}, ${clean(input.vendor, 180) || "Unknown vendor"},
      ${validDate(input.purchaseDate, "Purchase date")}, ${purchaseQuantity}, ${clean(input.unit, 40) || "each"},
      ${unitPrice}, ${total}, ${clean(input.source, 80) || "Manual"}
    )
  `;
  await getSql()`
    UPDATE inventory_items SET
      current_quantity = current_quantity + ${purchaseQuantity},
      preferred_vendor = CASE WHEN preferred_vendor = '' THEN ${clean(input.vendor, 180)} ELSE preferred_vendor END,
      updated_at = NOW()
    WHERE id = ${input.inventoryItemId} AND business = ${input.business}
  `;
  return { recorded: true, item: itemRows[0].name, total };
}

export async function adjustInventoryQuantity(input: {
  business: Business;
  inventoryItemId: string;
  currentQuantity: number;
  actor: string;
}) {
  await ensureFinanceOperationsSchema();
  const rows = await getSql()`
    UPDATE inventory_items SET current_quantity = ${quantity(input.currentQuantity)}, updated_at = NOW()
    WHERE id = ${input.inventoryItemId} AND business = ${input.business}
    RETURNING id, name, current_quantity
  ` as unknown as Array<{ id: string; name: string; current_quantity: string | number }>;
  if (!rows[0]) throw new Error("Inventory item was not found.");
  await recordAuditEvent({ business: input.business, entityType: "inventory_item", entityId: rows[0].id, action: "quantity_adjusted", actor: input.actor, details: { currentQuantity: Number(rows[0].current_quantity) } });
  return { id: rows[0].id, name: rows[0].name, currentQuantity: Number(rows[0].current_quantity) };
}

export async function createRecipe(input: {
  business: Business;
  productName: string;
  yieldQuantity?: number;
  sellingPrice?: number;
}) {
  await ensureFinanceOperationsSchema();
  const productName = clean(input.productName, 220);
  if (!productName) throw new Error("Recipe product name is required.");
  const rows = await getSql()`
    INSERT INTO recipes (id, business, product_name, yield_quantity, selling_price)
    VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${productName},
      ${Math.max(0.0001, quantity(input.yieldQuantity) || 1)}, ${money(input.sellingPrice)}
    )
    ON CONFLICT (business, product_name) DO UPDATE SET
      yield_quantity = EXCLUDED.yield_quantity,
      selling_price = EXCLUDED.selling_price,
      active = TRUE,
      updated_at = NOW()
    RETURNING id, product_name
  ` as unknown as Array<{ id: string; product_name: string }>;
  return { id: rows[0].id, productName: rows[0].product_name };
}

export async function addRecipeComponent(input: {
  business: Business;
  recipeId: string;
  inventoryItemId: string;
  quantity: number;
  unit: string;
  wastePercent?: number;
}) {
  await ensureFinanceOperationsSchema();
  const rows = await getSql()`
    SELECT r.id
    FROM recipes r
    JOIN inventory_items i ON i.id = ${input.inventoryItemId} AND i.business = r.business
    WHERE r.id = ${input.recipeId} AND r.business = ${input.business}
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Recipe or inventory item was not found for this business.");
  const componentQuantity = quantity(input.quantity);
  if (componentQuantity <= 0) throw new Error("Recipe quantity must be greater than zero.");
  const wastePercent = Math.max(0, Math.min(99.99, numeric(input.wastePercent)));
  await getSql()`
    INSERT INTO recipe_components (id, recipe_id, inventory_item_id, quantity, unit, waste_percent)
    VALUES (
      ${crypto.randomUUID()}, ${input.recipeId}, ${input.inventoryItemId}, ${componentQuantity},
      ${clean(input.unit, 40) || "each"}, ${wastePercent}
    )
    ON CONFLICT (recipe_id, inventory_item_id) DO UPDATE SET
      quantity = EXCLUDED.quantity,
      unit = EXCLUDED.unit,
      waste_percent = EXCLUDED.waste_percent
  `;
  return { saved: true };
}

export async function removeRecipeComponent(input: {
  business: Business;
  recipeId: string;
  componentId: string;
}) {
  await ensureFinanceOperationsSchema();
  const rows = await getSql()`
    DELETE FROM recipe_components c
    USING recipes r
    WHERE c.id = ${input.componentId} AND c.recipe_id = r.id
      AND r.id = ${input.recipeId} AND r.business = ${input.business}
    RETURNING c.id
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Recipe component was not found.");
  return { removed: true };
}

export async function createForecastEvent(input: {
  business: Business;
  eventDate: string;
  description: string;
  amount: number;
  direction: "Inflow" | "Outflow";
  recurrence?: "None" | "Weekly" | "Monthly";
  actor: string;
}) {
  await ensureFinanceOperationsSchema();
  const description = clean(input.description, 300);
  if (!description) throw new Error("Forecast event description is required.");
  const amount = money(input.amount);
  if (amount <= 0) throw new Error("Forecast event amount must be greater than zero.");
  const recurrence = input.recurrence === "Weekly" || input.recurrence === "Monthly" ? input.recurrence : "None";
  const rows = await getSql()`
    INSERT INTO forecast_events (
      id, business, event_date, description, amount, direction, recurrence, created_by
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${validDate(input.eventDate, "Event date")},
      ${description}, ${amount}, ${input.direction}, ${recurrence}, ${clean(input.actor, 240)}
    ) RETURNING id
  ` as unknown as Array<{ id: string }>;
  return { id: rows[0].id, created: true };
}

export async function deleteForecastEvent(input: { business: Business; eventId: string }) {
  await ensureFinanceOperationsSchema();
  const rows = await getSql()`
    UPDATE forecast_events SET active = FALSE, updated_at = NOW()
    WHERE id = ${input.eventId} AND business = ${input.business}
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Forecast event was not found.");
  return { deleted: true };
}
