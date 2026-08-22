# Dost

**A phone-first AI companion that remembers everyday routines, keeps conversations personal, and makes meaningful changes visible over time.**

Dost is built for older adults who prefer an ordinary phone call over another app to learn. It talks in natural Hindi, English, and Hinglish, remembers what matters from earlier calls, and follows up with warmth and curiosity rather than turning a conversation into a questionnaire.

The goal is not to make calls longer. It is to make each call more useful: a familiar conversation can gently confirm routines, notice changes, and preserve the context a family may otherwise miss.

## Why Dost

Small changes are often easy to overlook in day-to-day family life. A person who usually takes a morning walk, eats an apple after breakfast, watches cricket with a grandchild, or follows a preferred routine may change course for a completely ordinary reason. One call should not become a diagnosis.

But when a conversational companion remembers those routines and asks about them naturally, it can build a longitudinal picture rather than treating every call as a blank slate.

Dost turns ordinary conversation into continuity:

- remembers stated routines, interests, family context, preferences, and open threads
- asks relevant questions at the right time of day
- follows up on what the caller actually says
- lets the caller's latest statement override an older memory
- makes a gentle clarification possible when a current answer conflicts with a relevant past memory
- keeps phone, mobile, and family-facing experiences connected through shared context

## Active Memory Verification

Dost does more than wait for a caller to volunteer a change. When a stored routine is relevant, it can naturally ask about it and learn whether it still holds.

```text
Past memory
  "Ramesh eats one apple every morning after breakfast."

Today's conversation
  Dost: "Aaj subah apple kha liya?"
  Ramesh: "Nahi, aaj mann nahi tha."

Interpretation
  A routine changed today. Dost treats it as a gentle follow-up opportunity,
  not a diagnosis or an accusation.
```

If a current statement conflicts with a relevant memory, Dost can say:

> "Last time I thought you liked sugar in your tea, but today you said you don't. Has your taste changed?"

The current answer always takes priority. Memories are useful context, not unquestionable truth.

## Example Call Flow

```text
Stored context: morning walk at 7am, apple after breakfast, BP medicine routine,
grandson Arjun visits on Sundays, enjoys cricket.

Dost: "Namaste Ramesh ji. Subah ki walk ho gayi aaj?"
Caller: "Haan, gayi thi. Thodi chhoti thi aaj."

Dost: "Achha, phir bhi ho gayi. Aur apple kha liya subah ka?"
Caller: "Nahi, aaj mann nahi tha."

Dost: "Hmm, kabhi kabhi hota hai. Bhookh nahi thi, ya kuch aur?"

Dost then follows the caller's answer, rather than moving through a fixed checklist.
```

This approach gives routine changes context. A skipped apple may be a one-off. A repeated change can become a useful thread for a later call. Dost is a companion, not a clinician: it does not diagnose, prescribe, or make medical claims.

## FAR AWAY 2026: Challenge Solution

### Challenge

This project addresses **FAR AWAY 2026, Round 2, Challenge #970: User Segmentation: Mismatch Warning**.

The challenge asks for an MVP capability that can:

1. Maintain recorded context about a user.
2. Compare current behavior with that context.
3. Warn or respond when the current behavior conflicts with the recorded context.
4. Handle both a normal case and a realistic exception case.

Dost solves this as a conversational, longitudinal memory problem rather than as a one-time form validation problem. The system does not ask a user to fill out a checklist and then compare two static records. It learns context from ordinary calls, brings relevant context back into later calls, asks a natural verification question, and gives the caller a chance to explain a change.

### The core design decision

The central design decision is to make mismatch detection **active but non-accusatory**.

Instead of waiting for a caller to spontaneously mention that a routine changed, Dost can use a relevant recorded habit as a conversational opening:

```text
Recorded context:
  "The caller usually eats one apple every morning."

Active verification:
  "Aaj subah apple kha liya?"

Current answer:
  "Nahi, aaj mann nahi tha."

Result:
  The current behavior differs from the recorded routine.
  Dost asks a gentle follow-up instead of raising an alarm immediately.
```

This matters because the same answer can have very different meanings. Skipping an apple once may be normal. Repeatedly losing interest in food, forgetting a routine, or describing a new difficulty may deserve a later family-facing review. The conversation must collect context before it labels a change as meaningful.

### End-to-end implementation

#### 1. Establish the person identity

At the start of a call, Dost asks for the caller's name rather than blindly trusting the phone number as the person's identity.

The current identity rule is:

```text
same owner + same normalized full name -> same caller_id and history
same phone + different full name       -> different caller_id and history
no captured name                       -> caller remains unassigned
```

Names are normalized for whitespace and case-insensitive matching. Phone numbers remain useful contact metadata, but they are not the primary identity key. This is important for Indian family phones and shared household numbers, where multiple people may use one number.

The database now has a unique name index scoped to the owner. This prevents accidental duplicate profiles for the same named person while allowing different people on the same phone to remain separate.

#### 2. Store only stated context

After a call, the transcript and memory extraction flow identify facts that were actually stated by the caller. The extracted context is stored across the caller profile and `memory_chunks`:

- `callers.full_name`: the normalized identity name
- `callers.current_activity`: what the caller is doing or recently did
- `callers.interests`: stated interests and recurring topics
- `callers.symptoms`: explicitly reported symptoms, not guesses
- `memory_chunks.content`: the natural-language memory statement
- `memory_chunks.chunk_type`: profile, preference, follow-up, task, or call memory
- `memory_chunks.facts`: structured details such as activities, interests, symptoms, and names
- `memory_chunks.created_at`: chronology for understanding what came first
- `memory_chunks.importance`: a coarse signal for memory relevance

Claude Sonnet performs structured extraction after the call. The system prompt explicitly instructs it not to invent symptoms, interests, routines, or names. This prevents a model inference from silently becoming a user fact.

#### 3. Load longitudinal context before the next conversation

When a caller is identified, the bridge loads:

1. The caller's profile.
2. All related memory chunks.
3. The memory chunks in chronological order.
4. The profile and memory history into the live system context.

This gives the reply model access to continuity across calls. The model can see that a person previously mentioned an apple routine, a morning walk, a tea preference, a family visit, or an open follow-up thread.

The history is not presented to the caller as a surveillance report. It is used selectively: one relevant memory or routine at a time, in the same conversational style as a family member remembering something they were told earlier.

#### 4. Proactively verify a relevant routine

The first post-name question is selected using local time by default:

- morning: breakfast or a morning routine
- midday: lunch
- afternoon: tea or a light snack
- evening: dinner

The live conversation policy then encourages Dost to continue from the answer. For example:

```text
Dost: "Have you had your lunch?"
Caller: "Yes, I had dal and rice."
Dost: "That sounds comforting. Was it good today?"
```

The answer itself can also expose a mismatch:

```text
Dost: "Aaj subah apple kha liya?"
Caller: "No, I did not want one today."
Dost: "Hmm, was it that you were not hungry, or did you just feel like something else?"
```

The follow-up is intentionally important but gentle. It asks for the reason or outcome that best explains the change, rather than firing a list of medical questions.

#### 5. Compare current statements with past memories

The live system prompt contains a dedicated memory-consistency policy:

- saved memories are useful but can be stale
- relevant conflicts should not be silently ignored
- the caller should not be accused of contradicting themselves
- the assistant should ask whether the preference or situation changed
- the current statement has priority until clarified
- unrelated or sensitive old memories should not be raised

For a tea preference, the behavior is:

```text
Past:    "I like sugar in my tea."
Today:   "I hate sugar in my tea."
Dost:    "Last time I thought you liked sugar in your tea, but today you said you don't. Has your taste changed?"
```

This handles both preference drift and routine drift. It also avoids a common failure mode in memory systems: treating old context as more authoritative than what the person is saying now.

#### 6. Continue the conversation instead of stopping at the mismatch

Mismatch detection is useful only if the conversation understands the reason behind the difference. Dost is instructed to:

- ask one meaningful follow-up after a substantive answer
- ask about the detail, feeling, person, reason, or outcome most likely to clarify the change
- show energy and specific interest when the caller shares something important
- use short reactions and backchannels such as “hmm”, “ahh”, “yeah”, and “achha”
- follow the caller's topic instead of switching to a new checklist item
- treat a one-off exception as a one-off until a pattern appears

This produces a more useful distinction:

```text
Routine: eats an apple daily
Today: skipped the apple because there was no appetite
Interpretation: one routine deviation; ask gently and monitor context

Routine: eats an apple daily
Today and several later calls: repeatedly reports no appetite
Interpretation: repeated change; eligible for a consented family review flow
```

The second interpretation is a future structured alert layer. The current MVP already provides the memory, active question, context comparison, and conversational clarification needed to build that layer responsibly.

### Normal case

The normal case is a routine confirmation:

```text
Stored: the caller usually eats an apple after breakfast.
Question: "Aaj subah apple kha liya?"
Answer: "Haan, kha liya."
Follow-up: "Achha, meetha tha?"
Outcome: the routine is confirmed and the conversation continues naturally.
```

The system does not create a warning simply because a memory was queried. It records the answer as confirmation and follows the caller's experience.

### Realistic exception case

The realistic exception is an intentional or temporary change:

```text
Stored: the caller usually eats an apple every morning.
Question: "Aaj subah apple kha liya?"
Answer: "Nahi, aaj mann nahi tha."
Follow-up: "Bhookh nahi thi, ya kuch aur khaane ka mann tha?"
Outcome: the change is acknowledged, explained if the caller wishes,
         and not treated as proof of illness or confusion.
```

Other valid exceptions include travel, fasting, a guest bringing different food, a changed preference, a late wake-up, or simply not wanting the routine that day. Dost gives the caller autonomy to explain, correct the memory, or move on.

### What is implemented versus what follows

Implemented in the MVP:

- persistent caller profiles and chronological memory chunks
- name-based identity that supports shared phones
- live memory loading for identified callers
- time-aware routine questions
- proactive conversational follow-ups
- prompt-level comparison of current statements with relevant memories
- gentle handling of changed preferences and one-off deviations
- post-call extraction of stated facts and memories

Next structured layer:

- persist each routine check as a typed verification event
- classify outcomes as confirmed, changed, skipped, unclear, or unable to answer
- count repeated deviations over a configurable time window
- calculate a transparent drift score without using call duration as a proxy
- show a family-facing review card with the evidence and the caller's own words
- notify a nominated family member only with consent and an explicit threshold

This boundary is deliberate. The MVP demonstrates the mismatch-warning interaction without pretending that one skipped apple or one confused answer is a clinical signal.

## What We Built

### Natural voice conversations

- Twilio outbound calling and media streams
- Sarvam Saaras v3 realtime speech-to-text for Indian-language and code-mixed speech
- Sarvam Bulbul v3 text-to-speech, with configurable voice, pace, and post-synthesis gain
- Claude Haiku live replies for low-latency conversation and Claude Sonnet memory extraction
- Hindi, English, Hinglish, and language-aware responses

### Conversational intelligence

- Warm opening and a time-aware first routine question after the caller gives their name
- Breakfast, lunch, tea, or dinner prompts selected using `Asia/Kolkata` time by default
- Meaningful follow-up questions about details, feelings, people, reasons, and outcomes
- Natural backchannels and punctuation-based pauses for spoken delivery
- Respectful exits when the caller is tired, busy, quiet, or asks to stop
- No elderspeak, guilt, false dependency, or interrogation-style rapid questioning

### Persistent, person-specific memory

- Profile facts for names, interests, current activities, and reported symptoms
- Chronological `memory_chunks` loaded into the live prompt for a matched caller
- Name-based identity: same normalized full name shares history; different names can use the same phone without being merged
- Memory-consistency policy for gently clarifying relevant changes in preferences or routines

### Call records and operational context

- Supabase storage for callers, call sessions, turns, events, and extracted memories
- Twilio status callbacks for call lifecycle updates
- Railway bridge for real-time media, STT, reply generation, and TTS delivery

## Companion Interfaces

Dost is designed as an ecosystem, not just a call engine.

| Interface | Purpose | Repository |
| --- | --- | --- |
| Family mobile app | A family-facing memory capsule dashboard for shared context and follow-up. | [Dost mobile family app](https://github.com/blankirigaya/elder-app/tree/main/elder-mobile/family-app) |
| Web demo | Product and family-facing web experience for Dost. | [Dost web demo](https://github.com/Abhishek9639/Call-Me) |

## Architecture

```text
Caller phone
    |
    v
Twilio Voice + Media Stream
    |
    v
Railway voice bridge
    |-- Sarvam Saaras v3: realtime transcription
    |-- Claude Haiku: live conversational response
    |-- Sarvam Bulbul v3: synthesized voice response
    |-- Claude Sonnet: post-call memory extraction
    |
    v
Supabase
    |-- callers
    |-- call_sessions
    |-- call_turns and call_events
    `-- memory_chunks
    |
    `--> Family companion interfaces
```

## Safety and Trust

- Dost is honest about being software if asked. It does not claim to be human.
- It does not diagnose, prescribe medication, or replace a doctor, nurse, or counsellor.
- It treats older memories as possibly stale and current answers as authoritative.
- It only surfaces a past memory when it is relevant to the caller's current topic.
- It does not use pressure, guilt, or manipulative endings to keep a caller engaged.
- Calls and extracted context should be operated with clear consent, access control, and a data-retention policy appropriate for the deployment.

## Current Scope and Next Step

Implemented today:

- cross-call memory retrieval and name-based caller histories
- time-aware conversation openings and contextual follow-ups
- prompt-level routine verification and gentle conflict clarification
- live outbound calling, transcription, TTS, session recording, and memory extraction

The next product layer is a structured active-mismatch service: persist routine checks, distinguish one-off changes from repeated drift, and deliver any family-facing alerts only after configurable thresholds and consented review flows.

## Run Locally

```bash
npm install
npm start
```

The bridge runs with `node bridge/server.js`.

## Required Configuration

### Core services

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`
- `SARVAM_API_KEY`
- `CALL_MEMORY_SYNC_URL`

### Voice and language tuning

- `RESPONSE_MODEL=claude-haiku-4-5-20251001`
- `MEMORY_EXTRACTION_MODEL=claude-sonnet-4-6`
- `SARVAM_STT_MODEL=saaras:v3-realtime`
- `SARVAM_STT_LANGUAGE=auto`
- `SARVAM_STT_MODE=codemix`
- `SARVAM_VOICE_ID=shreya`
- `SARVAM_LANGUAGE=auto`
- `SARVAM_TTS_PACE=0.88`
- `SARVAM_TTS_GAIN=1.2`
- `SAATHI_TIME_ZONE=Asia/Kolkata`
- `SARVAM_SILENCE_DURATION_MS=450`
- `SARVAM_MIN_SPEECH_DURATION_MS=160`
- `FINAL_TRANSCRIPT_FLUSH_DELAY_MS=1200`
- `ASSISTANT_REPLY_THINK_MS=120`

### Twilio

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `TWILIO_STREAM_URL` set to the public `wss://` Railway bridge
- `TWILIO_VOICE_WEBHOOK_URL` set to the deployed `twilio-voice` function
- `TWILIO_STATUS_CALLBACK_URL` set to the deployed `twilio-call-status` function

## Deployment Notes

Apply migrations and deploy the Supabase functions:

```bash
supabase db push
supabase functions deploy twilio-start-call
supabase functions deploy twilio-voice
supabase functions deploy twilio-call-status
supabase functions deploy call-memory-sync
supabase functions deploy call-orchestrator
```

Deploy the bridge to Railway with the same Supabase, Anthropic, Sarvam, Twilio, and memory-sync environment variables.
