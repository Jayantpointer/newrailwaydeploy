# Calling Agent

Current pieces:

- Supabase schema for callers, sessions, turns, and events
- Memory chunks stored in `memory_chunks`
- Transcript sync writes turns, caller name, and memory into Supabase
- Edge function scaffold for call orchestration
- Gemini 2.5 Flash configured as the brain default
- ElevenLabs used for voice output
- Twilio outbound call starter and voice webhook scaffold
- Railway bridge server for Twilio media streams

Next step is to connect the actual realtime audio loop and provider webhooks.

For post-call transcript sync, send the finished transcript to `call-memory-sync`.

Example:

```bash
curl -X POST "https://wtphjiztyavgdnphcvlv.supabase.co/functions/v1/call-memory-sync" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "SESSION_ID",
    "owner_id": "USER_ID",
    "phone_e164": "+15551234567",
    "summary": "Call summary here",
    "transcript": "My name is ...",
    "memory_chunk": {
      "chunk_type": "caller_profile",
      "content": "Caller prefers evening callbacks",
      "tags": ["preference"]
    }
  }'
```

For Twilio outbound calls:

1. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.
2. Deploy `twilio-voice` as the TwiML webhook and set `TWILIO_VOICE_WEBHOOK_URL` to that public URL.
3. Deploy `twilio-start-call` and call it with the destination number.

Notes:

- `TWILIO_FROM_NUMBER` is the Twilio phone number that starts the call.
- Do not use `https://demo.twilio.com/welcome/voice/` for this setup; it will not connect to your agent.
- `TWILIO_STREAM_URL` should be your public `wss://` media bridge.

Bridge env vars:

- `GROQ_API_KEY`
- `GROQ_MODEL=openai/gpt-oss-120b`
- `GROQ_STT_MODEL=whisper-large-v3-turbo`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ELEVENLABS_MODEL_ID=eleven_multilingual_v2`
- `CALL_MEMORY_SYNC_URL`

Run locally with `npm install` then `npm start`.
