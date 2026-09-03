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
assert.match(prompt,/must leave the AI audio and transcription path/);
assert.match(prompt,/Never ask for, repeat, infer, or transcribe a card number/);

console.log(JSON.stringify({sandboxLock:true,authenticatedInternalRoute:true,noSensitiveDatabaseColumns:true,noRecognizerLogging:true,aiTranscriptionBoundary:true,asteriskEagi:true},null,2));
