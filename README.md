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
| Elder mobile app | A mobile calling experience for the older adult. | [Dost mobile elder app](https://github.com/blankirigaya/elder-app/tree/main/elder-mobile/elders-app) |
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
    +--> Elder and family companion interfaces
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
