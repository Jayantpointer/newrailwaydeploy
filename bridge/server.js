const http = require("node:http");
const { URL } = require("node:url");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CALL_MEMORY_SYNC_URL = process.env.CALL_MEMORY_SYNC_URL || "";
const OPENROUTER_API_KEY = envText("OPENROUTER_API_KEY");
const OPENROUTER_MODEL = envText("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct");
const OPENROUTER_BASE_URL = envText("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
const GEMINI_API_KEY = envText("GEMINI_API_KEY");
const GEMINI_MODEL = envText("GEMINI_MODEL", "gemini-2.5-flash");
const SARVAM_API_KEY = envText("SARVAM_API_KEY");
const SARVAM_VOICE_ID = envText("SARVAM_VOICE_ID", "shubh");
const SARVAM_TTS_URL = envText("SARVAM_TTS_URL", "https://api.sarvam.ai/text-to-speech");
const SARVAM_LANGUAGE = envText("SARVAM_LANGUAGE", "auto");
function envText(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

const TURN_SILENCE_MS = 1000;

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
  sarvamRequests: 0,
  sarvamErrors: 0,
  openrouterRequests: 0,
  openrouterErrors: 0,
  geminiSttRequests: 0,
  geminiSttErrors: 0,
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
  voice_provider: "sarvam",
  sarvam_api_key_configured: Boolean(SARVAM_API_KEY),
  sarvam_voice_id_configured: Boolean(SARVAM_VOICE_ID),
  sarvam_tts_url: SARVAM_TTS_URL,
  openrouter_api_key_configured: Boolean(OPENROUTER_API_KEY),
  openrouter_model: OPENROUTER_MODEL,
  gemini_stt_api_key_configured: Boolean(GEMINI_API_KEY),
  gemini_stt_model: GEMINI_MODEL,
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

function sarvamLanguageCode(language) {
  if (language === "hi" || language === "hinglish") return "hi-IN";
  return "en-IN";
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

  if (!OPENROUTER_API_KEY) return null;

  try {
    state.openrouterRequests += 1;
    const response = await fetch(`${OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 400,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Extract only durable, non-sensitive call memory. Return strict JSON with keys summary and memory_chunk. The memory_chunk should be null if nothing important was said. Use chunk_type one of caller_profile, follow_up, preference, task, call_memory. Exclude secrets, health details, payment details, or private identifiers unless they are explicitly needed for follow-up. Keep content short and factual.",
          },
          {
            role: "user",
            content: `Transcript:\n${text}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      state.openrouterErrors += 1;
      logEvent({ type: "openrouter.error", status: response.status, statusText: response.statusText, details });
      return null;
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content);
    const memoryChunk = parsed.memory_chunk || null;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      memoryChunk: memoryChunk && memoryChunk.content ? { ...memoryChunk, symptoms: Array.isArray(memoryChunk.symptoms) ? memoryChunk.symptoms : [] } : null,
    };
  } catch {
    state.openrouterErrors += 1;
    const fallback = buildFallbackMemoryChunk(text);
    return {
      summary: text.slice(0, 500),
      memoryChunk: fallback && fallback.importance >= 75 ? fallback : null,
    };
  }
}

async function transcribeAudioWithGemini(audioWavBase64, language) {
  if (!GEMINI_API_KEY || !audioWavBase64) return "";

  try {
    state.geminiSttRequests += 1;
    const audioBuffer = Buffer.from(audioWavBase64, "base64");
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `Transcribe the caller audio exactly. Return only the transcript text in ${language === "hi" ? "Hindi" : language === "hinglish" ? "Hinglish" : "English"}. Do not add commentary.` }],
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: "Audio to transcribe:" },
              { inline_data: { mime_type: "audio/wav", data: audioBuffer.toString("base64") } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      state.geminiSttErrors += 1;
      return "";
    }

    const payload = await response.json();
    return (payload?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
  } catch (error) {
    state.geminiSttErrors += 1;
    logEvent({ type: "gemini.error", error: error.message, stage: "transcribe" });
    return "";
  }
}

async function generateFallbackReply(turns, language, systemPrompt = "") {
  const text = turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n").trim();
  if (!OPENROUTER_API_KEY || !text) return "Sorry, I didn’t catch that. What name should I use for you?";

  try {
    state.openrouterRequests += 1;
    const response = await fetch(`${OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 300,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `${systemPrompt ? `${systemPrompt}\n` : ""}You are a warm calling assistant. Speak in ${language === "hi" ? "Hindi" : language === "hinglish" ? "Hinglish" : "English"}. Keep it short and ask one simple question at a time. If this is the first reply after the greeting, ask for the caller's name. Avoid sensitive details.`,
          },
          { role: "user", content: `Conversation:\n${text}` },
        ],
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      state.openrouterErrors += 1;
      logEvent({ type: "openrouter.error", status: response.status, statusText: response.statusText, details });
      return "Sorry, I didn’t catch that. What name should I use for you?";
    }

    const payload = await response.json();
    return payload?.choices?.[0]?.message?.content?.trim() || "Sorry, I didn’t catch that. What name should I use for you?";
  } catch {
    state.openrouterErrors += 1;
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

async function synthesizeWithSarvam(text, languageHint = "") {
  if (!SARVAM_API_KEY || !text.trim()) return null;

  state.sarvamRequests += 1;
  try {
    const language = SARVAM_LANGUAGE === "auto" ? languageHint : SARVAM_LANGUAGE;
    const response = await fetch(SARVAM_TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": SARVAM_API_KEY,
      },
      body: JSON.stringify({
        text,
        model: "bulbul:v3",
        speaker: SARVAM_VOICE_ID,
        language_code: sarvamLanguageCode(language),
        output_audio_codec: "mulaw",
        speech_sample_rate: 8000,
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      state.sarvamErrors += 1;
      logEvent({ type: "sarvam.error", status: response.status, statusText: response.statusText, details });
      return null;
    }

    const payload = await response.json();
    return Array.isArray(payload?.audios) ? payload.audios[0] || null : payload?.audio_base64 || payload?.audio || null;
  } catch (error) {
    state.sarvamErrors += 1;
    logEvent({ type: "sarvam.error", error: error.message });
    return null;
  }
}

async function sendAudioToTwilio(twilioWs, streamSid, text, languageHint = "") {
  const audioBase64 = await synthesizeWithSarvam(text, languageHint);
  if (audioBase64 && streamSid && twilioWs.readyState === WebSocket.OPEN) {
    state.twilioAudioPackets += 1;
    logEvent({ type: "audio.sent", source: "sarvam", stream_sid: streamSid });
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

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/healthz" || url.pathname === "/media-stream")) {
    return json(res, 200, {
      ok: true,
      activeConnections: state.activeConnections,
      lastSessionId: state.lastSessionId,
      lastEvent: state.lastEvent,
      lastError: state.lastError,
      voiceProvider: "sarvam",
      sarvamVoiceId: SARVAM_VOICE_ID || null,
      sarvamConfigured: Boolean(SARVAM_API_KEY),
      recentEvents: state.recentEvents,
      twilioAudioPackets: state.twilioAudioPackets,
      sarvamRequests: state.sarvamRequests,
      sarvamErrors: state.sarvamErrors,
      openrouterRequests: state.openrouterRequests,
      openrouterErrors: state.openrouterErrors,
      geminiSttRequests: state.geminiSttRequests,
      geminiSttErrors: state.geminiSttErrors,
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

server.on("error", (error) => {
  state.lastError = error.message;
  console.error("server error", error);
});

process.on("SIGTERM", () => {
  console.log("Bridge received SIGTERM");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("Bridge received SIGINT");
  server.close(() => process.exit(0));
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
      const transcript = await transcribeAudioWithGemini(twilioMulawToWavBase64(packets), conversationLanguage);
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
          source: "openrouter",
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
          source: "openrouter",
        });

        const sarvamAudio = await synthesizeWithSarvam(reply, conversationLanguage).catch((error) => {
          logEvent({ type: "sarvam.error", error: error.message });
          return null;
        });
        if (sarvamAudio && streamSid && twilioWs.readyState === WebSocket.OPEN) {
          state.twilioAudioPackets += 1;
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: sarvamAudio } }));
          logEvent({ type: "audio.sent", source: "sarvam", stream_sid: streamSid });
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
            logEvent({ type: "assistant.greeting", session_id: resolvedSession.id, content: greeting, source: "sarvam" });
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
