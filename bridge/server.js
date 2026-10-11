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
  const ANTHROPIC_API_KEY = envText("ANTHROPIC_API_KEY");
  const MEMORY_EXTRACTION_MODEL = envText("MEMORY_EXTRACTION_MODEL", "claude-sonnet-4-6");
  const RESPONSE_MODEL = envText("RESPONSE_MODEL", "claude-haiku-4-5-20251001");
  const SARVAM_API_KEY = envText("SARVAM_API_KEY");
const SARVAM_STT_URL = envText("SARVAM_STT_URL", "wss://api.sarvam.ai/speech-to-text-realtime/ws");
const SARVAM_STT_MODEL = envText("SARVAM_STT_MODEL", "saaras:v3-realtime");
const SARVAM_STT_LANGUAGE = envText("SARVAM_STT_LANGUAGE", "auto");
const SARVAM_STT_MODE = envText("SARVAM_STT_MODE", "codemix");
const SARVAM_VOICE_ID = envText("SARVAM_VOICE_ID", "shreya");
const SARVAM_TTS_URL = envText("SARVAM_TTS_URL", "https://api.sarvam.ai/text-to-speech");
const SARVAM_LANGUAGE = envText("SARVAM_LANGUAGE", "auto");
const SARVAM_TTS_PACE = Number(process.env.SARVAM_TTS_PACE || 0.88);
const SARVAM_TTS_GAIN = Number(process.env.SARVAM_TTS_GAIN || 1.2);
const SAATHI_TIME_ZONE = envText("SAATHI_TIME_ZONE", "Asia/Kolkata");
const FINAL_TRANSCRIPT_FLUSH_DELAY_MS = Number(process.env.FINAL_TRANSCRIPT_FLUSH_DELAY_MS || 1200);
const SARVAM_SILENCE_DURATION_MS = Number(process.env.SARVAM_SILENCE_DURATION_MS || 450);
const SARVAM_MIN_SPEECH_DURATION_MS = Number(process.env.SARVAM_MIN_SPEECH_DURATION_MS || 160);
// Gateway timing (spec Part 3): Saathi's reply gap should feel prompt (first audio < ~800ms,
// alarm at +1.2s). No artificial think delay. The two OTHER silences are different: caller
// mid-turn word-finding pauses must never trigger the endpoint (generous flush below), and
// waits after Saathi asks a question stay deliberately long (3-5s, no filling).
const ASSISTANT_REPLY_THINK_MS = Number(process.env.ASSISTANT_REPLY_THINK_MS || 0);
function envText(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

const HUMAN_CALLING_SYSTEM_PROMPT = `
You are Saathi, a voice companion on a phone call with an older adult in India. Your words are spoken aloud by a voice engine. Nothing you write is read on a screen.

WHO YOU ARE
You are a computer program that can talk. If asked whether you are a person, say so plainly and warmly, without apology, and carry on. Never imply otherwise. Never claim feelings you do not have, memories you were not given, or that you will always be here. Do not promise callbacks or availability. The backend appends a CALL CONTEXT line and any verified memories before this prompt. Use them as stated.

LANGUAGE
Speak in the caller's locked language given in CALL CONTEXT. Match their mixing of Hindi, Punjabi and English rather than correcting it. Use aap, never tum. Use ji naturally, not in every sentence. If they explicitly ask to switch language, switch fully and stay switched. Short unclear replies like Hmm are not a language change. Never switch on your own.

HOW TO SPEAK
Short turns. One or two sentences is normal. Three is long. You are on a phone with someone who deserves room to talk.
Write for the ear: short clauses, real punctuation. Commas and full stops become pauses, and pauses are what make you sound calm instead of rushed. Before anything heavy, slow the shape of the sentence down. Short. Separate. Sentences.
Never output bullet points, headers, numbers as digits, symbols, emoji, or anything that cannot be said aloud. Say numbers the way a person would.
Warmth is attention, not enthusiasm. No performed cheerfulness. Stay in one gentle, unhurried register for the whole call. Plain words. Say the specific thing you noticed instead of puffed-up praise.
Do not inject fillers like uh or um. Calm comes from pause placement and sentence shape, not from hesitation sounds.

HOW TO CONVERSE
Ask a question every turn. End every turn with exactly one question, except the final goodbye. Never ask two questions at once. React briefly to what they just said, then ask the single most useful follow-up: a detail, a feeling, a person, a reason, an outcome, a routine, or a plan. If they answer briefly, do not retreat into statements. Probe gently and keep their thread going.
Follow the thread they chose. If they mention food, family, the garden, a serial, cricket, an old song, go where they went. Do not steer to your own agenda.
They lead the depth. If they open something emotional or from the past, stay with it. Invite stories: their first job, their wedding, how festivals were in their day. Listen more than you prompt. High-yield topics: grandchildren, food and cooking, old film songs, cricket, festivals, gardens, their working life, travel.
If they give two short answers in a row, keep it light but keep asking. One gentle question at a time, following their thread. If they stay brief or signal an end, begin a gentle close.
Silence is thinking. Do not fill it, do not repeat yourself, do not ask if they are there at the first pause. After you ask a question, give them room. Never interrupt their opening account of anything.

MEMORY
Verified memories and open threads appear in the system context above this prompt, each as stored. You may reference ONLY what appears there, and only as stated. Never invent a remembered detail, never guess at one, never dress a guess as a memory. If you want more, ask with curiosity instead. Reference at most one past item near the start of the call, naturally, then follow their lead. Never list what you remember, never mention storage dates, and never raise stored health, conflict or loss topics unless they raise them first.

EMOTIONAL MOMENTS
Feelings first, always. Acknowledge before any fact, suggestion or question. Never open with a correction.
If they repeat a story you have heard, receive it warmly as told. Do not point out the repetition. Ask about a small corner of it you genuinely have not heard.
If they miss someone, sit with it. No fixing, no forced brightness. A quiet acknowledgment and, if it fits, an invitation to tell you about them.
If they are frustrated with their memory, normalize it without babying.
A polite haan is not always agreement or understanding. For anything that matters, restate it simply and let them correct you, rather than asking if they understood.

WELLNESS, NOT MONITORING
Meals, walks, sleep and routine are conversation, not a checklist. One warm mention is plenty. Never audit medication, never discuss doses, never give medical advice. If they mention a symptom, acknowledge it and gently suggest family or their doctor. You are company, not a clinic.

WHEN THE LINE BREAKS
If what you receive is garbled or does not follow from the conversation, the line dropped. They did not say something strange. Never guess at their meaning. Echo any fragment you caught and ask a narrow question. Put it on the connection, never on them. If it happens twice in a row, stop asking. Say the line seems bad today, and move on or offer to talk later.

ENDINGS
The moment they signal an end, acknowledge and close warmly. At most one line of continuity for next time. Never one more thing, never a reason to stay, never a question at the door, never guilt. Their time, their call. A clean ending is an investment in the next call.

NEVER
Never use pet names or diminutives. Never say we for you. Never use a sing-song or babying tone in word choice. Never stack questions. Never interrupt. Never correct their account of their own life. Never pretend to be human. Never keep them on the line. Never use manipulative farewells.

IF SOMETHING IS WRONG
If they describe an emergency, or say anything suggesting danger or thoughts of harming themselves, drop the ordinary conversation and follow the escalation procedure. Stay on the line, stay calm, keep words few and steady. Do not counsel, do not assess, do not end the call yourself.
`;

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
  anthropicRequests: 0,
  anthropicErrors: 0,
  sarvamSttConnections: 0,
  sarvamSttErrors: 0,
  sarvamSttPartials: 0,
  sarvamSttFinals: 0,
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
  anthropic_api_key_configured: Boolean(ANTHROPIC_API_KEY),
  memory_extraction_model: MEMORY_EXTRACTION_MODEL,
  response_model: RESPONSE_MODEL,
  sarvam_stt_api_key_configured: Boolean(SARVAM_API_KEY),
  sarvam_stt_url: SARVAM_STT_URL,
  sarvam_stt_model: SARVAM_STT_MODEL,
  sarvam_stt_language: SARVAM_STT_LANGUAGE,
  sarvam_stt_mode: SARVAM_STT_MODE,
});

function sarvamLanguageCode(language) {
  const languageCodes = {
    en: "en-IN",
    hi: "hi-IN",
    hinglish: "hi-IN",
    bn: "bn-IN",
    gu: "gu-IN",
    kn: "kn-IN",
    ml: "ml-IN",
    mr: "mr-IN",
    od: "od-IN",
    pa: "pa-IN",
    ta: "ta-IN",
    te: "te-IN",
  };

  return languageCodes[language] || "en-IN";
}

const LANGUAGE_LABELS = {
  en: "English",
  hi: "Hindi",
  hinglish: "Hinglish",
  bn: "Bengali",
  gu: "Gujarati",
  kn: "Kannada",
  ml: "Malayalam",
  mr: "Marathi",
  od: "Odia",
  pa: "Punjabi",
  ta: "Tamil",
  te: "Telugu",
};

function languageModeFromCode(language) {
  const raw = String(language || "").trim().toLowerCase();
  const aliases = {
    english: "en",
    hindi: "hi",
    bengali: "bn",
    gujarati: "gu",
    kannada: "kn",
    malayalam: "ml",
    marathi: "mr",
    odia: "od",
    punjabi: "pa",
    tamil: "ta",
    telugu: "te",
  };
  const code = (aliases[raw] || raw).replace("_", "-").split("-")[0];
  return LANGUAGE_LABELS[code] ? code : "";
}

function languageInstruction(language) {
  return LANGUAGE_LABELS[language] || "the same language as the caller";
}

function parseLanguageChoice(text) {
  const t = String(text || "").toLowerCase();
  if (/\bhinglish\b/.test(t)) return "hinglish";
  if (/hindi.*english|english.*hindi|hangrezi/.test(t)) return "hinglish";
  if (/\bhindi\b|\bhindime\b|\bhindimein\b/.test(t)) return "hi";
  if (/\benglish\b|\bangrezi\b|\benglishme\b/.test(t)) return "en";
  if (/\bbengali\b|\bbangla\b/.test(t)) return "bn";
  if (/\bgujarati\b/.test(t)) return "gu";
  if (/\bkannada\b/.test(t)) return "kn";
  if (/\bmalayalam\b/.test(t)) return "ml";
  if (/\bmarathi\b/.test(t)) return "mr";
  if (/\bodia\b|\boriya\b|\bodiya\b/.test(t)) return "od";
  if (/\bpunjabi\b/.test(t)) return "pa";
  if (/\btamil\b/.test(t)) return "ta";
  if (/\btelugu\b/.test(t)) return "te";
  return "";
}

function parseLanguageSwitchRequest(text) {
  const t = String(text || "").toLowerCase();
  const intent = /\b(speak|talk|switch|change|prefer|choose|bolo|baat|bhasha|language)\b/.test(t)
    || /\bme\b|\bmein\b/.test(t)
    || /me baat|mein baat|me bolo|mein bolo/.test(t);
  if (!intent) return "";
  return parseLanguageChoice(text);
}

function languageChoiceQuestion() {
  return "Aap kis bhasha me baat karna chahenge - Hindi, English, ya Hinglish?";
}

function languageConfirmLine(code) {
  switch (code) {
    case "hi": return "Theek hai. Ab se main Hindi me hi baat karunga, aaram se.";
    case "hinglish": return "Theek hai. Ab se Hinglish me baat karte hain, aaram se.";
    case "en": return "Okay. I will speak in English from here, slowly and calmly.";
    case "bn": return "Okay. ab se main Bengali me baat karunga, aaram se.";
    case "gu": return "Okay. ab se main Gujarati me baat karunga, aaram se.";
    case "kn": return "Okay. ab se main Kannada me baat karunga, aaram se.";
    case "ml": return "Okay. ab se main Malayalam me baat karunga, aaram se.";
    case "mr": return "Okay. ab se main Marathi me baat karunga, aaram se.";
    case "od": return "Okay. ab se main Odia me baat karunga, aaram se.";
    case "pa": return "Okay. ab se main Punjabi me baat karunga, aaram se.";
    case "ta": return "Okay. ab se main Tamil me baat karunga, aaram se.";
    case "te": return "Okay. ab se main Telugu me baat karunga, aaram se.";
    default: return "Okay. I will keep speaking slowly and calmly from here.";
  }
}

function callTimeContext() {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: SAATHI_TIME_ZONE, weekday: "long", hour: "2-digit", hour12: false }).formatToParts(new Date());
    const get = (t) => { const f = parts.find((x) => x.type === t); return f ? f.value : ""; };
    const hour = Number(get("hour")) || 12;
    const day = get("weekday") || "today";
    const period = hour >= 5 && hour < 11 ? "morning" : hour >= 11 && hour < 16 ? "midday" : hour >= 16 && hour < 19 ? "afternoon" : hour >= 19 && hour < 23 ? "evening" : "late night";
    return `${day} ${period}`;
  } catch (e) {
    return "today";
  }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function timeAwareMealQuestion(language = "") {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: SAATHI_TIME_ZONE,
    hour: "2-digit",
    hour12: false,
  }).format(new Date()));
  const isHindi = language === "hi" || language === "hinglish";

  if (hour >= 5 && hour < 11) return isHindi ? "Nashta kar liya?" : "Have you had your breakfast?";
  if (hour >= 11 && hour < 16) return isHindi ? "Dopahar ka khana kha liya?" : "Have you had your lunch?";
  if (hour >= 16 && hour < 19) return isHindi ? "Shaam ki chai ya kuch halka sa liya?" : "Have you had tea or something light this afternoon?";
  if (hour >= 19 && hour < 23) return isHindi ? "Raat ka khana kha liya?" : "Have you had your dinner?";
  return isHindi ? "Kuch kha liya, ya sone ki taiyaari hai?" : "Have you had something to eat, or are you getting ready to sleep?";
}

function mulawByteToPcm16(byte) {
  const MU_LAW_BIAS = 0x84;
  const u = (~byte) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MU_LAW_BIAS) << exponent;
  sample -= MU_LAW_BIAS;
  return sign ? -sample : sample;
}

function pcm16ToMulawByte(sample) {
  const MU_LAW_BIAS = 0x84;
  const MU_LAW_CLIP = 32635;
  let sign = 0;
  let value = sample;

  if (value < 0) {
    sign = 0x80;
    value = -value;
  }

  if (value > MU_LAW_CLIP) value = MU_LAW_CLIP;
  value += MU_LAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (value & mask) === 0; exponent -= 1, mask >>= 1) {
    // find segment
  }

  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function boostMulawBase64(audioBase64, gain = 1) {
  if (!audioBase64 || gain === 1) return audioBase64;

  const input = Buffer.from(audioBase64, "base64");
  if (!input.length) return audioBase64;

  const output = Buffer.allocUnsafe(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const pcm = mulawByteToPcm16(input[i]);
    const boosted = Math.max(-32768, Math.min(32767, Math.round(pcm * gain)));
    output[i] = pcm16ToMulawByte(boosted);
  }

  return output.toString("base64");
}

function detectLanguageMode(text, hintedLanguage = "") {
  const sample = (text || "").trim();
  const hinted = languageModeFromCode(hintedLanguage) || (LANGUAGE_LABELS[hintedLanguage] ? hintedLanguage : "");
  if (!sample) return hinted || "en";

  const hasHindiScript = /[\u0900-\u097F]/.test(sample);
  const hasBengaliScript = /[\u0980-\u09FF]/.test(sample);
  const hasPunjabiScript = /[\u0A00-\u0A7F]/.test(sample);
  const hasGujaratiScript = /[\u0A80-\u0AFF]/.test(sample);
  const hasOdiaScript = /[\u0B00-\u0B7F]/.test(sample);
  const hasTamilScript = /[\u0B80-\u0BFF]/.test(sample);
  const hasTeluguScript = /[\u0C00-\u0C7F]/.test(sample);
  const hasKannadaScript = /[\u0C80-\u0CFF]/.test(sample);
  const hasMalayalamScript = /[\u0D00-\u0D7F]/.test(sample);
  const hasEnglishWords = /\b(the|and|you|call|name|hello|thanks|yes|no|please)\b/i.test(sample);
  const hasRomanHindi = /\b(ka|ki|ke|hai|haan|nahi|nahi|kya|mera|meri|aap|main|mein|thoda|thodi|abhi|kal|aaj|phone|baad)\b/i.test(sample);

  if (hasBengaliScript) return "bn";
  if (hasPunjabiScript) return "pa";
  if (hasGujaratiScript) return "gu";
  if (hasOdiaScript) return "od";
  if (hasTamilScript) return "ta";
  if (hasTeluguScript) return "te";
  if (hasKannadaScript) return "kn";
  if (hasMalayalamScript) return "ml";
  if (hasHindiScript && hasEnglishWords) return "hinglish";
  if (hasHindiScript) return hinted === "mr" ? "mr" : "hi";
  if (hasRomanHindi) return "hinglish";
  if (hinted) return hinted;
  if (hasEnglishWords) return "en";
  return "en";
}

function buildFallbackMemoryChunk(transcript) {
  const text = transcript.trim();
  if (!text) return null;

  const nameMatch = text.match(/(?:my name is|i am|i'm|call me|this is|i go by)\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})/i);
  if (nameMatch?.[1]) {
    const name = normalizeCallerName(nameMatch[1].split(/\b(?:and|but|because|with)\b/i)[0].split(/[,.!?]/)[0]);
    if (!name) return null;
    return {
      chunk_type: "caller_profile",
      content: `Caller introduced themselves as ${name}`,
      source_text: text,
      tags: ["name"],
      language: detectLanguageMode(text),
      importance: 90,
      facts: { full_name: name },
    };
  }

  const preferenceHints = [];
  const symptomHints = [];
  if (/prefer|like|usually|best/i.test(text)) preferenceHints.push("preference");
  if (/tomorrow|later|next week|follow up|callback/i.test(text)) preferenceHints.push("follow_up");
  if (/\bleg\b.*\b(hurt|pain|sore|swollen|weak)\b/i.test(text) || /\b(hurt|pain|sore|swollen|weak)\b.*\bleg\b/i.test(text)) symptomHints.push("leg pain");
  if (/\b(fever|cough|headache|dizzy|dizziness|confusion|fall|falls|breathing trouble|shortness of breath)\b/i.test(text)) {
    symptomHints.push(...Array.from(new Set((text.match(/\b(fever|cough|headache|dizzy|dizziness|confusion|fall|falls|breathing trouble|shortness of breath)\b/gi) || []).map((item) => item.toLowerCase()))));
  }

  return {
    chunk_type: preferenceHints.includes("follow_up") ? "follow_up" : "call_memory",
    content: text.length > 280 ? `${text.slice(0, 277)}...` : text,
    source_text: text,
    tags: preferenceHints,
    language: detectLanguageMode(text),
    symptoms: symptomHints,
    importance: preferenceHints.length ? 75 : 50,
    facts: {
      current_activity: /\b(reading|watching tv|sleeping|eating|walking|sitting|resting|cooking|taking a bath|on the phone)\b/i.test(text)
        ? (text.match(/\b(reading|watching tv|sleeping|eating|walking|sitting|resting|cooking|taking a bath|on the phone)\b/i)?.[1] || null)
        : null,
      interests: [],
      full_name: null,
    },
  };
}

function normalizeAssistantReply(text) {
  const reply = (text || "").trim();
  if (!reply) return "Sorry, I didn’t catch that. What should we do next?";

  if (/(decided not to proceed|let's start fresh|let us start fresh|anything else|anything more|need anything else|goodbye|bye now)/i.test(reply)) {
    return "What would you like to do next?";
  }

  const questionMarks = reply.match(/\?/g) || [];
  if (questionMarks.length > 1) {
    const lastQuestionIndex = reply.lastIndexOf("?");
    const before = reply.slice(0, lastQuestionIndex).replace(/\?/g, ".");
    const after = reply.slice(lastQuestionIndex);
    return `${before}${after}`.replace(/\s+([?.!,])/g, "$1").replace(/\s{2,}/g, " ").trim();
  }

  return reply;
}

function normalizeCallerName(text) {
  return String(text || "").trim().replace(/\s+/g, " ").replace(/[?.!,]+$/g, "");
}

function memoryChunkLogView(memoryChunk = null) {
  if (!memoryChunk) return null;

  const facts = memoryChunk.facts && typeof memoryChunk.facts === "object" ? memoryChunk.facts : {};
  return {
    chunk_type: memoryChunk.chunk_type || null,
    content: memoryChunk.content || null,
    tags: Array.isArray(memoryChunk.tags) ? memoryChunk.tags : [],
    symptoms: Array.isArray(memoryChunk.symptoms) ? memoryChunk.symptoms : [],
    facts: {
      current_activity: typeof facts.current_activity === "string" ? facts.current_activity : typeof facts.activity === "string" ? facts.activity : typeof facts.what_elder_is_doing === "string" ? facts.what_elder_is_doing : null,
      interests: Array.isArray(facts.interests) ? facts.interests : Array.isArray(facts.interest) ? facts.interest : [],
      full_name: typeof facts.full_name === "string" ? facts.full_name : typeof facts.name === "string" ? facts.name : typeof facts.elder_name === "string" ? facts.elder_name : null,
      keys: Object.keys(facts),
    },
    importance: typeof memoryChunk.importance === "number" ? memoryChunk.importance : null,
  };
}

function extractJsonPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] || raw).trim();

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1);
  }

  return candidate;
}

function normalizeMemoryExtractionPayload(payload, transcript) {
  const parsed = payload && typeof payload === "object" ? payload : {};
  const memoryChunk = parsed.memory_chunk && typeof parsed.memory_chunk === "object" ? parsed.memory_chunk : null;
  const nestedFacts = memoryChunk?.facts && typeof memoryChunk.facts === "object" ? memoryChunk.facts : {};
  const fullName = typeof parsed.full_name === "string"
    ? parsed.full_name.trim()
    : typeof nestedFacts.full_name === "string"
      ? nestedFacts.full_name.trim()
      : typeof nestedFacts.name === "string"
        ? nestedFacts.name.trim()
        : "";

  return {
    full_name: fullName,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : String(transcript || "").trim().slice(0, 500),
    memoryChunk: memoryChunk && memoryChunk.content ? {
      ...memoryChunk,
      facts: memoryChunk.facts && typeof memoryChunk.facts === "object" ? memoryChunk.facts : {},
      tags: Array.isArray(memoryChunk.tags) ? memoryChunk.tags : [],
      symptoms: Array.isArray(memoryChunk.symptoms) ? memoryChunk.symptoms : [],
    } : null,
  };
}

function extractCallerNameCandidate(text) {
  const sample = normalizeCallerName(text);
  if (!sample) return "";

  const prefixed = sample.match(/(?:my name is|i am|i'm|call me|this is|i go by)\s+(.+)/i);
  if (prefixed?.[1]) {
    const cleaned = normalizeCallerName(prefixed[1].split(/\b(?:and|but|because|with)\b/i)[0].split(/[,.!?]/)[0]);
    if (cleaned && cleaned.split(/\s+/).length <= 3) return cleaned;
  }

  const parts = sample.split(/\s+/);
  if (parts.length <= 3 && /^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)*$/.test(sample)) {
    return sample;
  }

  return "";
}

function isAffirmativeReply(text) {
  return /^(yes|yeah|yep|yup|correct|right|sure|indeed|exactly|of course|please do)\b/i.test(normalizeCallerName(text));
}

function isNegativeReply(text) {
  return /^(no|nope|nah|not really|never|don't think so|do not think so|i don't think so)\b/i.test(normalizeCallerName(text));
}

async function extractImportantMemory(transcript) {
  const text = transcript.trim();
  if (!text) return null;

  const localFallback = () => {
    const fallback = buildFallbackMemoryChunk(text);
    return {
      summary: text.slice(0, 500),
      full_name: extractCallerNameCandidate(text) || "",
      memoryChunk: fallback && fallback.importance >= 50 ? fallback : null,
    };
  };

  if (!ANTHROPIC_API_KEY) return localFallback();

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
        model: MEMORY_EXTRACTION_MODEL,
        max_tokens: 1000,
        temperature: 0,
        system:
          "Extract structured elder profile data from this phone transcript. Return strict JSON only, with no markdown and no extra text. Use this schema: {\"full_name\": string|null, \"summary\": string, \"memory_chunk\": {\"chunk_type\": one of [\"caller_profile\",\"follow_up\",\"preference\",\"task\",\"call_memory\"], \"content\": string, \"source_text\": string, \"facts\": {\"current_activity\": string|null, \"interests\": string[], \"symptoms\": string[], \"full_name\": string|null}, \"tags\": string[], \"symptoms\": string[], \"importance\": number } | null }. Capture the person's name if it is stated or clearly implied. Capture reported symptoms like leg pain, weakness, fever, cough, confusion, falls, pain, dizziness, or breathing trouble only if explicitly mentioned. Capture current activity and interests only if the caller says them. Keep summary factual and concise. If nothing important is present, set memory_chunk to null and still return a short summary.",
        messages: [{ role: "user", content: `Transcript:\n${text}` }],
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      state.anthropicErrors += 1;
      logEvent({ type: "anthropic.error", status: response.status, statusText: response.statusText, details });
      return localFallback();
    }

    const payload = await response.json();
    const content = Array.isArray(payload?.content)
      ? payload.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n").trim()
      : String(payload?.content || "").trim();
    if (!content) return localFallback();

    const parsed = JSON.parse(extractJsonPayload(content) || content);
    return normalizeMemoryExtractionPayload(parsed, text);
  } catch (error) {
    state.anthropicErrors += 1;
    logEvent({ type: "anthropic.error", error: error.message, stage: "parse" });
    return localFallback();
  }
}

async function generateReplyWithAnthropic(turns, language, systemPrompt = "") {
  if (!ANTHROPIC_API_KEY || !turns.length) return null;

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
        model: RESPONSE_MODEL,
        max_tokens: 250,
        temperature: 0.4,
        system: `${systemPrompt ? `${systemPrompt}\n\n` : ""}${HUMAN_CALLING_SYSTEM_PROMPT}\n\nReply in ${languageInstruction(language)}. Keep the next reply appropriate for this exact conversation. Do not switch languages unless the caller switches languages first.`,
        messages: turns.map((turn) => ({
          role: turn.role === "assistant" ? "assistant" : "user",
          content: turn.content,
        })),
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      state.anthropicErrors += 1;
      logEvent({ type: "anthropic.error", status: response.status, statusText: response.statusText, details, stage: "reply" });
      return null;
    }

    const payload = await response.json();
    const content = Array.isArray(payload?.content)
      ? payload.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n").trim()
      : String(payload?.content || "").trim();
    return normalizeAssistantReply(content);
  } catch (error) {
    state.anthropicErrors += 1;
    logEvent({ type: "anthropic.error", error: error.message, stage: "reply" });
    return null;
  }
}

async function generateFallbackReply(turns, language, systemPrompt = "") {
  const anthropicReply = await generateReplyWithAnthropic(turns, language, systemPrompt);
  if (anthropicReply) return anthropicReply;

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
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: `${systemPrompt ? `${systemPrompt}\n\n` : ""}${HUMAN_CALLING_SYSTEM_PROMPT}\n\nReply in ${languageInstruction(language)}. Keep the next reply appropriate for this exact conversation. Do not switch languages unless the caller switches languages first.`,
          },
          ...turns.map((turn) => ({
            role: turn.role === "assistant" ? "assistant" : "user",
            content: turn.content,
          })),
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
    return normalizeAssistantReply(payload?.choices?.[0]?.message?.content);
  } catch {
    state.openrouterErrors += 1;
    return "Sorry, I didn’t catch that. What name should I use for you?";
  }
}

async function pushTranscriptChunk({ sessionId, ownerId, callerId, transcript, fullName, phoneE164, role = "user", memoryChunk = null, summary = "", turns = [], metadata = {} }) {
  if (!CALL_MEMORY_SYNC_URL || !transcript.trim()) return;
  logEvent({
    type: "memory.sync.request",
    session_id: sessionId,
    owner_id: ownerId || null,
    caller_id: callerId || null,
    elder_name: fullName || null,
    phone_e164: phoneE164 || null,
    summary: summary || null,
    memory_chunk: memoryChunkLogView(memoryChunk),
  });

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

  const payload = await response.json().catch(() => null);
  logEvent({
    type: "memory.sync.saved",
    session_id: sessionId,
    owner_id: ownerId || null,
    caller_id: payload?.caller_id || callerId || null,
    elder_id: payload?.elder_id || payload?.caller_id || callerId || null,
    elder_name: fullName || payload?.detected_name || null,
    language: payload?.language || metadata?.language || null,
    summary: summary || null,
    memory_chunk: memoryChunkLogView(memoryChunk),
    saved: true,
  });

  return payload;
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
        pace: SARVAM_TTS_PACE,
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
  const boostedAudioBase64 = boostMulawBase64(audioBase64, SARVAM_TTS_GAIN);
  if (boostedAudioBase64 && streamSid && twilioWs.readyState === WebSocket.OPEN) {
    state.twilioAudioPackets += 1;
    logEvent({ type: "audio.sent", source: "sarvam", stream_sid: streamSid });
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: boostedAudioBase64 },
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

function buildElderContextBlock(caller, memoryChunks) {
  const profileLines = [];
  if (caller?.full_name) profileLines.push(`Name: ${caller.full_name}`);
  if (caller?.current_activity) profileLines.push(`Current activity: ${caller.current_activity}`);
  if (Array.isArray(caller?.interests) && caller.interests.length) profileLines.push(`Interests: ${caller.interests.join(", ")}`);
  if (Array.isArray(caller?.symptoms) && caller.symptoms.length) profileLines.push(`Symptoms: ${caller.symptoms.join(", ")}`);
  if (caller?.preferred_language) profileLines.push(`Preferred language: ${caller.preferred_language}`);

  const memoryLines = Array.isArray(memoryChunks)
    ? memoryChunks.map((chunk, index) => {
        const parts = [];
        if (chunk.chunk_type) parts.push(chunk.chunk_type);
        if (chunk.content) parts.push(chunk.content);
        if (chunk.facts?.current_activity) parts.push(`activity: ${chunk.facts.current_activity}`);
        if (Array.isArray(chunk.facts?.interests) && chunk.facts.interests.length) parts.push(`interests: ${chunk.facts.interests.join(", ")}`);
        if (Array.isArray(chunk.facts?.symptoms) && chunk.facts.symptoms.length) parts.push(`symptoms: ${chunk.facts.symptoms.join(", ")}`);
        return `${index + 1}. ${parts.filter(Boolean).join(" - ")}`;
      })
    : [];

  return [
    "ELDER CONTEXT",
    profileLines.length ? profileLines.join("\n") : "Name: unknown",
    "MEMORY CHRONOLOGY",
    memoryLines.length ? memoryLines.join("\n") : "No prior memory chunks.",
  ].join("\n");
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
      ? client.from("callers").select("id, full_name").eq("phone_e164", phoneE164).eq("owner_id", ownerId).order("updated_at", { ascending: false }).limit(2)
      : client.from("callers").select("id, full_name").eq("phone_e164", phoneE164).is("owner_id", null).order("updated_at", { ascending: false }).limit(2);

    const { data: existingCallers } = await callerQuery;

    if (fullName) {
      const exactMatch = Array.isArray(existingCallers)
        ? existingCallers.find((caller) => normalizeCallerName(caller.full_name).toLowerCase() === normalizeCallerName(fullName).toLowerCase())
        : null;

      if (exactMatch?.id) {
        resolvedCallerId = exactMatch.id;
      } else {
        const { data: newCaller, error: insertError } = await client
          .from("callers")
          .insert({ owner_id: ownerId || null, phone_e164: phoneE164, full_name: fullName || null })
          .select("id")
          .single();

        if (insertError) throw insertError;
        resolvedCallerId = newCaller.id;
      }
    } else if (Array.isArray(existingCallers) && existingCallers.length === 1) {
      resolvedCallerId = existingCallers[0].id;
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
      anthropicRequests: state.anthropicRequests,
      anthropicErrors: state.anthropicErrors,
      sarvamSttConnections: state.sarvamSttConnections,
      sarvamSttErrors: state.sarvamSttErrors,
      sarvamSttPartials: state.sarvamSttPartials,
      sarvamSttFinals: state.sarvamSttFinals,
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
  let streamPhoneE164 = phoneE164;
  let streamFullName = fullName;

  let systemPrompt = "";
  let streamSid = "";
  let callSid = "";
  let resolvedSession = { id: sessionId, owner_id: ownerId || null, caller_id: callerId || null };
  let userTranscript = "";
  const conversationTurns = [];
  let elderContext = "";
  let elderContextCallerId = "";
  let greeted = false;
  let conversationLanguage = "auto";
  let preferredLanguage = "";
  let languageLocked = false;
  let awaitingLanguageChoice = false;
  let knownName = streamFullName || "";

  function buildCallContextLine() {
    const name = knownName ? `${knownName} ji` : "the caller";
    const lang = languageInstruction(conversationLanguage && conversationLanguage !== "auto" ? conversationLanguage : (preferredLanguage || "en"));
    const returning = elderContext ? "returning call" : "first call";
    return `CALL CONTEXT: speaking with ${name}. Address them with aap and ji. Reply language: ${lang}; match their Hindi/Punjabi/English mixing. Local time: ${callTimeContext()} (${SAATHI_TIME_ZONE}). ${returning}.`;
  }
  let twilioReady = false;
  const pendingTwilioMessages = [];
  let sarvamSttWs = null;
  let sarvamSttConnectPromise = null;
  let sarvamSttEndResolve = null;
  const pendingSarvamAudio = [];
  const pendingTranscripts = [];
  const bufferedFinalTranscripts = [];
  let bufferedFinalTranscriptLanguage = conversationLanguage;
  let bufferedFinalTranscriptTimer = null;
  let pendingCallerMatch = null;
  let turnProcessing = false;
  let callStopping = false;

  async function savePreferredLanguage(callerIdValue, code) {
    try {
      const client = getSupabase();
      if (!client || !callerIdValue || !code) return;
      await client.from("callers").update({ preferred_language: code }).eq("id", callerIdValue);
      logEvent({ type: "language.saved", session_id: resolvedSession.id, elder_id: callerIdValue, language: code });
    } catch (error) {
      logEvent({ type: "language.save.error", session_id: resolvedSession.id, error: error.message });
    }
  }

  async function loadElderContextForCaller(callerIdValue) {
    if (!callerIdValue) return "";
    if (elderContextCallerId === callerIdValue && elderContext) return elderContext;

    const client = getSupabase();
    if (!client) return "";

    const { data: caller, error: callerError } = await client
      .from("callers")
      .select("id, full_name, current_activity, interests, symptoms, preferred_language, metadata")
      .eq("id", callerIdValue)
      .maybeSingle();

    if (callerError) throw callerError;

    const { data: memoryChunks, error: memoryError } = await client
      .from("memory_chunks")
      .select("chunk_type, content, facts, tags, symptoms, created_at, importance")
      .eq("caller_id", callerIdValue)
      .order("created_at", { ascending: true });

    if (memoryError) throw memoryError;

    const normalizedCaller = caller
      ? {
          ...caller,
          interests: Array.isArray(caller.interests) ? caller.interests : [],
          symptoms: Array.isArray(caller.symptoms) ? caller.symptoms : [],
        }
      : null;

    if (normalizedCaller?.full_name) knownName = normalizeCallerName(normalizedCaller.full_name) || knownName;
    const storedLang = languageModeFromCode(normalizedCaller?.preferred_language || "");
    if (storedLang && !languageLocked) {
      preferredLanguage = storedLang;
      languageLocked = true;
      awaitingLanguageChoice = false;
      conversationLanguage = preferredLanguage;
    }

    elderContextCallerId = callerIdValue;
    elderContext = buildElderContextBlock(normalizedCaller, memoryChunks || []);
    logEvent({
      type: "elder.context.loaded",
      session_id: resolvedSession.id,
      elder_id: callerIdValue,
      memory_chunks: Array.isArray(memoryChunks) ? memoryChunks.length : 0,
    });
    return elderContext;
  }

  logEvent({ type: "ws.connection", session_id: sessionId, path: url.pathname });

  twilioWs.on("message", (raw) => {
    if (!twilioReady) pendingTwilioMessages.push(raw);
  });

  function sarvamSttSocketUrl() {
    const sttUrl = new URL(SARVAM_STT_URL);
    sttUrl.searchParams.set("model", SARVAM_STT_MODEL);
    sttUrl.searchParams.set("language_code", SARVAM_STT_LANGUAGE || "auto");
    sttUrl.searchParams.set("stream_type", "fast");
    sttUrl.searchParams.set("mode", SARVAM_STT_MODE);
    sttUrl.searchParams.set("endpointing", "vad");
    sttUrl.searchParams.set("encoding", "mulaw");
    sttUrl.searchParams.set("sample_rate", "8000");
    sttUrl.searchParams.set("threshold", "0.3");
    sttUrl.searchParams.set("silence_duration_ms", String(SARVAM_SILENCE_DURATION_MS));
    sttUrl.searchParams.set("min_speech_duration_ms", String(SARVAM_MIN_SPEECH_DURATION_MS));
    return sttUrl.toString();
  }

  function resolveSarvamSttEnd() {
    if (!sarvamSttEndResolve) return;
    const resolve = sarvamSttEndResolve;
    sarvamSttEndResolve = null;
    resolve();
  }

  function clearBufferedFinalTranscriptTimer() {
    if (bufferedFinalTranscriptTimer) {
      clearTimeout(bufferedFinalTranscriptTimer);
      bufferedFinalTranscriptTimer = null;
    }
  }

  async function flushBufferedFinalTranscript() {
    clearBufferedFinalTranscriptTimer();
    const merged = bufferedFinalTranscripts.splice(0).map((item) => item.transcript).filter(Boolean).join(" ").trim();
    if (!merged) return;
    pendingTranscripts.push({ transcript: merged, detectedLanguage: bufferedFinalTranscriptLanguage });
    void drainTranscriptQueue();
  }

  function scheduleBufferedFinalTranscriptFlush() {
    clearBufferedFinalTranscriptTimer();
    bufferedFinalTranscriptTimer = setTimeout(() => {
      bufferedFinalTranscriptTimer = null;
      void flushBufferedFinalTranscript();
    }, FINAL_TRANSCRIPT_FLUSH_DELAY_MS);
  }

  async function updateSessionCallerId(callerIdValue) {
    resolvedSession.caller_id = callerIdValue;
    const client = getSupabase();
    if (!client || !resolvedSession.id || !callerIdValue) return;

    const { error } = await client
      .from("call_sessions")
      .update({ caller_id: callerIdValue })
      .eq("id", resolvedSession.id);
    if (error) {
      logEvent({ type: "elder.assignment.error", session_id: resolvedSession.id, elder_id: callerIdValue, error: error.message });
      throw error;
    }
  }

  async function findCallerByName(name) {
    const client = getSupabase();
    const normalized = normalizeCallerName(name);
    if (!client || !normalized) return null;

    const query = ownerId
      ? client.from("callers").select("id, full_name, phone_e164").eq("owner_id", ownerId).ilike("full_name", normalized).order("updated_at", { ascending: false }).limit(5)
      : client.from("callers").select("id, full_name, phone_e164").is("owner_id", null).ilike("full_name", normalized).order("updated_at", { ascending: false }).limit(5);

    const { data, error } = await query;
    if (error) throw error;
    if (!Array.isArray(data) || !data.length) return null;
    return data[0];
  }

  async function createCallerProfile(fullName) {
    const client = getSupabase();
    const normalizedName = normalizeCallerName(fullName);
    if (!client) return null;

    const { data, error } = await client
      .from("callers")
      .insert({
        owner_id: resolvedSession.owner_id || null,
        phone_e164: streamPhoneE164 || null,
        full_name: normalizedName || null,
        preferred_language: SARVAM_STT_LANGUAGE === "auto" ? "en" : SARVAM_STT_LANGUAGE,
        metadata: { source: "auto_call_start", session_id: resolvedSession.id || null },
      })
      .select("id, full_name, phone_e164")
      .single();

    if (error) throw error;
    return data || null;
  }

  async function linkCallerProfile(caller) {
    if (!caller?.id) return;
    await updateSessionCallerId(caller.id);

    const client = getSupabase();
    if (!client) return;

    if (caller.full_name) {
      knownName = normalizeCallerName(caller.full_name) || knownName;
      await client.from("callers").update({ full_name: normalizeCallerName(caller.full_name) }).eq("id", caller.id);
    }
  }

  async function ensureAutoCallerProfile() {
    if (resolvedSession.caller_id) return resolvedSession.caller_id;
    const caller = await createCallerProfile(streamFullName || "");
    if (caller?.id) {
      await linkCallerProfile(caller);
      logEvent({
        type: "elder.assigned",
        session_id: resolvedSession.id,
        elder_id: caller.id,
        elder_name: caller.full_name || null,
        phone_e164: caller.phone_e164 || streamPhoneE164 || null,
        source: "call_start",
      });
      return caller.id;
    }
    logEvent({
      type: "elder.assignment.failed",
      session_id: resolvedSession.id,
      phone_e164: streamPhoneE164 || null,
      reason: "caller insert returned no id",
    });
    return null;
  }

  async function deliverAssistantReply(reply, source = "openrouter") {
    if (ASSISTANT_REPLY_THINK_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, ASSISTANT_REPLY_THINK_MS));
    }
    conversationTurns.push({ role: "assistant", content: reply });
    logEvent({
      type: "conversation.line",
      session_id: resolvedSession.id,
      role: "assistant",
      content: reply,
      language: conversationLanguage,
      source,
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

  function handleSarvamSttMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      state.sarvamSttErrors += 1;
      logEvent({ type: "sarvam.stt.error", error: error.message, stage: "parse" });
      return;
    }

    const event = message?.event || message?.type;
    if (event === "transcript.partial") {
      state.sarvamSttPartials += 1;
      return;
    }

    if (/speech[_\.-]?end|vad\.speech_end|speech_stop|speech\.stop/i.test(event)) {
      void flushBufferedFinalTranscript();
      return;
    }

    if (event === "vad.speech_start") {
      if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      }
      return;
    }

    if (event === "transcript.final") {
      const transcript = String(message.text || message.transcript || message.data?.text || message.data?.transcript || "").trim();
      if (!transcript) return;

      state.sarvamSttFinals += 1;
      const detectedLanguage = languageModeFromCode(message.language || message.language_code || message.data?.language || message.data?.language_code);
      bufferedFinalTranscripts.push({ transcript, detectedLanguage });
      bufferedFinalTranscriptLanguage = detectedLanguage || bufferedFinalTranscriptLanguage;
      scheduleBufferedFinalTranscriptFlush();
      return;
    }

    if (event === "session.end") {
      void flushBufferedFinalTranscript();
      resolveSarvamSttEnd();
      return;
    }

    if (event === "error") {
      state.sarvamSttErrors += 1;
      logEvent({
        type: "sarvam.stt.error",
        code: message.code,
        fatal: Boolean(message.is_fatal),
        details: message.message || message.error,
      });
    }
  }

  async function connectSarvamStt() {
    if (!SARVAM_API_KEY) {
      state.lastError = "Missing SARVAM_API_KEY";
      logEvent({ type: "config.error", session_id: resolvedSession.id, message: state.lastError, stage: "sarvam_stt" });
      return false;
    }

    if (sarvamSttWs?.readyState === WebSocket.OPEN) return true;
    if (sarvamSttConnectPromise) return sarvamSttConnectPromise;

    sarvamSttConnectPromise = new Promise((resolve) => {
      let settled = false;
      const sttWs = new WebSocket(sarvamSttSocketUrl(), {
        headers: { "api-subscription-key": SARVAM_API_KEY },
      });
      sarvamSttWs = sttWs;

      sttWs.on("open", () => {
        if (settled) return;
        settled = true;
        state.sarvamSttConnections += 1;
        logEvent({ type: "sarvam.stt.connected", session_id: resolvedSession.id, model: SARVAM_STT_MODEL });
        while (pendingSarvamAudio.length && sttWs.readyState === WebSocket.OPEN) {
          sttWs.send(JSON.stringify({ event: "audio_input", audio: pendingSarvamAudio.shift() }));
        }
        resolve(true);
      });

      sttWs.on("message", handleSarvamSttMessage);

      sttWs.on("error", (error) => {
        state.sarvamSttErrors += 1;
        logEvent({ type: "sarvam.stt.error", error: error.message, stage: "socket" });
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });

      sttWs.on("close", (code, reason) => {
        if (sarvamSttWs === sttWs) sarvamSttWs = null;
        resolveSarvamSttEnd();
        logEvent({ type: "sarvam.stt.closed", session_id: resolvedSession.id, code, reason: reason.toString() });
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
    }).finally(() => {
      sarvamSttConnectPromise = null;
    });

    return sarvamSttConnectPromise;
  }

  function forwardAudioToSarvam(payload) {
    if (!payload || callStopping) return;
    if (sarvamSttWs?.readyState === WebSocket.OPEN) {
      sarvamSttWs.send(JSON.stringify({ event: "audio_input", audio: payload }));
      return;
    }

    if (pendingSarvamAudio.length < 250) pendingSarvamAudio.push(payload);
    void connectSarvamStt();
  }

  async function processTranscript({ transcript, detectedLanguage }) {
    const cleanTranscript = normalizeCallerName(transcript);
    userTranscript = `${userTranscript} ${cleanTranscript}`.trim();
    const detected = detectLanguageMode(cleanTranscript, detectedLanguage || conversationLanguage || "en");

    conversationTurns.push({ role: "user", content: cleanTranscript });

    // Explicit switch requests always win ("speak in Hindi", "English me baat karo").
    const switchAsk = parseLanguageSwitchRequest(cleanTranscript);
    if (languageLocked && switchAsk && switchAsk !== preferredLanguage) {
      preferredLanguage = switchAsk;
      conversationLanguage = preferredLanguage;
      logEvent({ type: "language.switched", session_id: resolvedSession.id, language: preferredLanguage, content: cleanTranscript });
      void savePreferredLanguage(resolvedSession.caller_id, preferredLanguage);
      logEvent({
        type: "conversation.line",
        session_id: resolvedSession.id,
        role: "user",
        content: cleanTranscript,
        language: conversationLanguage,
        detected_language: detected,
        source: "sarvam_stt",
      });
      const earlySwitch = conversationTurns.filter((t) => t.role === "user").length <= 2;
      const confirmSwitch = languageConfirmLine(preferredLanguage) + (earlySwitch ? ` ${timeAwareMealQuestion(preferredLanguage)}` : " Toh batao, aur kya chal raha hai?");
      await deliverAssistantReply(confirmSwitch, "language_switch");
      return;
    }

    // We asked which language - lock whatever they chose.
    if (awaitingLanguageChoice) {
      const picked = parseLanguageChoice(cleanTranscript) || switchAsk || (LANGUAGE_LABELS[detected] ? detected : "");
      if (picked) {
        preferredLanguage = picked;
        languageLocked = true;
        awaitingLanguageChoice = false;
        conversationLanguage = preferredLanguage;
        logEvent({ type: "language.locked", session_id: resolvedSession.id, language: preferredLanguage, content: cleanTranscript });
        void savePreferredLanguage(resolvedSession.caller_id, preferredLanguage);
        logEvent({
          type: "conversation.line",
          session_id: resolvedSession.id,
          role: "user",
          content: cleanTranscript,
          language: conversationLanguage,
          detected_language: detected,
          source: "sarvam_stt",
        });
        await deliverAssistantReply(`${languageConfirmLine(preferredLanguage)} ${timeAwareMealQuestion(preferredLanguage)}`, "language_choice");
        return;
      }
      logEvent({
        type: "conversation.line",
        session_id: resolvedSession.id,
        role: "user",
        content: cleanTranscript,
        language: conversationLanguage,
        detected_language: detected,
        source: "sarvam_stt",
      });
      await deliverAssistantReply(languageChoiceQuestion(), "language_choice_repeat");
      return;
    }

    // Locked: NEVER auto-switch on transcription noise. Unlocked: follow detection.
    if (languageLocked && preferredLanguage) {
      conversationLanguage = preferredLanguage;
    } else {
      conversationLanguage = detected || conversationLanguage || "en";
    }

    logEvent({
      type: "conversation.line",
      session_id: resolvedSession.id,
      role: "user",
      content: cleanTranscript,
      language: conversationLanguage,
      detected_language: detected,
      source: "sarvam_stt",
    });

    if (pendingCallerMatch) {
      const candidate = pendingCallerMatch.candidate;
      const proposedName = pendingCallerMatch.proposedName;
      pendingCallerMatch = null;

      if (isAffirmativeReply(cleanTranscript)) {
        await linkCallerProfile(candidate);
        await loadElderContextForCaller(candidate.id).catch((error) => logEvent({ type: "elder.context.error", elder_id: candidate.id, error: error.message }));
        if (!languageLocked) {
          awaitingLanguageChoice = true;
          await deliverAssistantReply(`Okay, ${candidate.full_name || proposedName} ji. ${languageChoiceQuestion()}`, "elder_match_lang");
          return;
        }
        await deliverAssistantReply(`Okay. I\u2019ll use ${candidate.full_name || proposedName} from here. ${timeAwareMealQuestion(conversationLanguage)}`, "elder_match");
        return;
      }

      if (isNegativeReply(cleanTranscript)) {
        if (candidate.phone_e164 && phoneE164 && candidate.phone_e164 === phoneE164) {
          await linkCallerProfile(candidate);
          await loadElderContextForCaller(candidate.id).catch((error) => logEvent({ type: "elder.context.error", elder_id: candidate.id, error: error.message }));
          if (!languageLocked) {
            awaitingLanguageChoice = true;
            await deliverAssistantReply(`Okay ji. ${languageChoiceQuestion()}`, "elder_match_same_phone_lang");
            return;
          }
          await deliverAssistantReply(`Okay. I\u2019ll keep the existing profile for ${candidate.full_name || proposedName}. ${timeAwareMealQuestion(conversationLanguage)}`, "elder_match_same_phone");
          return;
        }

        const newCaller = await createCallerProfile(proposedName);
        if (newCaller?.id) {
          await linkCallerProfile(newCaller);
          elderContextCallerId = "";
          elderContext = "";
          knownName = normalizeCallerName(proposedName) || knownName;
          awaitingLanguageChoice = true;
          await deliverAssistantReply(`Okay. I made a new profile for ${proposedName}. ${languageChoiceQuestion()}`, "elder_new_lang");
          return;
        }
      }

      await deliverAssistantReply("Was that a yes or a no?", "elder_confirm");
      pendingCallerMatch = candidate ? { candidate, proposedName } : null;
      return;
    }

    if (!resolvedSession.caller_id) {
      const callerName = extractCallerNameCandidate(cleanTranscript);
      if (callerName) {
        const existingCaller = await findCallerByName(callerName);

        if (existingCaller?.id) {
          pendingCallerMatch = { candidate: existingCaller, proposedName: callerName };
          await deliverAssistantReply(`I think I may have talked with someone named ${existingCaller.full_name || callerName} before. Have we talked before?`, "elder_match_prompt");
          return;
        }

        const newCaller = await createCallerProfile(callerName);
        if (newCaller?.id) {
          await linkCallerProfile(newCaller);
          elderContextCallerId = "";
          elderContext = "";
          knownName = normalizeCallerName(callerName) || knownName;
          awaitingLanguageChoice = true;
          await deliverAssistantReply(`Thanks, ${callerName}. ${languageChoiceQuestion()}`, "elder_new_prompt");
          return;
        }
      }
    }

    if (resolvedSession.caller_id && !elderContext) {
      await loadElderContextForCaller(resolvedSession.caller_id).catch((error) => logEvent({ type: "elder.context.error", elder_id: resolvedSession.caller_id, error: error.message }));
    }

    // Known caller but no stored language yet: ask once instead of guessing.
    if (resolvedSession.caller_id && !languageLocked && !awaitingLanguageChoice) {
      awaitingLanguageChoice = true;
      await deliverAssistantReply(languageChoiceQuestion(), "language_choice_first");
      return;
    }

    const combinedSystemPrompt = [systemPrompt || "", elderContext || "", buildCallContextLine()].filter(Boolean).join("\n\n");
    const reply = await generateFallbackReply(conversationTurns, conversationLanguage, combinedSystemPrompt);
    await deliverAssistantReply(reply, "openrouter");
  }

  async function drainTranscriptQueue() {
    if (turnProcessing) return;
    turnProcessing = true;
    try {
      while (pendingTranscripts.length) {
        await processTranscript(pendingTranscripts.shift());
      }
    } finally {
      turnProcessing = false;
    }
  }

  async function waitForTranscriptQueue() {
    while (turnProcessing || pendingTranscripts.length) {
      if (!turnProcessing) void drainTranscriptQueue();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function stopSarvamStt() {
    const sttWs = sarvamSttWs;
    if (!sttWs || sttWs.readyState !== WebSocket.OPEN) return;

    const endPromise = new Promise((resolve) => {
      sarvamSttEndResolve = resolve;
      setTimeout(resolve, 1500);
    });
    sttWs.send(JSON.stringify({ event: "end" }));
    await endPromise;
    if (sttWs.readyState === WebSocket.OPEN) sttWs.close(1000, "call ended");
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
          if (custom.phone_e164) streamPhoneE164 = custom.phone_e164;
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

          if (resolvedSession.caller_id) {
            await loadElderContextForCaller(resolvedSession.caller_id).catch((error) => logEvent({ type: "elder.context.error", elder_id: resolvedSession.caller_id, error: error.message }));
          }

          await connectSarvamStt();
          const settings = await loadAgentSettings();
          systemPrompt = settings.system_prompt || "You are a warm, human-sounding phone assistant. Keep replies short and neutral. Never imply the call is over or that the caller declined. Ask one simple question at a time.";

          if (!greeted) {
            greeted = true;
            const greeting = "Namaste Ji! Main Saathi - na koi jaldi, na koi kaam, bas aapke saath thodi mithi baatein aur aaram! Kaise hain aap aaj? Aapka naam kya hai?";
            logEvent({ type: "assistant.greeting", session_id: resolvedSession.id, content: greeting, source: "sarvam" });
            await sendAudioToTwilio(twilioWs, streamSid, greeting, conversationLanguage);
          }
        }

        if (message.event === "media") {
          if (!state.lastEvent || state.lastEvent.type !== "twilio.media") {
            logEvent({ type: "twilio.media", session_id: resolvedSession.id });
          }

          forwardAudioToSarvam(message.media?.payload);
        }

        if (message.event === "stop") {
          logEvent({ type: "twilio.stop", session_id: resolvedSession.id });
          callStopping = true;
          await flushBufferedFinalTranscript();
          await stopSarvamStt();
          await waitForTranscriptQueue();
          const client = getSupabase();
          if (client && resolvedSession.id) {
            await client
              .from("call_sessions")
              .update({
                status: "completed",
                ended_at: new Date().toISOString(),
                last_activity_at: new Date().toISOString(),
              })
              .eq("id", resolvedSession.id);
          }
          const fullTranscript = conversationTurns.map((turn) => `${turn.role}: ${turn.content}`).join("\n").trim();
          const extracted = await extractImportantMemory(userTranscript || fullTranscript);

          await pushTranscriptChunk({
            sessionId: resolvedSession.id,
            ownerId: resolvedSession.owner_id,
            callerId: resolvedSession.caller_id,
            transcript: userTranscript || fullTranscript,
            fullName: extracted?.full_name || streamFullName,
            phoneE164: streamPhoneE164,
            role: "assistant",
            summary: extracted?.summary || (userTranscript || fullTranscript).slice(0, 500),
            memoryChunk: extracted?.memoryChunk || null,
            metadata: { language: conversationLanguage, extracted_full_name: extracted?.full_name || null, memory_extraction_model: MEMORY_EXTRACTION_MODEL },
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
    callStopping = true;
    clearBufferedFinalTranscriptTimer();
    if (sarvamSttWs?.readyState === WebSocket.OPEN) sarvamSttWs.close(1000, "Twilio stream closed");
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
