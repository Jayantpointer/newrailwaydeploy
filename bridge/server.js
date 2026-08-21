const http = require("node:http");
const { URL } = require("node:url");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
const OPENAI_MEMORY_MODEL = process.env.OPENAI_MEMORY_MODEL || "gpt-4.1-mini";
const OPENAI_FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || "gpt-4.1-mini";
const CALL_MEMORY_SYNC_URL = process.env.CALL_MEMORY_SYNC_URL || "";
const SARVAM_TTS_URL = process.env.SARVAM_TTS_URL || "";
const SARVAM_API_KEY = process.env.SARVAM_API_KEY || "";
const SARVAM_VOICE_ID = process.env.SARVAM_VOICE_ID || "";
const SARVAM_LANGUAGE = process.env.SARVAM_LANGUAGE || "auto";

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
  openaiAudioChunks: 0,
  twilioAudioPackets: 0,
  sarvamRequests: 0,
  sarvamErrors: 0,
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

function normalizeSarvamLanguage(preferred, text = "") {
  const envLanguage = (SARVAM_LANGUAGE || "auto").toLowerCase();
  if (envLanguage !== "auto") return envLanguage;

  const detected = detectLanguageMode(text);
  return preferred || detected || "en";
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
  if (!text || !OPENAI_API_KEY) return null;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MEMORY_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Extract only durable, non-sensitive call memory. Return JSON with summary and memory_chunk. The memory_chunk should be null if nothing important was said. Use chunk_type one of caller_profile, follow_up, preference, task, call_memory. Exclude secrets, health details, payment details, or private identifiers unless they are explicitly needed for follow-up. Keep content short and factual.",
          },
          {
            role: "user",
            content: `Transcript:\n${text}`,
          },
        ],
      }),
    });

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const memoryChunk = parsed.memory_chunk || null;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      memoryChunk: memoryChunk && memoryChunk.content ? { ...memoryChunk, symptoms: Array.isArray(memoryChunk.symptoms) ? memoryChunk.symptoms : [] } : null,
    };
  } catch {
    const fallback = buildFallbackMemoryChunk(text);
    return {
      summary: text.slice(0, 500),
      memoryChunk: fallback && fallback.importance >= 75 ? fallback : null,
    };
  }
}

async function generateFallbackReply(turns, language) {
  const text = turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n").trim();
  if (!OPENAI_API_KEY || !text) return "Sorry, I didn’t catch that. What name should I use for you?";

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_FALLBACK_MODEL,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: `You are a warm calling assistant. Speak in ${language === "hi" ? "Hindi" : language === "hinglish" ? "Hinglish" : "English"}. Keep it short and ask one simple question at a time. If this is the first reply after the greeting, ask for the caller's name. Avoid sensitive details.`,
          },
          ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
        ],
      }),
    });

    if (!response.ok) return "Sorry, I didn’t catch that. What name should I use for you?";
    const payload = await response.json();
    return payload?.choices?.[0]?.message?.content?.trim() || "Sorry, I didn’t catch that. What name should I use for you?";
  } catch {
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
  if (!SARVAM_TTS_URL || !SARVAM_API_KEY || !text.trim()) return null;
  const language = normalizeSarvamLanguage(languageHint, text);
  state.sarvamRequests += 1;

  let response;
  try {
    response = await fetch(SARVAM_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SARVAM_API_KEY}`,
    },
    body: JSON.stringify({
      text,
      voice_id: SARVAM_VOICE_ID,
      language,
      format: "mulaw_8000",
    }),
    });
  } catch (error) {
    state.sarvamErrors += 1;
    logEvent({ type: "sarvam.error", error: error.message });
    return null;
  }

  if (!response.ok) {
    state.sarvamErrors += 1;
    logEvent({ type: "sarvam.error", status: response.status, statusText: response.statusText });
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    return data.audio_base64 || data.audio || null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
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

function sendBufferedOpenAIAudio(twilioWs, streamSid, chunks) {
  if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;

  for (const payload of chunks) {
    state.twilioAudioPackets += 1;
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload },
    }));
  }

  if (chunks.length) {
    logEvent({ type: "audio.sent", source: "openai_realtime_buffer", stream_sid: streamSid, chunks: chunks.length });
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
    .select("agent_name,system_prompt,openai_realtime_model,sarvam_voice_id,sarvam_language")
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

async function createOpenAIConnection(context, outbound) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(context.model || OPENAI_REALTIME_MODEL)}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: context.model || OPENAI_REALTIME_MODEL,
        instructions: context.systemPrompt,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: { type: "server_vad", create_response: false, interrupt_response: true },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "alloy",
          },
        },
      },
    }));

    outbound.onOpen?.();
  });

  return ws;
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
      recentEvents: state.recentEvents,
      openaiAudioChunks: state.openaiAudioChunks,
      twilioAudioPackets: state.twilioAudioPackets,
      sarvamRequests: state.sarvamRequests,
      sarvamErrors: state.sarvamErrors,
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

  let context = { systemPrompt: "", model: OPENAI_REALTIME_MODEL };
  let openaiWs = null;
  let streamSid = "";
  let callSid = "";
  let resolvedSession = { id: sessionId, owner_id: ownerId || null, caller_id: callerId || null };
  let userTranscript = "";
  let assistantTranscript = "";
  const conversationTurns = [];
  let greeted = false;
  let conversationLanguage = "en";
  let assistantFallbackTimer = null;
  let assistantReplied = false;
  let realtimeAudioChunks = [];
  let twilioReady = false;
  const pendingTwilioMessages = [];

  logEvent({ type: "ws.connection", session_id: sessionId, path: url.pathname });

  twilioWs.on("message", (raw) => {
    if (!twilioReady) pendingTwilioMessages.push(raw);
  });

  twilioWs.on("error", (error) => {
    state.lastError = error.message;
    logEvent({ type: "twilio.error", session_id: resolvedSession.id, error: error.message });
  });

  try {
    const settings = await loadAgentSettings();
    context = {
      systemPrompt: settings.system_prompt || "You are a warm, human-sounding phone assistant. Ask for the caller's name first.",
      model: settings.openai_realtime_model || OPENAI_REALTIME_MODEL,
    };

    resolvedSession = await ensureSession({
      sessionId,
      ownerId: ownerId || null,
      callerId: callerId || null,
      phoneE164,
      fullName,
      callSid,
    });

    openaiWs = await createOpenAIConnection(context, {
      onOpen: () => {
        logEvent({ type: "openai.connected", session_id: resolvedSession.id });
      },
    });

    openaiWs.on("error", (error) => {
      state.lastError = error.message;
      logEvent({ type: "openai.error", session_id: resolvedSession.id, error: error.message });
    });

    openaiWs.on("close", (code, reason) => {
      logEvent({ type: "openai.closed", session_id: resolvedSession.id, code, reason: reason.toString() });
    });
  } catch (error) {
    twilioWs.close(1011, error.message);
    return;
  }

  openaiWs.on("message", async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      const eventType = event.type || "";

      if (eventType !== "response.output_text.delta") {
        logEvent({ type: "openai.event", session_id: resolvedSession.id, event_type: eventType });
      }

      if (eventType === "error") {
        state.lastError = event.error?.message || "OpenAI realtime error";
        logEvent({ type: "openai.error", session_id: resolvedSession.id, error: event.error || event });
      }

      if (eventType === "response.audio.delta" || eventType === "response.output_audio.delta") {
        state.openaiAudioChunks += 1;
        realtimeAudioChunks.push(event.delta);
        assistantReplied = true;
        if (assistantFallbackTimer) {
          clearTimeout(assistantFallbackTimer);
          assistantFallbackTimer = null;
        }

        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          state.twilioAudioPackets += 1;
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: event.delta },
          }));
          logEvent({ type: "audio.sent", source: "openai_realtime", stream_sid: streamSid });
        }

      }

      if (eventType === "conversation.item.input_audio_transcription.completed") {
        const text = event.transcript || event.text || "";
        userTranscript = `${userTranscript} ${text}`.trim();
        conversationLanguage = detectLanguageMode(text) || conversationLanguage;
        conversationTurns.push({ role: "user", content: text });
        logEvent({
          type: "conversation.line",
          session_id: resolvedSession.id,
          role: "user",
          content: text,
          language: conversationLanguage,
        });

        assistantReplied = false;
        realtimeAudioChunks = [];
        if (assistantFallbackTimer) {
          clearTimeout(assistantFallbackTimer);
        }

        assistantFallbackTimer = setTimeout(async () => {
          if (assistantReplied) return;
          const reply = await generateFallbackReply(conversationTurns, conversationLanguage);
          conversationTurns.push({ role: "assistant", content: reply });
          logEvent({
            type: "conversation.line",
            session_id: resolvedSession.id,
            role: "assistant",
            content: reply,
            language: conversationLanguage,
            source: "fallback",
          });
          const sarvamAudio = await synthesizeWithSarvam(reply, conversationLanguage).catch((error) => {
            logEvent({ type: "sarvam.error", error: error.message });
            return null;
          });
          if (sarvamAudio) {
            assistantReplied = true;
            state.twilioAudioPackets += 1;
            twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: sarvamAudio } }));
          } else {
            assistantReplied = true;
            sendBufferedOpenAIAudio(twilioWs, streamSid, realtimeAudioChunks);
          }
        }, 3500);

        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          logEvent({ type: "openai.response.requested", session_id: resolvedSession.id });
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
      }

      if (
        eventType === "response.output_text.delta" ||
        eventType === "response.text.delta" ||
        eventType === "response.output_audio_transcript.delta"
      ) {
        assistantTranscript += event.delta || event.text || "";
      }

      if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.output_text.done") {
        const finalText = assistantTranscript.trim();
        assistantTranscript = "";
        if (assistantFallbackTimer) {
          clearTimeout(assistantFallbackTimer);
          assistantFallbackTimer = null;
        }

        if (!assistantReplied && finalText) {
          assistantReplied = true;
          conversationTurns.push({ role: "assistant", content: finalText });
          conversationLanguage = detectLanguageMode(finalText) || conversationLanguage;
          logEvent({
            type: "conversation.line",
            session_id: resolvedSession.id,
            role: "assistant",
            content: finalText,
            language: conversationLanguage,
          });

          const sarvamAudio = await synthesizeWithSarvam(finalText, conversationLanguage).catch((error) => {
            logEvent({ type: "sarvam.error", error: error.message });
            return null;
          });
          if (sarvamAudio) {
            state.twilioAudioPackets += 1;
            twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: sarvamAudio } }));
            logEvent({ type: "audio.sent", source: "sarvam", stream_sid: streamSid });
          } else {
            sendBufferedOpenAIAudio(twilioWs, streamSid, realtimeAudioChunks);
          }
        }
        realtimeAudioChunks = [];
      }
    } catch (error) {
      console.error("openai message error", error);
    }
  });

  twilioWs.on("message", async (raw) => {
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

        if (!greeted) {
          greeted = true;
          logEvent({ type: "assistant.greeting", session_id: resolvedSession.id, content: "Hi, I’m your calling assistant. What name should I use for you?" });
        }
      }

      if (message.event === "media" && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        if (!state.lastEvent || state.lastEvent.type !== "twilio.media") {
          logEvent({ type: "twilio.media", session_id: resolvedSession.id });
        }
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: message.media.payload,
        }));
      }

      if (message.event === "stop") {
        logEvent({ type: "twilio.stop", session_id: resolvedSession.id });
        const fullTranscript = conversationTurns.map((turn) => `${turn.role}: ${turn.content}`).join("\n").trim();
        const extracted = await extractImportantMemory(fullTranscript);

        await pushTranscriptChunk({
          sessionId: resolvedSession.id,
          ownerId: resolvedSession.owner_id,
          callerId: resolvedSession.caller_id,
          transcript: fullTranscript || `${userTranscript}\n${assistantTranscript}`.trim(),
          fullName,
          phoneE164,
          role: "assistant",
          summary: extracted?.summary || fullTranscript.slice(0, 500),
          memoryChunk: extracted?.memoryChunk || null,
          metadata: { language: conversationLanguage },
          turns: [],
        }).catch((error) => console.error(error));

        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
      }
    } catch (error) {
      console.error("twilio message error", error);
    }
  });

  twilioReady = true;
  for (const pendingMessage of pendingTwilioMessages.splice(0)) {
    twilioWs.emit("message", pendingMessage);
  }

  twilioWs.on("close", () => {
    state.activeConnections = Math.max(0, state.activeConnections - 1);
    logEvent({ type: "ws.close", session_id: resolvedSession.id });
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  if (twilioWs.readyState === WebSocket.OPEN) {
    twilioWs.ping();
  }
});

server.listen(PORT, () => {
  console.log(`Bridge listening on :${PORT}`);
});
