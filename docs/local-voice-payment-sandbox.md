# Local voice-payment sandbox

This path is intentionally available only while `MX_ENVIRONMENT=sandbox`. It transfers a confirmed card order out of OpenAI Realtime before collecting any payment data. A local PocketSphinx process receives 16 kHz audio from Asterisk EAGI, recognizes a restricted digit vocabulary, and submits the transient values to MX. It does not create recordings or card-data transcripts.

## 3CX routing

Create extension/dial route `101` through the existing Corner Ops Asterisk trunk. The Asterisk dialplan handles `101` locally instead of forwarding it to OpenAI. Set `OPENAI_PHONE_VOICE_PAYMENT_TARGET` when the OpenAI SIP transfer requires a full SIP URI; otherwise the app uses extension `101`.

Failed recognition or authorization routes to extension `95` by default. Override these without changing code:

```env
ASTERISK_VOICE_PAYMENT_EXTENSION="101"
ASTERISK_VOICE_PAYMENT_FALLBACK_EXTENSION="95"
OPENAI_PHONE_VOICE_PAYMENT_TARGET="101"
VOICE_PAYMENT_INTERNAL_SECRET="a-dedicated-random-secret"
```

During the sandbox proof of concept, `THREE_CX_CRM_SECRET` is accepted as the internal Asterisk-to-app secret when a dedicated voice-payment secret has not been configured. Configure the dedicated secret before any compliance review.

## Call test

1. Keep MX in sandbox and disable 3CX recording for the test route.
2. Call the configured AI test DID and complete an order.
3. Choose card and, for delivery, answer the driver-tip question.
4. The AI announces the protected transition and transfers to `101`.
5. Speak the MX-provided sandbox card number slowly in groups of four.
6. Confirm the masked last four, then speak expiration, security code, and five-digit ZIP separately.
7. Confirm the order becomes paid and retains only MX reference, brand, and last four digits.
8. Cause one recognition or sandbox-decline failure and confirm fallback rings extension `95`.

Never use a real card in this sandbox path. The speech accuracy gate must be tested over real cellular calls and noisy calls before any production design is considered.
