import assert from "node:assert/strict";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { Client } from "pg";

// Deliberately requires an isolated database. Never infer the store database.
if (!process.env.VALIDATION_DATABASE_URL) throw new Error("Set VALIDATION_DATABASE_URL to an isolated validation database.");
process.env.DATABASE_URL = process.env.VALIDATION_DATABASE_URL;
process.env.DATABASE_DRIVER = "postgres";
process.env.VALIDATION_DISABLE_OUTBOUND = "1";
process.env.SESSION_SECRET ||= randomUUID();

async function main() {
  const { getSql } = await import("../src/lib/db");
  const loyalty = await import("../src/lib/ordering-loyalty");
  const points = await import("../src/lib/ordering-points");
  const {cancelOrderItem,quoteItemCancellation}=await import("../src/lib/ordering-item-cancellations");
  const { ensureOrderingLoyaltySchema } = await import("../src/lib/ordering-loyalty-schema");
  await ensureOrderingLoyaltySchema();
  const sql = getSql(), actor = { id: "loyalty-regressions", name: "Loyalty regressions", type: "employee" as const, role: "manager" as const };
  const customers: string[] = [], orders: string[] = [], programs: string[] = [], rewards: string[] = [], promotions:string[]=[],menuItems:string[]=[],sessionHashes:string[]=[],emails:string[]=[];
  const [item] = await sql`SELECT id FROM ordering_menu_items WHERE business='Corner Deli' AND active AND name='Small French Fries' LIMIT 1`;
  assert.ok(item, "A menu fixture is required");
  const [settings] = await sql`SELECT * FROM ordering_points_settings WHERE business='Corner Deli'`;
  const failures: string[] = [], passed: string[] = [];
  async function check(name: string, run: () => Promise<void>) { try { await run(); passed.push(name); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : error}`); } }
  async function customer() {
    const id = randomUUID(); customers.push(id);
    await sql`INSERT INTO ordering_customers(id,business,display_name) VALUES(${id},'Corner Deli','Loyalty regression')`;
    return id;
  }
  async function program() {
    const id = randomUUID(); programs.push(id);
    await sql`INSERT INTO ordering_loyalty_programs(id,business,name,customer_name,qualifying_rule,reward_rule,active) VALUES(${id},'Corner Deli',${`Regression ${id}`},'Regression reward',${JSON.stringify({itemIds:[item.id],quantityRequired:10,discountedItemsQualify:false})}::jsonb,${JSON.stringify({itemIds:[item.id],quantity:1})}::jsonb,TRUE)`;
    return id;
  }
  async function order(customerId: string, quantity = 1) {
    const id = randomUUID(), line = randomUUID(); orders.push(id);
    await sql`INSERT INTO ordering_orders(id,business,source,customer_id,status,payment_status,service_type,display_number,created_by,subtotal_cents,total_cents,amount_due_cents) VALUES(${id},'Corner Deli','web',${customerId},'draft','unpaid','pickup',${`REG-${id.slice(0,8)}`},'validator',${quantity*1000},${quantity*1000},${quantity*1000})`;
    await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${line},${id},${item.id},'Regression item',${quantity},1000,${quantity*1000})`;
    return { id, line };
  }
  const loyaltyBalance = async (customerId: string, programId: string) => Number((await sql`SELECT COALESCE(SUM(delta_units),0) balance FROM ordering_loyalty_ledger WHERE customer_id=${customerId} AND program_id=${programId}`)[0].balance);
  const pointsBalance = async (customerId: string) => Number((await sql`SELECT COALESCE(SUM(points),0) balance FROM ordering_points_ledger WHERE customer_id=${customerId}`)[0].balance);
  const fundOrder=async(orderId:string)=>{await sql`UPDATE ordering_orders SET payment_status='paid',paid_cents=total_cents,amount_due_cents=0 WHERE id=${orderId}`};
  async function raceAtCustomer(customerId: string, operations: Array<() => Promise<unknown>>) {
    // Hold the common account while both requests reach it. Without account
    // serialization they read the same balance before their inserts unblock.
    const blocker = new Client({connectionString:process.env.DATABASE_URL});
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM ordering_customers WHERE id=$1 FOR UPDATE",[customerId]);
    const pending = Promise.allSettled(operations.map(run=>run()));
    try {
      for(let attempt=0;attempt<100;attempt++) {
        const [{count}] = await sql`SELECT COUNT(*) count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`;
        if(Number(count)>=operations.length) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    } finally { await blocker.query("COMMIT"); await blocker.end(); }
    return pending;
  }
  try {
    await sql`INSERT INTO ordering_points_settings(business) VALUES('Corner Deli') ON CONFLICT DO NOTHING`;
    await sql`UPDATE ordering_points_settings SET active=TRUE,bonus_multiplier=1,expiry_months=6 WHERE business='Corner Deli'`;
    await check("one reward cannot reserve two lines", async () => {
      const c = await customer(), p = await program(), o = await order(c), extra = randomUUID();
      await loyalty.adjustLoyalty({customerId:c,programId:p,deltaUnits:10,reason:"Regression balance",actor});
      await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${extra},${o.id},${item.id},'Second item',1,1000,1000)`;
      await sql`UPDATE ordering_orders SET subtotal_cents=2000,total_cents=2000,amount_due_cents=2000 WHERE id=${o.id}`;
      await loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:o.line,programId:p,actor});
      await assert.rejects(loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:extra,programId:p,actor}));
    });
    await check("concurrent pizza redemption cannot double spend", async () => {
      const c = await customer(), p = await program(), a = await order(c), b = await order(c);
      await loyalty.adjustLoyalty({customerId:c,programId:p,deltaUnits:10,reason:"Regression balance",actor});
      for (const o of [a,b]) await loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:o.line,programId:p,actor});
      await sql`UPDATE ordering_orders SET status='sent_to_kitchen' WHERE id IN(${a.id},${b.id})`;
      const results = await raceAtCustomer(c,[()=>loyalty.finalizeLoyaltyRedemptions(a.id),()=>loyalty.finalizeLoyaltyRedemptions(b.id)]);
      assert.equal(results.filter(row=>row.status==="fulfilled").length,1);
      assert.equal(await loyaltyBalance(c,p),0);
    });
    await check("redemption keeps its quoted threshold", async () => {
      const c = await customer(), p = await program(), o = await order(c);
      await loyalty.adjustLoyalty({customerId:c,programId:p,deltaUnits:10,reason:"Regression balance",actor});
      await loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:o.line,programId:p,actor});
      await sql`UPDATE ordering_loyalty_programs SET qualifying_rule=jsonb_set(qualifying_rule,'{quantityRequired}','20') WHERE id=${p}`;
      await sql`UPDATE ordering_orders SET status='sent_to_kitchen' WHERE id=${o.id}`;
      await loyalty.finalizeLoyaltyRedemptions(o.id);
      assert.equal(await loyaltyBalance(c,p),0);
    });
    await check("concurrent balance reads expire points once", async () => {
      const c = await customer();
      await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,entry_type,points,created_by,created_at) VALUES(${randomUUID()},'Corner Deli',${c},'earn',100,'validator',NOW()-INTERVAL '7 months')`;
      await Promise.all(Array.from({length:12},()=>points.pointsBalance(c)));
      assert.equal(await pointsBalance(c),0);
      assert.equal(Number((await sql`SELECT COUNT(*) count FROM ordering_points_ledger WHERE customer_id=${c} AND entry_type='expiry'`)[0].count),1);
    });
    await check("concurrent points redemption cannot double spend", async () => {
      const c = await customer(), a = await order(c), b = await order(c), reward = randomUUID(); rewards.push(reward);
      await sql`INSERT INTO ordering_points_rewards(id,business,reward_key,label,points,kind,item_ids) VALUES(${reward},'Corner Deli',${reward},'Regression reward',100,'item',${[item.id]}::uuid[])`;
      await points.adjustPoints({customerId:c,points:100,reason:"Regression balance",actor});
      for (const o of [a,b]) await points.requestPointsRedemption({orderId:o.id,rewardId:reward,actor,channel:"web"});
      await sql`UPDATE ordering_orders SET status='sent_to_kitchen' WHERE id IN(${a.id},${b.id})`;
      const results = await raceAtCustomer(c,[()=>points.finalizePointsRedemptions(a.id),()=>points.finalizePointsRedemptions(b.id)]);
      assert.equal(results.filter(row=>row.status==="fulfilled").length,1);
      assert.equal(await pointsBalance(c),0);
    });
    await check("discounted loyalty units do not earn when excluded", async () => {
      const c = await customer(), p = await program(), o = await order(c,2);
      await loyalty.adjustLoyalty({customerId:c,programId:p,deltaUnits:10,reason:"Regression balance",actor});
      await loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:o.line,programId:p,actor});
      await sql`UPDATE ordering_orders SET status='sent_to_kitchen' WHERE id=${o.id}`;
      await loyalty.finalizeLoyaltyRedemptions(o.id);
      await fundOrder(o.id);
      await loyalty.earnLoyaltyForOrder(o.id,actor);
      assert.equal(await loyaltyBalance(c,p),1);
    });
    await check("two loyalty programs cannot reward one unit twice",async()=>{
      const c=await customer(),a=await program(),b=await program(),o=await order(c);
      for(const p of [a,b])await loyalty.adjustLoyalty({customerId:c,programId:p,deltaUnits:10,reason:"Regression balance",actor});
      await loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:o.line,programId:a,actor});
      await assert.rejects(loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:o.line,programId:b,actor}));
    });
    await check("canceling a free item cannot refund another item's payment",async()=>{
      const c=await customer(),p=await program(),o=await order(c),other=randomUUID();
      await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${other},${o.id},${item.id},'Paid item',1,1000,1000)`;
      await sql`UPDATE ordering_orders SET subtotal_cents=2000,total_cents=2000,amount_due_cents=2000 WHERE id=${o.id}`;
      await loyalty.adjustLoyalty({customerId:c,programId:p,deltaUnits:10,reason:"Regression balance",actor});
      await loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:o.line,programId:p,actor});
      await sql`UPDATE ordering_orders SET status='sent_to_kitchen',submitted_at=NOW() WHERE id=${o.id}`;
      await loyalty.finalizeLoyaltyRedemptions(o.id);
      await fundOrder(o.id);
      await loyalty.earnLoyaltyForOrder(o.id,actor);
      const quote=await quoteItemCancellation({orderId:o.id,itemId:o.line,quantity:1,actor});
      assert.equal(quote.orderReductionCents,0);
      await cancelOrderItem({orderId:o.id,itemId:o.line,quantity:1,reason:"Regression cancel",clientMutationId:randomUUID(),actor});
      assert.equal(Number((await sql`SELECT total_cents FROM ordering_orders WHERE id=${o.id}`)[0].total_cents),1000);
      assert.equal(await loyaltyBalance(c,p),11);
      await loyalty.reverseLoyaltyForOrder(o.id,actor,"Regression void");
      await loyalty.reverseLoyaltyForOrder(o.id,actor,"Regression void retry");
      assert.equal(await loyaltyBalance(c,p),10);
    });
    await check("cancelled food loses punches and points; additions earn once",async()=>{
      const c=await customer(),p=await program(),o=await order(c,3);
      await sql`UPDATE ordering_orders SET status='sent_to_kitchen',submitted_at=NOW() WHERE id=${o.id}`;
      await fundOrder(o.id);
      await loyalty.earnLoyaltyForOrder(o.id,actor);await points.earnPointsForOrder(o.id,actor);
      assert.equal(await loyaltyBalance(c,p),3);assert.equal(await pointsBalance(c),33);
      await cancelOrderItem({orderId:o.id,itemId:o.line,quantity:1,reason:"Regression cancel",clientMutationId:randomUUID(),refundMethod:'later',actor});
      assert.equal(await loyaltyBalance(c,p),2);assert.equal(await pointsBalance(c),22);
      const extra=randomUUID();
      await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${extra},${o.id},${item.id},'Added item',1,1000,1000)`;
      await loyalty.earnLoyaltyForOrder(o.id,actor);await points.earnPointsForOrder(o.id,actor);
      await loyalty.earnLoyaltyForOrder(o.id,actor);await points.earnPointsForOrder(o.id,actor);
      assert.equal(await loyaltyBalance(c,p),3);assert.equal(await pointsBalance(c),33);
      await loyalty.reverseLoyaltyForOrder(o.id,actor,"Regression void");await points.reversePointsForOrder(o.id,actor,"Regression void");
      await loyalty.reverseLoyaltyForOrder(o.id,actor,"Regression void");await points.reversePointsForOrder(o.id,actor,"Regression void");
      assert.equal(await loyaltyBalance(c,p),0);assert.equal(await pointsBalance(c),0);
    });
    await check("voided recent orders do not keep expired points alive",async()=>{
      const c=await customer(),o=await order(c),recent=randomUUID();
      await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,entry_type,points,created_by,created_at) VALUES(${randomUUID()},'Corner Deli',${c},'earn',100,'validator',NOW()-INTERVAL '7 months')`;
      await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,order_id,entry_type,points,created_by) VALUES(${recent},'Corner Deli',${c},${o.id},'earn',10,'validator')`;
      await points.reversePointsForOrder(o.id,actor,"Regression void");
      assert.equal(await points.pointsBalance(c),0);
    });
    await check("new food purchases do not resurrect expired points",async()=>{
      const c=await customer(),o=await order(c);
      await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,entry_type,points,created_by,created_at) VALUES(${randomUUID()},'Corner Deli',${c},'earn',100,'validator',NOW()-INTERVAL '7 months')`;
      await sql`UPDATE ordering_orders SET status='sent_to_kitchen' WHERE id=${o.id}`;
      await fundOrder(o.id);
      await points.earnPointsForOrder(o.id,actor);
      assert.equal(await pointsBalance(c),11);
    });
    await check("points reward removes automatic discounts from its line",async()=>{
      const c=await customer(),o=await order(c),uniqueItem=randomUUID(),reward=randomUUID(),promotion=randomUUID(),other=randomUUID();
      menuItems.push(uniqueItem);rewards.push(reward);promotions.push(promotion);
      await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents) SELECT ${uniqueItem},business,category_id,${`Regression ${uniqueItem}`},1000 FROM ordering_menu_items WHERE id=${item.id}`;
      await sql`UPDATE ordering_order_items SET item_id=${uniqueItem} WHERE id=${o.line}`;
      await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${other},${o.id},${item.id},'Other product',1,1000,1000)`;
      await sql`UPDATE ordering_orders SET subtotal_cents=2000,total_cents=2000,amount_due_cents=2000 WHERE id=${o.id}`;
      await sql`INSERT INTO ordering_promotions(id,business,name,promotion_type,rule,adjustment,active,automatic,priority,created_by) VALUES(${promotion},'Corner Deli',${`Regression ${promotion}`},'amount_off',${JSON.stringify({components:[{id:'item',quantity:1,itemIds:[uniqueItem]}],repeatable:true})}::jsonb,'{"amountOffCents":500}'::jsonb,TRUE,TRUE,100000,'validator')`;
      await sql`INSERT INTO ordering_points_rewards(id,business,reward_key,label,points,kind,item_ids) VALUES(${reward},'Corner Deli',${reward},'Regression reward',100,'item',${[uniqueItem]}::uuid[])`;
      const {applyPromotionsToOrder}=await import('../src/lib/ordering-promotions');
      await applyPromotionsToOrder(o.id);
      assert.equal(Number((await sql`SELECT total_cents FROM ordering_orders WHERE id=${o.id}`)[0].total_cents),1500);
      await points.adjustPoints({customerId:c,points:100,reason:"Regression balance",actor});
      await points.requestPointsRedemption({orderId:o.id,rewardId:reward,actor,channel:'web'});
      const [priced]=await sql`SELECT total_cents,promotion_discount_cents,loyalty_discount_cents FROM ordering_orders WHERE id=${o.id}`;
      assert.equal(Number(priced.total_cents),1000);assert.equal(Number(priced.promotion_discount_cents),0);assert.equal(Number(priced.loyalty_discount_cents),1000);
      await sql`UPDATE ordering_orders SET status='sent_to_kitchen',submitted_at=NOW() WHERE id=${o.id}`;
      await fundOrder(o.id);
      await points.finalizePointsRedemptions(o.id);
      await cancelOrderItem({orderId:o.id,itemId:o.line,quantity:1,reason:'Regression reward cancellation',clientMutationId:randomUUID(),actor});
      assert.equal(await pointsBalance(c),111);
      await points.reversePointsForOrder(o.id,actor,'Regression void');
      assert.equal(await pointsBalance(c),100);
    });
    await check("configured multi-unit rewards use and reserve the quoted quantity",async()=>{
      const c=await customer(),p=await program(),o=await order(c,2);
      await sql`UPDATE ordering_loyalty_programs SET reward_rule=jsonb_set(reward_rule,'{quantity}','2') WHERE id=${p}`;
      await loyalty.adjustLoyalty({customerId:c,programId:p,deltaUnits:10,reason:'Regression balance',actor});
      await loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:o.line,programId:p,actor});
      const [applied]=await sql`SELECT consumed_quantity,discount_cents FROM ordering_order_loyalty_applications WHERE order_id=${o.id}`;
      assert.equal(Number(applied.consumed_quantity),2);assert.equal(Number(applied.discount_cents),2000);
      await assert.rejects(cancelOrderItem({orderId:o.id,itemId:o.line,quantity:1,reason:'Regression partial reward',clientMutationId:randomUUID(),actor}),/whole rewarded line/);
    });
    await check("unpaid and partly paid orders cannot fund rewards; final cash payment earns once",async()=>{
      const c=await customer(),p=await program(),o=await order(c,10);
      await sql`UPDATE ordering_orders SET status='sent_to_kitchen',submitted_at=NOW() WHERE id=${o.id}`;
      await loyalty.earnLoyaltyForOrder(o.id,actor);await points.earnPointsForOrder(o.id,actor);
      assert.equal(await loyaltyBalance(c,p),0);assert.equal(await pointsBalance(c),0);
      const {commitTender}=await import('../src/lib/ordering-payments');
      await commitTender({orderId:o.id,business:'Corner Deli',tenderType:'cash',amountTenderedCents:5000,clientMutationId:randomUUID(),cashControlMode:'driver_settlement',actor});
      assert.equal(await loyaltyBalance(c,p),0);assert.equal(await pointsBalance(c),0);
      const mutation=randomUUID();
      await commitTender({orderId:o.id,business:'Corner Deli',tenderType:'cash',amountTenderedCents:5000,clientMutationId:mutation,cashControlMode:'driver_settlement',actor});
      await commitTender({orderId:o.id,business:'Corner Deli',tenderType:'cash',amountTenderedCents:5000,clientMutationId:mutation,cashControlMode:'driver_settlement',actor});
      assert.equal(await loyaltyBalance(c,p),10);assert.equal(await pointsBalance(c),110);
    });
    await check("a guest cannot claim an existing phone account through an empty email",async()=>{
      const victim=await customer(),phone=`315${String(randomInt(0,10_000_000)).padStart(7,'0')}`,email=`audit-${randomUUID()}@example.invalid`;
      emails.push(email);
      await sql`INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,is_primary) VALUES(${randomUUID()},${victim},${`+1${phone}`},${phone},TRUE)`;
      const {customerSessionCookie,customerSessionHash}=await import('../src/lib/customer-ordering-session');
      const sessionId=randomUUID(),sessionHash=customerSessionHash(sessionId);sessionHashes.push(sessionHash);
      const cookie=customerSessionCookie({sessionId,customerId:null,authenticatedAt:null,expiresAt:Date.now()+60_000}).split(';')[0];
      const {POST}=await import('../src/app/api/customer/cart/route');
      const response=await POST(new Request('http://localhost/api/customer/cart',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({serviceType:'pickup',firstName:'Guest',phone,email,items:[]})}));
      assert.equal(response.status,409);
      assert.equal(String((await sql`SELECT email FROM ordering_customers WHERE id=${victim}`)[0].email),'');
      // Verify a local fixture code without sending email: owning the guest's
      // email must produce a separate account, never the typed phone's owner.
      const code=String(randomInt(0,1_000_000)).padStart(6,'0');
      const hash=createHmac('sha256',process.env.SESSION_SECRET||'').update(`${email}:${code}`).digest('hex');
      await sql`INSERT INTO ordering_customer_email_codes(id,email,code_hash,expires_at) VALUES(${randomUUID()},${email},${hash},NOW()+INTERVAL '1 minute')`;
      const {verifyCustomerEmailCode}=await import('../src/lib/customer-email-auth');
      const signedIn=await verifyCustomerEmailCode(email,code);
      if(signedIn!==victim)customers.push(signedIn);
      assert.notEqual(signedIn,victim);
    });
    await check("full money refunds remove earnings, keep spent rewards, and permit one later earning",async()=>{
      const {commitTender,reverseTender,settleTenderAsStoreCredit}=await import('../src/lib/ordering-payments');
      for(const mode of ['cash','store_credit','repayment'] as const){
        const c=await customer(),p=await program(),o=await order(c),pizzaLine=randomUUID(),pointsLine=randomUUID(),reward=randomUUID();
        rewards.push(reward);
        for(const line of [pizzaLine,pointsLine])await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${line},${o.id},${item.id},'Reward item',1,1000,1000)`;
        await sql`UPDATE ordering_orders SET subtotal_cents=3000,total_cents=3000,amount_due_cents=3000 WHERE id=${o.id}`;
        await sql`INSERT INTO ordering_points_rewards(id,business,reward_key,label,points,kind,item_ids) VALUES(${reward},'Corner Deli',${reward},'Regression refund reward',100,'item',${[item.id]}::uuid[])`;
        await loyalty.adjustLoyalty({customerId:c,programId:p,deltaUnits:10,reason:'Regression starting reward',actor});
        await points.adjustPoints({customerId:c,points:100,reason:'Regression starting reward',actor});
        await loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:pizzaLine,programId:p,actor});
        await points.requestPointsRedemption({orderId:o.id,orderItemId:pointsLine,rewardId:reward,channel:'web',actor});
        await sql`UPDATE ordering_orders SET status='sent_to_kitchen',submitted_at=NOW() WHERE id=${o.id}`;
        await loyalty.finalizeLoyaltyRedemptions(o.id);await points.finalizePointsRedemptions(o.id);
        const paymentId=randomUUID();
        await commitTender({orderId:o.id,business:'Corner Deli',tenderType:'cash',amountTenderedCents:1000,clientMutationId:paymentId,cashControlMode:'driver_settlement',actor});
        const [tender]=await sql`SELECT id FROM ordering_payment_transactions WHERE client_mutation_id=${paymentId}`;
        assert.equal(await loyaltyBalance(c,p),1,mode);assert.equal(await pointsBalance(c),11,mode);
        const refund=async(mutation:string)=>mode==='store_credit'
          ?settleTenderAsStoreCredit({orderId:o.id,transactionId:String(tender.id),refundCents:500,creditCents:500,clientMutationId:mutation,reason:'Regression full refund',moneyBack:true,actor})
          :reverseTender({orderId:o.id,business:'Corner Deli',transactionId:String(tender.id),amountCents:500,clientMutationId:mutation,reason:'Regression full refund',moneyBack:mode==='cash',actor});
        await refund(randomUUID());
        assert.equal(await loyaltyBalance(c,p),1,mode);assert.equal(await pointsBalance(c),11,mode);
        const mutation=randomUUID();await refund(mutation);await refund(mutation);
        await loyalty.clawbackUnpaidLoyaltyEarnings(o.id,actor,'Retry refund');await points.clawbackUnpaidPointsEarnings(o.id,actor,'Retry refund');
        assert.equal(await loyaltyBalance(c,p),0,mode);assert.equal(await pointsBalance(c),0,mode);
        assert.equal(Number((await sql`SELECT COUNT(*) count FROM ordering_loyalty_ledger WHERE order_id=${o.id} AND entry_type='redemption_reversal'`)[0].count),0);
        assert.equal(Number((await sql`SELECT COUNT(*) count FROM ordering_points_ledger WHERE order_id=${o.id} AND entry_type='reversal'`)[0].count),0);
        if(mode==='repayment'){
          const retry=randomUUID();
          await commitTender({orderId:o.id,business:'Corner Deli',tenderType:'cash',amountTenderedCents:1000,clientMutationId:retry,cashControlMode:'driver_settlement',actor});
          await commitTender({orderId:o.id,business:'Corner Deli',tenderType:'cash',amountTenderedCents:1000,clientMutationId:retry,cashControlMode:'driver_settlement',actor});
          assert.equal(await loyaltyBalance(c,p),1);assert.equal(await pointsBalance(c),11);
        }
        await loyalty.reverseLoyaltyForOrder(o.id,actor,'Regression whole void');await points.reversePointsForOrder(o.id,actor,'Regression whole void');
        await loyalty.clawbackUnpaidLoyaltyEarnings(o.id,actor,'Post-void refund');await points.clawbackUnpaidPointsEarnings(o.id,actor,'Post-void refund');
        assert.equal(await loyaltyBalance(c,p),10,mode);assert.equal(await pointsBalance(c),100,mode);
      }
    });
    await check("fully refunded recent purchases cannot keep unrelated stale points alive",async()=>{
      const c=await customer(),o=await order(c);
      await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,entry_type,points,created_by,created_at) VALUES(${randomUUID()},'Corner Deli',${c},'earn',100,'validator',NOW()-INTERVAL '7 months')`;
      await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,order_id,entry_type,points,created_by) VALUES(${randomUUID()},'Corner Deli',${c},${o.id},'earn',11,'validator')`;
      await fundOrder(o.id);
      assert.equal(await points.pointsBalance(c),111);
      await sql`UPDATE ordering_orders SET payment_status='refunded',paid_cents=0,amount_due_cents=0 WHERE id=${o.id}`;
      await points.clawbackUnpaidPointsEarnings(o.id,actor,'Regression full refund');
      assert.equal(await pointsBalance(c),100);
      assert.equal(await points.pointsBalance(c),0);
      assert.equal(await points.pointsBalance(c),0);
    });
    await check("stackable pizza rewards cap promotion discounts to the rewarded line's remaining price",async()=>{
      for(const rewardCents of [1000,700,400]){
        const c=await customer(),p=await program(),o=await order(c),rewardItem=randomUUID(),rewardLine=randomUUID(),capVariant=randomUUID(),promotion=randomUUID();
        menuItems.push(rewardItem);promotions.push(promotion);
        await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,base_price_cents) SELECT ${rewardItem},business,category_id,${`Stacking regression ${rewardItem}`},1000 FROM ordering_menu_items WHERE id=${item.id}`;
        await sql`INSERT INTO ordering_menu_item_variants(id,item_id,name,base_price_cents) VALUES(${capVariant},${rewardItem},'Reward cap',${rewardCents})`;
        await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents) VALUES(${rewardLine},${o.id},${rewardItem},'Stackable rewarded item',1,1000,1000)`;
        await sql`UPDATE ordering_orders SET subtotal_cents=2000,total_cents=2000,amount_due_cents=2000 WHERE id=${o.id}`;
        await sql`UPDATE ordering_loyalty_programs SET stackable=TRUE,qualifying_rule=${JSON.stringify({itemIds:[rewardItem],quantityRequired:10,discountedItemsQualify:false})}::jsonb,reward_rule=${JSON.stringify({itemIds:[rewardItem],quantity:1,capVariantId:capVariant})}::jsonb WHERE id=${p}`;
        await sql`INSERT INTO ordering_promotions(id,business,name,promotion_type,rule,adjustment,active,automatic,priority,stackable_with_loyalty,created_by) VALUES(${promotion},'Corner Deli',${`Stacking regression ${promotion}`},'amount_off',${JSON.stringify({components:[{id:'item',quantity:1,itemIds:[rewardItem]}],repeatable:true})}::jsonb,'{"amountOffCents":500}'::jsonb,TRUE,TRUE,100000,TRUE,'validator')`;
        await loyalty.adjustLoyalty({customerId:c,programId:p,deltaUnits:10,reason:'Regression starting reward',actor});
        await loyalty.requestLoyaltyRedemption({orderId:o.id,orderItemId:rewardLine,programId:p,actor});
        const [priced]=await sql`SELECT total_cents,promotion_discount_cents,loyalty_discount_cents FROM ordering_orders WHERE id=${o.id}`;
        const allowedPromotion=Math.min(500,1000-rewardCents);
        assert.equal(Number(priced.loyalty_discount_cents),rewardCents);
        assert.equal(Number(priced.promotion_discount_cents),allowedPromotion);
        assert.equal(Number(priced.total_cents),2000-rewardCents-allowedPromotion);
        assert.ok(Number(priced.total_cents)>=1000,'The unrelated item must remain full price');
      }
    });
    console.log(JSON.stringify({passed,failures},null,2));
    assert.equal(failures.length,0,failures.join("\n"));
  } finally {
    await sql`DELETE FROM ordering_order_loyalty_applications WHERE order_id=ANY(${orders}::uuid[])`;
    await sql`DELETE FROM ordering_order_points_redemptions WHERE order_id=ANY(${orders}::uuid[])`;
    await sql`DELETE FROM ordering_points_ledger WHERE customer_id=ANY(${customers}::uuid[])`;
    await sql`DELETE FROM ordering_loyalty_ledger WHERE customer_id=ANY(${customers}::uuid[])`;
    await sql`DELETE FROM ordering_order_item_cancellations WHERE order_id=ANY(${orders}::uuid[])`;
    await sql`DELETE FROM ordering_print_jobs WHERE order_id=ANY(${orders}::uuid[])`;
    await sql`DELETE FROM ordering_store_credit_ledger WHERE order_id=ANY(${orders}::uuid[])`;
    await sql`DELETE FROM ordering_payment_transactions WHERE order_id=ANY(${orders}::uuid[])`;
    await sql`DELETE FROM ordering_orders WHERE id=ANY(${orders}::uuid[])`;
    await sql`DELETE FROM ordering_customer_web_sessions WHERE session_hash=ANY(${sessionHashes}::text[])`;
    await sql`DELETE FROM ordering_customer_email_codes WHERE email=ANY(${emails}::text[])`;
    await sql`DELETE FROM ordering_customer_phones WHERE customer_id=ANY(${customers}::uuid[])`;
    await sql`DELETE FROM ordering_customers WHERE id=ANY(${customers}::uuid[])`;
    await sql`DELETE FROM ordering_loyalty_programs WHERE id=ANY(${programs}::uuid[])`;
    await sql`DELETE FROM ordering_points_rewards WHERE id=ANY(${rewards}::uuid[])`;
    await sql`DELETE FROM ordering_promotions WHERE id=ANY(${promotions}::uuid[])`;
    await sql`DELETE FROM ordering_menu_items WHERE id=ANY(${menuItems}::uuid[])`;
    if(settings) await sql`UPDATE ordering_points_settings SET active=${settings.active},bonus_multiplier=${settings.bonus_multiplier},expiry_months=${settings.expiry_months} WHERE business='Corner Deli'`;
    else await sql`DELETE FROM ordering_points_settings WHERE business='Corner Deli'`;
  }
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)});
