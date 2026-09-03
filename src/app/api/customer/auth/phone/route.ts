import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { customerSessionCookie } from "@/lib/customer-ordering-session";
import { getSql } from "@/lib/db";
import { normalizeCallerPhone } from "@/lib/ordering-core";
import { displayPhone } from "@/lib/ordering-customers";
import { sendTransactionalSms } from "@/lib/sms-notifications";

export const runtime = "nodejs";
const digest=(phone:string,code:string)=>createHmac("sha256",process.env.SESSION_SECRET||"").update(`${phone}:${code}`).digest("hex");
const equal=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right)};

export async function POST(request:Request){
  try{
    const body=await request.json(),phone=normalizeCallerPhone(String(body.phone||""));
    if(!/^\+1\d{10}$/.test(phone))throw new Error("Enter a valid 10-digit mobile phone number.");
    await ensureCustomerOrderingSchema();
    const sql=getSql();
    if(body.action==="request"){
      const recent=await sql`SELECT COUNT(*)::integer count FROM ordering_customer_login_phone_codes WHERE normalized_phone=${phone} AND created_at>NOW()-INTERVAL '15 minutes'`;
      if(Number(recent[0]?.count||0)>=3)throw new Error("Too many codes requested. Wait 15 minutes and try again.");
      const match=(await sql`SELECT customer.id FROM ordering_customer_phones phone JOIN ordering_customers customer ON customer.id=phone.customer_id WHERE customer.business='Corner Deli' AND customer.active=TRUE AND customer.merged_into_customer_id IS NULL AND phone.normalized_phone=${phone} ORDER BY phone.is_primary DESC,customer.created_at LIMIT 1`)[0];
      const code=String(randomInt(0,1000000)).padStart(6,"0");
      await sql`INSERT INTO ordering_customer_login_phone_codes(id,normalized_phone,customer_id,code_hash,expires_at)VALUES(${randomUUID()},${phone},${match?.id||null},${digest(phone,code)},NOW()+INTERVAL '10 minutes')`;
      await sendTransactionalSms(phone,`Your Corner Deli sign-in code is ${code}. It expires in 10 minutes.`);
      return Response.json({sent:true});
    }
    if(body.action==="verify"){
      const code=String(body.code||"").replace(/\D/g,"");if(!/^\d{6}$/.test(code))throw new Error("Enter the 6-digit code.");
      const row=(await sql`SELECT * FROM ordering_customer_login_phone_codes WHERE normalized_phone=${phone} AND used_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`)[0];
      if(!row||Number(row.attempts)>=5||!equal(String(row.code_hash),digest(phone,code))){if(row)await sql`UPDATE ordering_customer_login_phone_codes SET attempts=attempts+1 WHERE id=${row.id}`;throw new Error("The code is incorrect or expired.")}
      await sql`UPDATE ordering_customer_login_phone_codes SET used_at=NOW() WHERE id=${row.id}`;
      let customerId=String(row.customer_id||"");
      if(!customerId){customerId=randomUUID();const label=`Customer ${phone.slice(-4)}`;await sql`INSERT INTO ordering_customers(id,business,display_name)VALUES(${customerId},'Corner Deli',${label})`;await sql`INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,label,is_primary)VALUES(${randomUUID()},${customerId},${phone},${displayPhone(phone)},'Mobile',TRUE)`}
      await sql`UPDATE ordering_orders SET customer_id=${customerId} WHERE business='Corner Deli' AND source='web' AND customer_id IS NULL AND regexp_replace(phone_snapshot,'\\D','','g') IN (${phone.slice(-10)},${phone.replace(/\D/g,"")})`;
      return Response.json({authenticated:true},{headers:{"Set-Cookie":customerSessionCookie({sessionId:randomUUID(),customerId,authenticatedAt:Date.now(),expiresAt:Date.now()+30*86400000})}});
    }
    return Response.json({error:"Unknown action."},{status:400});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"Sign-in failed."},{status:400})}
}
