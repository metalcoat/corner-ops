# Corner Deli AI phone production foundation

## Runtime design

Incoming 3CX calls travel through the existing Asterisk bridge to OpenAI Realtime. The verified webhook accepts only configured test DIDs, loads current phone settings and business timing, then starts a persistent sideband connection. The sideband records transcript segments, ordering-tool activity, errors, interruption events, and response timing without sitting in the audio path.

Conversation instructions are layered in `openai-phone-prompt.ts`: stable behavior, ordering policy, Corner Deli shorthand, deployment mode, live business state, and per-call context. Menu, pricing, customers, availability, addresses, order state, and POS acceptance remain authoritative backend data rather than prompt prose.

## Safe rollout

`shadow` is the default and required initial mode. Calls can create and confirm structured drafts, but SEND returns `ORDER_REVIEW_PENDING` and cannot claim kitchen acceptance. `assisted` also requires staff review. `autonomous` is reserved for a later rollout after reviewed-call accuracy meets the business threshold.

Managers can change the answering switch, rollout mode, realtime model, response-word budget, upsell limit, VAD eagerness, recording flag, and transcript retention in POS Settings. Recording is off by default. Changing the recording flag only records policy intent; audio storage is not implemented and must not be represented as active recording.

## Testing and operations

- Live processing: POS Deli main order screen, which already shows active calls, order changes, tool activity, and handoff controls.
- Quality review: POS Deli Reports, including call transcript, model/mode, latency percentiles, resulting draft/order, and manager review labels.
- Regression commands: `npm run test:openai-phone`, `npm run test:ai-phone-conversation`, and `npm run test:ai-ordering`.
- Primary latency samples: customer speech stopped to model response creation and to first generated audio. Barge-in events are recorded whenever customer speech starts during an active response.

## Current milestone boundary

This foundation supplies realtime calling, structured ordering integration, prompt layering, barge-in configuration, transcripts, timing, shadow/assisted safety gates, manager controls, and review tooling. Autonomous production ordering remains intentionally disabled by the default mode. Audio retention, automated audio-condition evaluation, staff correction editing, and automated promotion of reviewed mistakes into regression fixtures are later milestones.
