# AI Call Observability and Live Monitoring

## Goal

Owners/managers must be able to monitor AI-handled calls in real time and review completed calls later without relying on a raw transcript alone.

The observability experience should answer, at a glance:

- who is calling
- which business/queue they reached
- whether AI or a human currently owns the call
- what the customer and AI are saying
- what order/customer record is being changed
- which tools/actions the AI is calling
- what validations are passing/failing
- whether the AI is confident or likely to hand off
- how much the call is costing and how long each AI step takes

Do not expose or store hidden model chain-of-thought. Show structured action traces, tool calls, results, confidence/validation state, and concise system-generated explanations of actions.

## Live call dashboard

Suggested owner/manager view:

```text
AI CALLS - LIVE

CALL 1   315-555-1212   Jennifer Smith
Corner Deli   01:18   AI HANDLING
Order #18452 - $31.74
[LISTEN LIVE] [OPEN ORDER] [TAKE OVER]

CALL 2   315-555-3434   New customer
Corner Deli   00:42   NEEDS ATTENTION
Unresolved: delivery address
[LISTEN LIVE] [VIEW TRACE] [TRANSFER]
```

Each live call opens a detailed console.

## Detailed live console

The console should contain four synchronized panes/components.

### 1. Live audio

Authorized owners/managers can listen to the customer and AI conversation with low latency.

Controls:

- Listen Live
- Mute monitoring audio locally
- volume
- stop listening
- Take Over / Transfer to Store

Monitoring is passive unless Take Over is explicitly selected. Listening must not accidentally inject the manager microphone into the call.

Any recording/monitoring feature must be configurable to comply with applicable notice, consent, retention, and access requirements.

### 2. Live transcript

Show speaker-separated transcription with timestamps:

```text
1:14:03 PM  CUSTOMER
I need a jumbo pepperoni, mushrooms on half.

1:14:07 PM  AI
Sure. Which half should have mushrooms?

1:14:11 PM  CUSTOMER
Left half.
```

The transcript is useful for monitoring and review but is not the authoritative order record.

### 3. Live order/customer state

Show the actual structured data being changed as the call progresses:

```text
ORDER #18452 - DRAFT

Jumbo Pizza                         $18.99
  Pepperoni                         +$2.00
  Mushrooms - LEFT HALF             +$1.25

Required questions:
  ✓ Size
  ✓ Pizza sauce
  ✓ Cheese
  ✓ Pepperoni
  ✓ Mushroom placement

Subtotal                            $22.24
```

Changes should briefly highlight when an AI tool modifies the order.

The panel can also show:

- matched customer
- caller phone
- addresses
- loyalty progress
- recent/favorite orders
- payment state
- fulfillment state
- handoff state

### 4. AI action trace

Show a human-readable operational trace rather than private reasoning.

Example:

```text
01:14:02  caller_lookup
          +13155551212 -> Jennifer Smith
          SUCCESS  84 ms

01:14:05  menu_search
          "jumbo pepperoni"
          MATCH: Jumbo Pizza
          SUCCESS  91 ms

01:14:09  add_modifier
          Mushrooms / Left Half
          SUCCESS  73 ms

01:14:10  validate_order
          Missing required question: Pizza sauce
          BLOCKED

01:14:12  AI asked customer for pizza sauce
```

For each AI action, store/display:

- event timestamp
- action/tool name
- sanitized input summary
- result
- affected order/customer ID
- duration
- success/failure
- validation issue if applicable
- model used
- estimated token/audio cost where available

Sensitive payment data must never appear in the trace. Payment events may show only fields such as provider, approved/declined, amount, card brand/last4, and internal payment reference.

## Attention and confidence indicators

The system should derive operational health indicators from structured events rather than displaying hidden reasoning.

Examples:

- Green: conversation/order progressing normally
- Yellow: repeated clarification, low-confidence entity match, unresolved address, repeated tool failure
- Red: payment failure, complaint escalation, food-safety/allergy language, customer demands human, AI has exceeded allowed retries

The dashboard can show concise reasons such as:

- "Asked for item clarification 3 times"
- "Two menu matches have similar confidence"
- "Delivery address failed validation"
- "Customer requested manager"

## Owner intervention

An authorized user should be able to intervene from the console.

Possible controls:

- TAKE OVER CALL
- TRANSFER TO DELI
- TRANSFER TO MANAGER
- SEND AI MESSAGE/INSTRUCTION FOR THIS CALL
- LOCK ORDER FROM AI EDITS
- CANCEL ORDER
- FLAG FOR REVIEW

Any intervention must create an audit event.

For safety and auditability, owner instructions should change the allowed behavior/tool state for the active call rather than silently editing hidden model prompts with no record.

## Completed call review

After a call ends, retain a call record that can be searched by:

- date/time
- caller phone/customer
- order number
- AI vs human outcome
- transferred/not transferred
- completed/abandoned order
- complaint category
- call duration
- model
- call cost

The review page should support:

- recording playback when recording is enabled
- transcript
- structured order timeline
- tool/action trace
- customer-service case if applicable
- handoff reason
- final outcome
- AI cost
- latency/error metrics

## Quality review

Owners/managers should be able to mark a call:

- Good
- Needs Review
- AI Error
- Customer Error
- Menu/Rule Problem
- Employee Follow-up Needed

Optional notes can describe what should have happened.

These labels become training/quality data for improving prompts, menu aliases, deterministic rules, and handoff thresholds without modifying historical order facts.

## Performance metrics

Aggregate reporting should include:

- AI calls handled
- completed orders
- abandoned calls
- human handoff rate
- average call duration
- average response latency
- tool failure rate
- menu clarification rate
- average AI cost per call/order
- complaints handled by AI
- complaint escalation rate
- upsells offered/accepted
- correction rate after AI action
- owner quality-review scores

## Data model direction

Likely entities/events:

- `ordering_call_sessions` for the live call
- `ordering_ai_events` for model/tool/validation/action events
- `ordering_call_transcript_segments` for timestamped speaker-separated transcript
- `ordering_call_recordings` for recording metadata/storage references when enabled
- `ordering_call_reviews` for owner quality review

Raw audio should not be placed directly in PostgreSQL. Store recordings in protected object storage and keep only metadata/access references in the database.

## Access control

Live listening, recordings, transcripts, and detailed traces should be restricted by role.

Suggested permissions:

- Owner: full access
- Manager: configurable live/review access
- Employee: only calls/orders assigned or transferred to them, with no historical recording access unless explicitly permitted

All playback/listen/download/access events should be auditable where practical.

## Design principle

Observability is part of the production design, not a debugging afterthought. We should be able to watch the AI build the order and see every consequential action before trusting it with unattended production traffic.
