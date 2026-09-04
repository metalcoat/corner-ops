import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root=process.cwd(),lib=readFileSync(`${root}/src/lib/ordering-voice-payment.ts`,"utf8"),mx=readFileSync(`${root}/src/lib/mx-merchant.ts`,"utf8"),route=readFileSync(`${root}/src/app/api/internal/voice-payment/route.ts`,"utf8"),proxy=readFileSync(`${root}/src/proxy.ts`,"utf8"),agi=readFileSync(`${root}/asterisk/voice-payment.py`,"utf8"),dialplan=readFileSync(`${root}/asterisk/extensions.conf.template`,"utf8"),prompt=readFileSync(`${root}/src/lib/openai-phone-prompt.ts`,"utf8");

assert.match(lib,/MX_ENVIRONMENT.*production/);
assert.match(mx,/Voice-card testing is locked to the MX sandbox/);
assert.match(route,/x-voice-payment-secret/);
assert.match(proxy,/\/api\/internal\/voice-payment/);
assert.doesNotMatch(lib,/card_number\s+TEXT|cvv\s+TEXT|expiry_month\s+TEXT/i);
assert.doesNotMatch(agi,/print\(|logging\.|logger\./);
assert.match(agi,/card=expiry=cvv=zipcode=""/);
assert.match(dialplan,/EAGI_AUDIO_FORMAT=slin16/);
assert.match(dialplan,/corner-ops-voice-payment/);
assert.match(dialplan,/AI_CUSTOMER_PHONE=\$\{CUT\(AI_ROUTE,\|,3\)\}/);
assert.match(dialplan,/corner-ops-voice-payment,\$\{AI_CALL_ID\},\$\{AI_CUSTOMER_PHONE\}/);
assert.match(agi,/"callId":call_id/);
assert.match(lib,/call_id=\$\{callId\}/);
assert.match(agi,/def hear_card_number\(\)/);
assert.match(agi,/first=hear_digits\(4,4,"card-number"\)/);
assert.match(agi,/first\.startswith\(\("34","37"\)\)/);
assert.match(agi,/time\.monotonic\(\)-last_voice>2\.0/);
assert.match(agi,/def discard_prompt_echo\(\)/);
assert.match(agi,/termios\.ioctl\(3,termios\.FIONREAD/);
assert.doesNotMatch(agi,/prompt\("welcome"\)/);
assert.match(dialplan,/AI_CUSTOMER_PHONE/);
assert.match(readFileSync(`${root}/asterisk/Dockerfile`,"utf8"),/sox "\$\{source\}" -r 8000/);
assert.match(lib,/\?`tel:\$\{explicit\}`:explicit/);
assert.match(lib,/must be an explicit SIP URI for the local payment extension/);
assert.match(prompt,/must leave the AI audio and transcription path/);
assert.match(prompt,/Never ask for, repeat, infer, or transcribe a card number/);

console.log(JSON.stringify({sandboxLock:true,authenticatedInternalRoute:true,noSensitiveDatabaseColumns:true,noRecognizerLogging:true,aiTranscriptionBoundary:true,asteriskEagi:true},null,2));
