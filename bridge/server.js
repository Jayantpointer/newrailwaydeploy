const http = require("node:http");
const { URL } = require("node:url");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CALL_MEMORY_SYNC_URL = process.env.CALL_MEMORY_SYNC_URL || "";
const ANTHROPIC_API_KEY = envText("ANTHROPIC_API_KEY");
const ANTHROPIC_MODEL = envText("ANTHROPIC_MODEL", "claude-sonnet-5");
const GROQ_API_KEY = envText("GROQ_API_KEY");
const GROQ_STT_MODEL = envText("GROQ_STT_MODEL", "whisper-large-v3-turbo");
function envText(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

const ELEVENLABS_API_KEY = envText("ELEVENLABS_API_KEY");
const ELEVENLABS_VOICE_ID = envText("ELEVENLABS_VOICE_ID");
const ELEVENLABS_MODEL_ID = envText("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2");
const TURN_SILENCE_MS = 2600;

let supabase = null;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return supabase;
}

const state = {
  startedAt: Date.now(),
  activeConnections: 0,
  lastSessionId: null,
  lastEvent: null,
  lastError: null,
  recentEvents: [],
  twilioAudioPackets: 0,
  elevenLabsRequests: 0,
  elevenLabsErrors: 0,
  anthropicRequests: 0,
  anthropicErrors: 0,
  groqSttRequests: 0,
  groqSttErrors: 0,
};

function json(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function logEvent(event) {
  state.lastEvent = { ...event, at: new Date().toISOString() };
  state.recentEvents.push(state.lastEvent);
  if (state.recentEvents.length > 30) state.recentEvents.shift();
  console.log(JSON.stringify(state.lastEvent));
}

logEvent({
  type: "config.loaded",
  voice_provider: "elevenlabs",
  elevenlabs_api_key_configured: Boolean(ELEVENLABS_API_KEY),
  elevenlabs_voice_id_configured: Boolean(ELEVENLABS_VOICE_ID),
  elevenlabs_model_id: ELEVENLABS_MODEL_ID,
  anthropic_api_key_configured: Boolean(ANTHROPIC_API_KEY),
  anthropic_model: ANTHROPIC_MODEL,
  groq_stt_api_key_configured: Boolean(GROQ_API_KEY),
  groq_stt_model: GROQ_STT_MODEL,
});

const MULAW_BIAS = 0x84;

function muLawByteToPcmSample(muLawByte) {
  const u = (~muLawByte) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

function twilioMulawToWavBase64(payloads) {
  const pcmSamples = [];

  for (const payload of payloads) {
    const mulaw = Buffer.from(payload, "base64");
    for (const byte of mulaw) {
      pcmSamples.push(muLawByteToPcmSample(byte));
    }
  }

  const pcmBuffer = Buffer.alloc(pcmSamples.length * 2);
  for (let i = 0; i < pcmSamples.length; i += 1) {
    pcmBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, pcmSamples[i])), i * 2);
  }

  const sampleRate = 8000;
  const byteRate = sampleRate * 2;
  const blockAlign = 2;
  const dataSize = pcmBuffer.length;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, 44);

  return wav.toString("base64");
}

function computePacketEnergy(payload) {
  const mulaw = Buffer.from(payload, "base64");
  if (!mulaw.length) return 0;

  let total = 0;
  for (const byte of mulaw) {
    total += Math.abs(muLawByteToPcmSample(byte));
  }
  return total / mulaw.length;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function detectLanguageMode(text) {
  const sample = (text || "").trim();
  if (!sample) return "en";

  const hasHindiScript = /[\u0900-\u097F]/.test(sample);
  const hasEnglishWords = /\b(the|and|you|call|name|hello|thanks|yes|no|please)\b/i.test(sample);
  const hasRomanHindi = /\b(ka|ki|ke|hai|haan|nahi|nahi|kya|mera|meri|aap|main|mein|thoda|thodi|abhi|kal|aaj|phone|baad)\b/i.test(sample);

  if (hasHindiScript && hasEnglishWords) return "hinglish";
  if (hasHindiScript || hasRomanHindi) return "hi";
  if (hasEnglishWords) return "en";
  return "en";
}

function buildFallbackMemoryChunk(transcript) {
  const text = transcript.trim();
  if (!text) return null;

  const nameMatch = text.match(/(?:my name is|i am|i'm|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i);
  if (nameMatch?.[1]) {
    return {
      chunk_type: "caller_profile",
      content: `Caller introduced themselves as ${nameMatch[1].trim()}`,
      source_text: text,
      tags: ["name"],
      language: detectLanguageMode(text),
      importance: 90,
      facts: { name: nameMatch[1].trim() },
    };
  }

  const preferenceHints = [];
  if (/prefer|like|usually|best/i.test(text)) preferenceHints.push("preference");
  if (/tomorrow|later|next week|follow up|callback/i.test(text)) preferenceHints.push("follow_up");

  return {
    chunk_type: preferenceHints.includes("follow_up") ? "follow_up" : "call_memory",
    content: text.length > 280 ? `${text.slice(0, 277)}...` : text,
    source_text: text,
    tags: preferenceHints,
    language: detectLanguageMode(text),
    symptoms: [],
    importance: preferenceHints.length ? 75 : 50,
    facts: {},
  };
}

async function extractImportantMemory(transcript) {
  const text = transcript.trim();
  if (!text) return null;

  if (!ANTHROPIC_API_KEY) return null;

  try {
    state.anthropicRequests += 1;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        temperature: 0.2,
        system:
          "Extract only durable, non-sensitive call memory. Return strict JSON with keys summary and memory_chunk. The memory_chunk should be null if nothing important was said. Use chunk_type one of caller_profile, follow_up, preference, task, call_memory. Exclude secrets, health details, payment details, or private identifiers unless they are explicitly needed for follow-up. Keep content short and factual.",
        messages: [
          {
            role: "user",
            content: `Transcript:\n${text}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      state.anthropicErrors += 1;
      return null;
    }

    const payload = await response.json();
    const content = payload?.content?.find((block) => block?.type === "text")?.text?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content);
    const memoryChunk = parsed.memory_chunk || null;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      memoryChunk: memoryChunk && memoryChunk.content ? { ...memoryChunk, symptoms: Array.isArray(memoryChunk.symptoms) ? memoryChunk.symptoms : [] } : null,
    };
  } catch {
    state.anthropicErrors += 1;
    const fallback = buildFallbackMemoryChunk(text);
    return {
      summary: text.slice(0, 500),
      memoryChunk: fallback && fallback.importance >= 75 ? fallback : null,
    };
  }
}

async function transcribeAudioWithGroq(audioWavBase64, language) {
  if (!GROQ_API_KEY || !audioWavBase64) return "";

  try {
    state.groqSttRequests += 1;
    const audioBuffer = Buffer.from(audioWavBase64, "base64");
    const form = new FormData();
    form.append("model", GROQ_STT_MODEL);
    form.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
    if (language === "hi") form.append("language", "hi");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });

    if (!response.ok) {
      state.groqSttErrors += 1;
      return "";
    }

    const payload = await response.json();
    return (payload?.text || "").trim();
  } catch (error) {
    state.groqSttErrors += 1;
    logEvent({ type: "groq.error", error: error.message, stage: "transcribe" });
    return "";
  }
}

async function generateFallbackReply(turns, language, systemPrompt = "") {
  const text = turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n").trim();
  if (!ANTHROPIC_API_KEY || !text) return "Sorry, I didn’t catch that. What name should I use for you?";

  try {
    state.anthropicRequests += 1;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        temperature: 0.3,
        system: `${systemPrompt ? `${systemPrompt}\n` : ""}You are a warm calling assistant. Speak in ${language === "hi" ? "Hindi" : language === "hinglish" ? "Hinglish" : "English"}. Keep it short and ask one simple question at a time. If this is the first reply after the greeting, ask for the caller's name. Avoid sensitive details.`,
        messages: [{ role: "user", content: `Conversation:\n${text}` }],
      }),
    });

    if (!response.ok) {
      state.anthropicErrors += 1;
      return "Sorry, I didn’t catch that. What name should I use for you?";
    }

    const payload = await response.json();
    return payload?.content?.find((block) => block?.type === "text")?.text?.trim() || "Sorry, I didn’t catch that. What name should I use for you?";
  } catch {
    state.anthropicErrors += 1;
    return "Sorry, I didn’t catch that. What name should I use for you?";
  }
}

async function pushTranscriptChunk({ sessionId, ownerId, callerId, transcript, fullName, phoneE164, role = "user", memoryChunk = null, summary = "", turns = [], metadata = {} }) {
  if (!CALL_MEMORY_SYNC_URL || !transcript.trim()) return;
  const response = await fetch(CALL_MEMORY_SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      owner_id: ownerId,
      caller_id: callerId,
      phone_e164: phoneE164,
      full_name: fullName,
      summary,
      transcript,
      memory_chunk: memoryChunk,
      metadata,
      turns: turns.length ? turns : [{ role, content: transcript }],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`call-memory-sync failed: ${details}`);
  }
}

async function synthesizeWithElevenLabs(text, languageHint = "") {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID || !text.trim()) return null;

  state.elevenLabsRequests += 1;
  try {
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}/stream`);
    url.searchParams.set("output_format", "ulaw_8000");
    logEvent({ type: "elevenlabs.request", voice_id: ELEVENLABS_VOICE_ID, model_id: ELEVENLABS_MODEL_ID });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL_ID,
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      state.elevenLabsErrors += 1;
      logEvent({ type: "elevenlabs.error", status: response.status, statusText: response.statusText, details });
      return null;
    }

    return Buffer.from(await response.arrayBuffer()).toString("base64");
  } catch (error) {
    state.elevenLabsErrors += 1;
    logEvent({ type: "elevenlabs.error", error: error.message });
    return null;
  }
}

async function sendAudioToTwilio(twilioWs, streamSid, text, languageHint = "") {
  const audioBase64 = await synthesizeWithElevenLabs(text, languageHint);
  if (audioBase64 && streamSid && twilioWs.readyState === WebSocket.OPEN) {
    state.twilioAudioPackets += 1;
    logEvent({ type: "audio.sent", source: "elevenlabs", stream_sid: streamSid });
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: audioBase64 },
    }));
  }
}

async function loadAgentSettings() {
  const client = getSupabase();
  if (!client) {
    state.lastError = "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
    logEvent({ type: "config.error", message: state.lastError });
    return {};
  }

  const { data, error } = await client
    .from("agent_settings")
    .select("agent_name,system_prompt")
    .eq("id", 1)
    .maybeSingle();

  if (error) throw error;
  return data || {};
}

async function ensureSession({ sessionId, ownerId, callerId, phoneE164, fullName, callSid }) {
  const client = getSupabase();
  if (!client) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  if (sessionId) {
    const { data, error } = await client
      .from("call_sessions")
      .select("id, owner_id, caller_id")
      .eq("id", sessionId)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  let resolvedCallerId = callerId || null;
  if (phoneE164) {
    const callerQuery = ownerId
      ? client.from("callers").select("id").eq("phone_e164", phoneE164).eq("owner_id", ownerId)
      : client.from("callers").select("id").eq("phone_e164", phoneE164).is("owner_id", null);

    const { data: existingCaller } = await callerQuery.maybeSingle();

    if (existingCaller?.id) {
      resolvedCallerId = existingCaller.id;
      if (fullName) {
        await client.from("callers").update({ full_name: fullName }).eq("id", resolvedCallerId);
      }
    } else {
      const { data: newCaller, error: insertError } = await client
        .from("callers")
        .insert({ owner_id: ownerId || null, phone_e164: phoneE164, full_name: fullName || null })
        .select("id")
        .single();

      if (insertError) throw insertError;
      resolvedCallerId = newCaller.id;
    }
  }

  const { data: session, error } = await client
    .from("call_sessions")
    .insert({
      owner_id: ownerId || null,
      caller_id: resolvedCallerId,
      provider_name: "twilio",
      provider_call_id: callSid || null,
      direction: "outbound",
      status: "live",
      started_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      metadata: { call_sid: callSid || null, source: "media_stream" },
    })
    .select("id, owner_id, caller_id")
    .single();

  if (error) throw error;
  return session;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      activeConnections: state.activeConnections,
      lastSessionId: state.lastSessionId,
      lastEvent: state.lastEvent,
      lastError: state.lastError,
      voiceProvider: "elevenlabs",
      elevenLabsVoiceId: ELEVENLABS_VOICE_ID || null,
      elevenLabsConfigured: Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID),
      recentEvents: state.recentEvents,
      twilioAudioPackets: state.twilioAudioPackets,
      elevenLabsRequests: state.elevenLabsRequests,
      elevenLabsErrors: state.elevenLabsErrors,
      anthropicRequests: state.anthropicRequests,
      anthropicErrors: state.anthropicErrors,
      groqSttRequests: state.groqSttRequests,
      groqSttErrors: state.groqSttErrors,
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    });
  }

  if (req.method === "POST" && url.pathname === "/sync") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(raw || "{}");
        if (!payload.session_id) return json(res, 400, { error: "Missing session_id" });
        if (!CALL_MEMORY_SYNC_URL) return json(res, 500, { error: "Missing CALL_MEMORY_SYNC_URL" });

        const response = await fetch(CALL_MEMORY_SYNC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const text = await response.text();
        res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") || "application/json" });
        res.end(text);
      } catch (error) {
        json(res, 500, { error: error.message });
      }
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname !== "/media-stream") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", async (twilioWs, req) => {
  state.activeConnections += 1;
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session_id") || "";
  const ownerId = url.searchParams.get("owner_id") || "";
  const callerId = url.searchParams.get("caller_id") || "";
  const phoneE164 = url.searchParams.get("phone_e164") || "";
  const fullName = url.searchParams.get("full_name") || "";

  let systemPrompt = "";
  let streamSid = "";
  let callSid = "";
  let resolvedSession = { id: sessionId, owner_id: ownerId || null, caller_id: callerId || null };
  let userTranscript = "";
  const conversationTurns = [];
  let greeted = false;
  let conversationLanguage = "en";
  let twilioReady = false;
  const pendingTwilioMessages = [];
  const bufferedSpeechPackets = [];
  let turnTimer = null;
  let turnProcessing = false;
  let turnQueued = false;

  logEvent({ type: "ws.connection", session_id: sessionId, path: url.pathname });

  twilioWs.on("message", (raw) => {
    if (!twilioReady) pendingTwilioMessages.push(raw);
  });

  function scheduleTurnFlush() {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      turnTimer = null;
      void processBufferedTurn();
    }, TURN_SILENCE_MS);
  }

  async function processBufferedTurn() {
    if (turnProcessing) {
      turnQueued = true;
      return;
    }

    const packets = bufferedSpeechPackets.splice(0);
    if (!packets.length) {
      turnQueued = false;
      return;
    }

    turnProcessing = true;
    turnQueued = false;

    try {
      const transcript = await transcribeAudioWithGroq(twilioMulawToWavBase64(packets), conversationLanguage);
      if (transcript) {
        userTranscript = `${userTranscript} ${transcript}`.trim();
        conversationLanguage = detectLanguageMode(transcript) || conversationLanguage;
        conversationTurns.push({ role: "user", content: transcript });
        logEvent({
          type: "conversation.line",
          session_id: resolvedSession.id,
          role: "user",
          content: transcript,
          language: conversationLanguage,
          source: "anthropic",
        });

        const reply = await generateFallbackReply(conversationTurns, conversationLanguage, systemPrompt);
        conversationTurns.push({ role: "assistant", content: reply });
        conversationLanguage = detectLanguageMode(reply) || conversationLanguage;
        logEvent({
          type: "conversation.line",
          session_id: resolvedSession.id,
          role: "assistant",
          content: reply,
          language: conversationLanguage,
          source: "anthropic",
        });

        const elevenLabsAudio = await synthesizeWithElevenLabs(reply, conversationLanguage).catch((error) => {
          logEvent({ type: "elevenlabs.error", error: error.message });
          return null;
        });
        if (elevenLabsAudio && streamSid && twilioWs.readyState === WebSocket.OPEN) {
          state.twilioAudioPackets += 1;
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: elevenLabsAudio } }));
          logEvent({ type: "audio.sent", source: "elevenlabs", stream_sid: streamSid });
        }
      }
    } finally {
      turnProcessing = false;
      if (turnQueued || bufferedSpeechPackets.length) {
        turnQueued = false;
        scheduleTurnFlush();
      }
    }
  }

  async function drainTurns() {
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = null;
    }

    await processBufferedTurn();
    while (turnProcessing || bufferedSpeechPackets.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  twilioWs.on("message", (raw) => {
    void (async () => {
      try {
        const message = JSON.parse(raw.toString());

        if (message.event === "start") {
          streamSid = message.start.streamSid || "";
          callSid = message.start.callSid || "";
          const custom = message.start.customParameters || {};
          if (!resolvedSession.id && custom.session_id) resolvedSession.id = custom.session_id;
          if (!resolvedSession.owner_id && custom.owner_id) resolvedSession.owner_id = custom.owner_id;
          if (!resolvedSession.caller_id && custom.caller_id) resolvedSession.caller_id = custom.caller_id;
          state.lastSessionId = resolvedSession.id;
          logEvent({ type: "twilio.start", session_id: resolvedSession.id || sessionId, stream_sid: streamSid, call_sid: callSid, custom_parameters: custom });

          const client = getSupabase();
          if (!client) {
            state.lastError = "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
            logEvent({ type: "config.error", session_id: resolvedSession.id, message: state.lastError });
            twilioWs.close(1011, state.lastError);
            return;
          }

          await client
            .from("call_sessions")
            .update({
              provider_call_id: callSid || undefined,
              metadata: { call_sid: callSid, stream_sid: streamSid, source: "twilio_media_stream" },
            })
            .eq("id", resolvedSession.id);

          const settings = await loadAgentSettings();
          systemPrompt = settings.system_prompt || "You are a warm, human-sounding phone assistant. Ask for the caller's name first.";

          if (!greeted) {
            greeted = true;
            const greeting = "Hi, I'm your calling assistant. What name should I use for you?";
            logEvent({ type: "assistant.greeting", session_id: resolvedSession.id, content: greeting, source: "elevenlabs" });
            await sendAudioToTwilio(twilioWs, streamSid, greeting, conversationLanguage);
          }
        }

        if (message.event === "media") {
          if (!state.lastEvent || state.lastEvent.type !== "twilio.media") {
            logEvent({ type: "twilio.media", session_id: resolvedSession.id });
          }

          const energy = computePacketEnergy(message.media.payload);
          if (energy > 160) {
            bufferedSpeechPackets.push(message.media.payload);
            scheduleTurnFlush();
          }
        }

        if (message.event === "stop") {
          logEvent({ type: "twilio.stop", session_id: resolvedSession.id });
          await drainTurns();
          const fullTranscript = conversationTurns.map((turn) => `${turn.role}: ${turn.content}`).join("\n").trim();
          const extracted = await extractImportantMemory(fullTranscript);

          await pushTranscriptChunk({
            sessionId: resolvedSession.id,
            ownerId: resolvedSession.owner_id,
            callerId: resolvedSession.caller_id,
            transcript: fullTranscript || userTranscript,
            fullName,
            phoneE164,
            role: "assistant",
            summary: extracted?.summary || fullTranscript.slice(0, 500),
            memoryChunk: extracted?.memoryChunk || null,
            metadata: { language: conversationLanguage },
            turns: [],
          }).catch((error) => console.error(error));
        }
      } catch (error) {
        console.error("twilio message error", error);
      }
    })();
  });

  twilioWs.on("error", (error) => {
    state.lastError = error.message;
    logEvent({ type: "twilio.error", session_id: resolvedSession.id, error: error.message });
  });

  twilioReady = true;
  for (const pendingMessage of pendingTwilioMessages.splice(0)) {
    twilioWs.emit("message", pendingMessage);
  }

  twilioWs.on("close", () => {
    state.activeConnections = Math.max(0, state.activeConnections - 1);
    logEvent({ type: "ws.close", session_id: resolvedSession.id });
  });

  if (twilioWs.readyState === WebSocket.OPEN) {
    twilioWs.ping();
  }
});

server.listen(PORT, () => {
  console.log(`Bridge listening on :${PORT}`);
});
