import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { normalizeCallerPhone } from "@/lib/ordering-core";
import { displayPhone } from "@/lib/ordering-customers";
import { sendTransactionalSms } from "@/lib/sms-notifications";
export const runtime = "nodejs";
const hash = (value:string) => createHash("sha256").update(`${process.env.SESSION_SECRET}:customer-phone:${value}`).digest();
export async function POST(request:Request){
  try{
    const session=readCustomerOrderingSession(request);if(!session?.customerId||!session.authenticatedAt)return Response.json({error:"Sign in required."},{status:401});
    await ensureCustomerOrderingSchema();const body=await request.json() as Record<string,unknown>,action=String(body.action||"request"),sql=getSql();
    if(action==="remove"){
      const count=await sql`SELECT COUNT(*)::int count FROM ordering_customer_phones WHERE customer_id=${session.customerId}`;if(Number(count[0]?.count||0)<=1)throw new Error("Keep at least one verified phone number on the account.");
      await sql`DELETE FROM ordering_customer_phones WHERE id=${String(body.phoneId||"")} AND customer_id=${session.customerId}`;
      await sql`UPDATE ordering_customer_phones SET is_primary=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM ordering_customer_phones WHERE customer_id=${session.customerId} ORDER BY last_used_at DESC NULLS LAST,created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM ordering_customer_phones WHERE customer_id=${session.customerId} AND is_primary=TRUE)`;
      return Response.json({removed:true});
    }
    const phone=normalizeCallerPhone(String(body.phone||""));if(!/^\+1\d{10}$/.test(phone))throw new Error("Enter a valid 10-digit phone number.");
    if(action==="request"){
      const recent=await sql`SELECT COUNT(*)::int count FROM ordering_customer_phone_codes WHERE customer_id=${session.customerId} AND created_at>NOW()-INTERVAL '15 minutes'`;
      if(Number(recent[0]?.count||0)>=5)throw new Error("Too many verification requests. Try again in 15 minutes.");
      const code=String(randomInt(0,1000000)).padStart(6,"0");
      await sql`INSERT INTO ordering_customer_phone_codes(id,customer_id,normalized_phone,code_hash,expires_at)VALUES(${randomUUID()},${session.customerId},${phone},${hash(code).toString("hex")},NOW()+INTERVAL '10 minutes')`;
      await sendTransactionalSms(phone,`Your Corner Deli verification code is ${code}. It expires in 10 minutes.`);return Response.json({sent:true});
    }
    if(action==="verify"){
      const rows=await sql`SELECT * FROM ordering_customer_phone_codes WHERE customer_id=${session.customerId} AND normalized_phone=${phone} AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`,row=rows[0];
      if(!row||new Date(row.expires_at).getTime()<Date.now())throw new Error("That verification code expired. Request a new one.");
      if(Number(row.attempts)>=5)throw new Error("Too many attempts. Request a new code.");
      await sql`UPDATE ordering_customer_phone_codes SET attempts=attempts+1 WHERE id=${row.id}`;
      const supplied=hash(String(body.code||"").trim()),expected=Buffer.from(String(row.code_hash),"hex");
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new Error("That verification code is not correct.");
      await sql`UPDATE ordering_customer_phone_codes SET used_at=NOW() WHERE id=${row.id}`;
      const existing=await sql`SELECT id FROM ordering_customer_phones WHERE customer_id=${session.customerId} AND normalized_phone=${phone}`;
      if(!existing[0])await sql`INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,label,is_primary)VALUES(${randomUUID()},${session.customerId},${phone},${displayPhone(phone)},'Mobile',NOT EXISTS(SELECT 1 FROM ordering_customer_phones WHERE customer_id=${session.customerId}))`;
      return Response.json({verified:true});
    }
    throw new Error("Unknown phone action.");
  }catch(error){return Response.json({error:error instanceof Error?error.message:"Phone could not be updated."},{status:400})}
}
