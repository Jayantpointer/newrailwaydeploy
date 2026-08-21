# Calling Agent

Current pieces:

- Supabase schema for callers, sessions, turns, and events
- Memory chunks stored in `memory_chunks`
- Transcript sync writes turns, caller name, and memory into Supabase
- Edge function scaffold for call orchestration
- OpenRouter Meta Llama 3.3 70B Instruct configured as the brain default
- Sarvam Saaras v3 realtime configured for STT
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
4. Set `TWILIO_STATUS_CALLBACK_URL` to the deployed `twilio-call-status` function URL.

Notes:

- `TWILIO_FROM_NUMBER` is the Twilio phone number that starts the call.
- Do not use `https://demo.twilio.com/welcome/voice/` for this setup; it will not connect to your agent.
- `TWILIO_STREAM_URL` should be your public `wss://` media bridge.
- `TWILIO_STATUS_CALLBACK_URL` should point at the Twilio call status webhook function.

Bridge env vars:

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct`
- `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`
- `SARVAM_API_KEY`
- `SARVAM_STT_URL=wss://api.sarvam.ai/speech-to-text-realtime/ws`
- `SARVAM_STT_MODEL=saaras:v3-realtime`
- `SARVAM_STT_LANGUAGE=auto`
- `SARVAM_STT_MODE=codemix`
- `SARVAM_VOICE_ID`
- `SARVAM_TTS_URL=https://api.sarvam.ai/text-to-speech`
- `SARVAM_LANGUAGE=auto` to follow the caller's detected language
- `TWILIO_STATUS_CALLBACK_URL`
- `CALL_MEMORY_SYNC_URL`

When `SARVAM_STT_LANGUAGE=auto`, Saaras realtime detects the caller's language and the bridge instructs OpenRouter to reply in that language. `SARVAM_LANGUAGE=auto` makes Bulbul TTS follow that detected language. Sarvam TTS supports English, Hindi, Bengali, Gujarati, Kannada, Malayalam, Marathi, Odia, Punjabi, Tamil, Telugu, and Hinglish through Hindi voice output.

Run locally with `npm install` then `npm start`.
