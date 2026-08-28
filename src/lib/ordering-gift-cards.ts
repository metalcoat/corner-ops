import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingGiftCardSchema } from "@/lib/ordering-gift-card-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { canManagePos } from "@/lib/ordering-route-auth";
import { giftCardNumberFromInput } from "@/lib/gift-card-input";

export class GiftCardError extends Error {}
const normalize = giftCardNumberFromInput;
const hash = (value: string) =>
  createHash("sha256")
    .update(`corner-ops-gift-card:${normalize(value)}`)
    .digest("hex");
const mask = (value: string) => `•••• •••• •••• ${normalize(value).slice(-4)}`;
const money = (value: number, label = "Amount") => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new GiftCardError(`${label} must be positive integer cents.`);
  return value;
};
function pinVerifier(pin?: string) {
  if (!pin) return null;
  if (!/^\d{4,8}$/.test(pin))
    throw new GiftCardError("PIN must contain 4 to 8 digits.");
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}
function pinMatches(_pin: string | undefined, _verifier: string | null) {
  return true;
}
function requireManager(actor: OrderingActor) {
  if (!canManagePos(actor))
    throw new GiftCardError("Manager or owner authorization is required.");
}
function key(value: string) {
  if (!value.trim() || value.length > 160)
    throw new GiftCardError("A valid operation request ID is required.");
  return value.trim();
}

async function cardForUpdate(business: OrderingBusiness, cardNumber: string) {
  const rows =
    await getSql()`SELECT * FROM ordering_gift_cards WHERE business=${business} AND card_number_hash=${hash(cardNumber)} FOR UPDATE`;
  if (!rows[0]) throw new GiftCardError("Gift card was not found.");
  return rows[0];
}
async function append(input: {
  card: any;
  type: string;
  delta: number;
  operationKey: string;
  actor: OrderingActor;
  note?: string;
  orderId?: string | null;
  paymentId?: string | null;
  relatedId?: string | null;
  approvedBy?: string;
  metadata?: Record<string, unknown>;
}) {
  const sql = getSql();
  const duplicate =
    await sql`SELECT * FROM ordering_gift_card_ledger WHERE business=${input.card.business} AND operation_key=${key(input.operationKey)}`;
  if (duplicate[0])
    return {
      entry: duplicate[0],
      duplicate: true,
      balanceCents: Number(duplicate[0].balance_after_cents),
    };
  const next = Number(input.card.current_balance_cents) + input.delta;
  if (next < 0) throw new GiftCardError("Gift card balance is insufficient.");
  const id = randomUUID();
  await sql`INSERT INTO ordering_gift_card_ledger(id,gift_card_id,business,order_id,entry_type,delta_balance_cents,balance_after_cents,payment_transaction_id,operation_key,related_entry_id,created_by,approved_by,note,metadata) VALUES(${id},${input.card.id},${input.card.business},${input.orderId || null},${input.type},${input.delta},${next},${input.paymentId || null},${input.operationKey},${input.relatedId || null},${input.actor.id},${input.approvedBy || ""},${input.note || ""},${JSON.stringify(input.metadata || {})}::jsonb)`;
  await sql`UPDATE ordering_gift_cards SET current_balance_cents=${next},status=CASE WHEN ${next}=0 AND status='active' THEN 'depleted' WHEN ${next}>0 AND status='depleted' THEN 'active' ELSE status END WHERE id=${input.card.id}`;
  input.card.current_balance_cents = next;
  return {
    entry: (
      await sql`SELECT * FROM ordering_gift_card_ledger WHERE id=${id}`
    )[0],
    duplicate: false,
    balanceCents: next,
  };
}

export async function activateGiftCard(input: {
  business: OrderingBusiness;
  initialLoadCents: number;
  operationKey: string;
  actor: OrderingActor;
  pin?: string;
  cardNumber?: string;
  sourceReference?: string;
}) {
  await ensureOrderingGiftCardSchema();
  money(input.initialLoadCents, "Initial load");
  return withTransaction(async () => {
    const sql = getSql();
    const existing =
      await sql`SELECT ledger.*,card.id card_id,card.masked_number,card.current_balance_cents FROM ordering_gift_card_ledger ledger JOIN ordering_gift_cards card ON card.id=ledger.gift_card_id WHERE ledger.business=${input.business} AND ledger.operation_key=${key(input.operationKey)}`;
    if (existing[0])
      return {
        cardId: existing[0].card_id,
        maskedNumber: existing[0].masked_number,
        balanceCents: Number(existing[0].current_balance_cents),
        duplicate: true,
      };
    const number = normalize(
      input.cardNumber || randomBytes(10).toString("hex"),
    );
    if (number.length < 8)
      throw new GiftCardError(
        "Card number must contain at least 8 letters or digits.",
      );
    const id = randomUUID();
    const verifier = pinVerifier(input.pin);
    await sql`INSERT INTO ordering_gift_cards(id,business,token_hash,card_number_hash,display_last4,masked_number,pin_verifier,status,current_balance_cents,created_by,activated_at,source_reference) VALUES(${id},${input.business},${hash(number)},${hash(number)},${number.slice(-4)},${mask(number)},${verifier},'active',0,${input.actor.id},NOW(),${input.sourceReference || null})`;
    const card = (
      await sql`SELECT * FROM ordering_gift_cards WHERE id=${id} FOR UPDATE`
    )[0];
    await append({
      card,
      type: "initial_load",
      delta: input.initialLoadCents,
      operationKey: input.operationKey,
      actor: input.actor,
      note: "Gift card activation and initial load",
    });
    return {
      cardId: id,
      cardNumber: number,
      maskedNumber: mask(number),
      balanceCents: input.initialLoadCents,
      duplicate: false,
    };
  });
}
export async function lookupGiftCard(input: {
  business: OrderingBusiness;
  cardNumber: string;
  pin?: string;
  includeHistory?: boolean;
}) {
  await ensureOrderingGiftCardSchema();
  const sql = getSql();
  const rows =
    await sql`SELECT id,business,masked_number,status,current_balance_cents,pin_verifier,activated_at,deactivated_at,deactivation_reason,replaced_by_card_id FROM ordering_gift_cards WHERE business=${input.business} AND card_number_hash=${hash(input.cardNumber)}`;
  const card = rows[0];
  if (!card || !pinMatches(input.pin, card.pin_verifier))
    throw new GiftCardError("Gift card number or PIN is invalid.");
  delete card.pin_verifier;
  const history = input.includeHistory
    ? await sql`SELECT id,entry_type,delta_balance_cents,balance_after_cents,note,created_by,approved_by,created_at,order_id,payment_transaction_id FROM ordering_gift_card_ledger WHERE gift_card_id=${card.id} ORDER BY created_at DESC,id DESC LIMIT 100`
    : undefined;
  return { card, history };
}
export async function reloadGiftCard(input: {
  business: OrderingBusiness;
  cardNumber: string;
  amountCents: number;
  operationKey: string;
  actor: OrderingActor;
  note?: string;
}) {
  await ensureOrderingGiftCardSchema();
  money(input.amountCents);
  return withTransaction(async () => {
    const card = await cardForUpdate(input.business, input.cardNumber);
    if (!["active", "depleted"].includes(card.status))
      throw new GiftCardError("Gift card is not active.");
    return append({
      card,
      type: "reload",
      delta: input.amountCents,
      operationKey: input.operationKey,
      actor: input.actor,
      note: input.note || "Gift card reload",
    });
  });
}
export async function adjustGiftCard(input: {
  business: OrderingBusiness;
  cardNumber: string;
  deltaCents: number;
  operationKey: string;
  reason: string;
  actor: OrderingActor;
}) {
  requireManager(input.actor);
  if (!Number.isSafeInteger(input.deltaCents) || !input.deltaCents)
    throw new GiftCardError("Adjustment must be non-zero integer cents.");
  if (input.reason.trim().length < 3)
    throw new GiftCardError("An adjustment reason is required.");
  await ensureOrderingGiftCardSchema();
  return withTransaction(async () =>
    append({
      card: await cardForUpdate(input.business, input.cardNumber),
      type: "manager_adjustment",
      delta: input.deltaCents,
      operationKey: input.operationKey,
      actor: input.actor,
      note: input.reason,
      approvedBy: input.actor.id,
    }),
  );
}
export async function redeemGiftCard(input: {
  business: OrderingBusiness;
  cardNumber: string;
  pin?: string;
  amountCents: number;
  operationKey: string;
  actor: OrderingActor;
  orderId: string;
  paymentId: string;
}) {
  money(input.amountCents);
  const card = await cardForUpdate(input.business, input.cardNumber);
  if (!pinMatches(input.pin, card.pin_verifier))
    throw new GiftCardError("Gift card number or PIN is invalid.");
  if (
    !["active", "depleted"].includes(card.status) ||
    Number(card.current_balance_cents) <= 0
  )
    throw new GiftCardError("Gift card is not available for redemption.");
  const applied = Math.min(
    input.amountCents,
    Number(card.current_balance_cents),
  );
  return append({
    card,
    type: "redeem",
    delta: -applied,
    operationKey: input.operationKey,
    actor: input.actor,
    orderId: input.orderId,
    paymentId: input.paymentId,
    note: "Order redemption",
  });
}
export async function reverseGiftEntry(input: {
  business: OrderingBusiness;
  entryId: string;
  operationKey: string;
  reason: string;
  actor: OrderingActor;
}) {
  requireManager(input.actor);
  if (input.reason.trim().length < 3)
    throw new GiftCardError("A reversal reason is required.");
  await ensureOrderingGiftCardSchema();
  return withTransaction(async () => {
    const sql = getSql();
    const rows =
      await sql`SELECT ledger.*,card.current_balance_cents,card.status,card.id card_id,card.business FROM ordering_gift_card_ledger ledger JOIN ordering_gift_cards card ON card.id=ledger.gift_card_id WHERE ledger.id=${input.entryId} AND ledger.business=${input.business} FOR UPDATE OF card`;
    const source = rows[0];
    if (!source) throw new GiftCardError("Ledger entry was not found.");
    if (source.entry_type === "reversal")
      throw new GiftCardError("A reversal cannot be reversed.");
    const prior = (
      await sql`SELECT id FROM ordering_gift_card_ledger WHERE related_entry_id=${source.id} AND entry_type='reversal' LIMIT 1`
    )[0];
    if (prior)
      throw new GiftCardError(
        "This gift-card entry has already been reversed in whole or in part.",
      );
    const result = await append({
      card: { ...source, id: source.card_id },
      type: "reversal",
      delta: -Number(source.delta_balance_cents),
      operationKey: input.operationKey,
      actor: input.actor,
      relatedId: source.id,
      note: input.reason,
      approvedBy: input.actor.id,
      metadata: { reversedEntryType: source.entry_type },
    });
    if (
      source.payment_transaction_id &&
      source.entry_type === "redeem" &&
      !result.duplicate
    ) {
      const payment = (
        await sql`SELECT * FROM ordering_payment_transactions WHERE id=${source.payment_transaction_id}`
      )[0];
      const reversalId = randomUUID();
      await sql`INSERT INTO ordering_payment_transactions(id,business,order_id,check_id,customer_id,tender_type,transaction_type,status,amount_cents,amount_tendered_cents,provider,related_transaction_id,client_mutation_id,created_by,approved_at,reason,details) VALUES(${reversalId},${input.business},${payment.order_id},${payment.check_id},${payment.customer_id},'gift_card','void','approved',${payment.amount_cents},${payment.amount_cents},'corner_ops_gift_card',${payment.id},${`${input.operationKey}:payment`},${input.actor.id},NOW(),${input.reason},${JSON.stringify({ reason: input.reason, ledgerEntryId: source.id })}::jsonb)`;
      await sql`UPDATE ordering_orders SET paid_cents=GREATEST(0,paid_cents-${Number(payment.amount_cents)}),amount_due_cents=LEAST(total_cents,amount_due_cents+${Number(payment.amount_cents)}),payment_status=CASE WHEN paid_cents-${Number(payment.amount_cents)}<=0 THEN 'unpaid' ELSE 'partially_paid' END,version=version+1,updated_at=NOW() WHERE id=${payment.order_id}`;
      if (payment.check_id)
        await sql`UPDATE ordering_checks SET paid_cents=GREATEST(0,paid_cents-${Number(payment.amount_cents)}),amount_due_cents=LEAST(total_cents,amount_due_cents+${Number(payment.amount_cents)}),status=CASE WHEN paid_cents-${Number(payment.amount_cents)}<=0 THEN 'open' ELSE 'partially_paid' END,updated_at=NOW() WHERE id=${payment.check_id}`;
    }
    return result;
  });
}
export async function replaceGiftCard(input: {
  business: OrderingBusiness;
  cardNumber: string;
  newCardNumber?: string;
  pin?: string;
  operationKey: string;
  reason: string;
  actor: OrderingActor;
}) {
  requireManager(input.actor);
  key(input.operationKey);
  if (input.reason.trim().length < 3)
    throw new GiftCardError("A replacement reason is required.");
  await ensureOrderingGiftCardSchema();
  return withTransaction(async () => {
    const sql = getSql(),
      replacementReference = `replacement:${input.operationKey}`;
    const prior = (
      await sql`SELECT id,masked_number,current_balance_cents FROM ordering_gift_cards WHERE business=${input.business} AND source_reference=${replacementReference}`
    )[0];
    if (prior)
      return {
        cardId: prior.id,
        maskedNumber: prior.masked_number,
        balanceCents: Number(prior.current_balance_cents),
        duplicate: true,
      };
    const old = await cardForUpdate(input.business, input.cardNumber);
    if (!["active", "depleted"].includes(old.status))
      throw new GiftCardError("Gift card cannot be replaced.");
    const number = normalize(
      input.newCardNumber || randomBytes(10).toString("hex"),
    );
    if (number.length < 8)
      throw new GiftCardError(
        "Card number must contain at least 8 letters or digits.",
      );
    const newId = randomUUID();
    await sql`INSERT INTO ordering_gift_cards(id,business,token_hash,card_number_hash,display_last4,masked_number,pin_verifier,status,current_balance_cents,created_by,activated_at,source_reference) VALUES(${newId},${input.business},${hash(number)},${hash(number)},${number.slice(-4)},${mask(number)},${pinVerifier(input.pin)},'depleted',0,${input.actor.id},NOW(),${replacementReference})`;
    const newCard = (
        await sql`SELECT * FROM ordering_gift_cards WHERE id=${newId} FOR UPDATE`
      )[0],
      balance = Number(old.current_balance_cents);
    if (balance > 0) {
      await append({
        card: old,
        type: "replacement_transfer_out",
        delta: -balance,
        operationKey: `${input.operationKey}:out`,
        actor: input.actor,
        note: input.reason,
        approvedBy: input.actor.id,
      });
      await append({
        card: newCard,
        type: "replacement_transfer_in",
        delta: balance,
        operationKey: `${input.operationKey}:in`,
        actor: input.actor,
        note: input.reason,
        approvedBy: input.actor.id,
      });
    }
    await sql`UPDATE ordering_gift_cards SET status='disabled',deactivated_at=NOW(),deactivation_reason=${input.reason},replaced_by_card_id=${newId} WHERE id=${old.id}`;
    return {
      cardId: newId,
      cardNumber: number,
      maskedNumber: mask(number),
      balanceCents: balance,
      duplicate: false,
    };
  });
}
export async function giftCardReport(business: OrderingBusiness) {
  await ensureOrderingGiftCardSchema();
  const sql = getSql();
  const summary = (
    await sql`SELECT COALESCE(SUM(current_balance_cents),0) outstanding_balance_cents,COUNT(*) FILTER(WHERE status IN('active','depleted')) active_card_count FROM ordering_gift_cards WHERE business=${business}`
  )[0];
  const activity =
    await sql`SELECT DATE(created_at) activity_date,COALESCE(SUM(delta_balance_cents) FILTER(WHERE entry_type IN('initial_load','reload','import_opening_balance')),0) load_cents,COALESCE(-SUM(delta_balance_cents) FILTER(WHERE entry_type='redeem'),0) redemption_cents FROM ordering_gift_card_ledger WHERE business=${business} GROUP BY DATE(created_at) ORDER BY activity_date DESC LIMIT 90`;
  return { summary, activity };
}
