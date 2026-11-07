import { isoJson } from "@/lib/timestamp-values";
import { abandonVoicePayment, chargeVoicePayment, claimVoicePayment, VoicePaymentError, voicePaymentInternalAuthorized } from "@/lib/ordering-voice-payment";

export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function POST(request:Request){
  if(!voicePaymentInternalAuthorized(request.headers.get("x-voice-payment-secret")))return isoJson({error:"Unauthorized."},{status:401});
  try{
    const body=await request.json() as Record<string,unknown>,action=String(body.action||"");
    if(action==="claim")return isoJson(await claimVoicePayment(String(body.callerPhone||""),String(body.callId||"")));
    if(action==="charge")return isoJson(await chargeVoicePayment({sessionId:String(body.sessionId||""),cardNumber:String(body.cardNumber||""),expiryMonth:String(body.expiryMonth||""),expiryYear:String(body.expiryYear||""),cvv:String(body.cvv||""),avsZip:String(body.avsZip||"")}));
    if(action==="abandon"){await abandonVoicePayment(String(body.sessionId||""),String(body.code||"recognition_failed"));return isoJson({abandoned:true})}
    return isoJson({error:"Unknown voice-payment action."},{status:400});
  }catch(error){
    if(error instanceof VoicePaymentError)return isoJson({error:error.message},{status:409});
    console.error("Voice payment failed without card-data logging.",{errorType:error instanceof Error?error.name:"unknown"});
    return isoJson({error:"Voice payment could not be completed."},{status:500});
  }
}
