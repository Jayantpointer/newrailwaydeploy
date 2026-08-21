import { createClient } from "npm:@supabase/supabase-js@2";

type MemorySyncPayload = {
  session_id: string;
  owner_id?: string;
  caller_id?: string;
  phone_e164?: string;
  full_name?: string;
  summary?: string;
  transcript?: string;
  turns?: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  memory_chunk?: {
    chunk_type?: "call_memory" | "caller_profile" | "follow_up" | "preference" | "task";
    content?: string;
    source_text?: string;
    facts?: Record<string, unknown>;
    tags?: string[];
    symptoms?: string[];
    importance?: number;
  };
  metadata?: Record<string, unknown>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function detectCallerName(transcript: string) {
  const patterns = [
    /(?:my name is|i am|i'm|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
    /(?:call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return "";
}

function detectLanguageMode(text: string) {
  const sample = (text || "").trim();
  if (!sample) return "en";

  const hasHindiScript = /[\u0900-\u097F]/.test(sample);
  const hasEnglishWords = /\b(the|and|you|call|name|hello|thanks|yes|no|please)\b/i.test(sample);
  const hasRomanHindi = /\b(ka|ki|ke|hai|haan|nahi|kya|mera|meri|aap|main|mein|thoda|thodi|abhi|kal|aaj|baad)\b/i.test(sample);

  if (hasHindiScript && hasEnglishWords) return "hinglish";
  if (hasHindiScript || hasRomanHindi) return "hi";
  if (hasEnglishWords) return "en";
  return "en";
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return Array.from(
    new Set(
      value
        .map((item) => normalizeText(item))
        .filter((item): item is string => Boolean(item)),
    ),
  );
}

function extractProfileFacts(memoryChunk?: MemorySyncPayload["memory_chunk"]) {
  const facts = memoryChunk?.facts ?? {};
  const currentActivity = normalizeText(facts.current_activity ?? facts.activity ?? facts.what_elder_is_doing);
  const interests = normalizeStringArray(facts.interests ?? facts.interest);
  const symptoms = normalizeStringArray(memoryChunk?.symptoms ?? facts.symptoms);

  return {
    currentActivity,
    interests,
    symptoms,
  };
}

async function resolveCallerId(payload: MemorySyncPayload, ownerId: string | null, detectedName: string) {
  const phoneE164 = normalizeText(payload.phone_e164);
  const suppliedCallerId = normalizeText(payload.caller_id);
  const normalizedName = normalizeText(payload.full_name || detectedName);

  if (suppliedCallerId) return suppliedCallerId;

  if (phoneE164) {
    const phoneQuery = ownerId
      ? admin.from("callers").select("id, full_name").eq("owner_id", ownerId).eq("phone_e164", phoneE164).order("updated_at", { ascending: false }).limit(2)
      : admin.from("callers").select("id, full_name").is("owner_id", null).eq("phone_e164", phoneE164).order("updated_at", { ascending: false }).limit(2);

    const { data: existingByPhone, error: phoneError } = await phoneQuery;
    if (phoneError) throw phoneError;

    if (normalizedName && Array.isArray(existingByPhone) && existingByPhone.length) {
      const exactMatch = existingByPhone.find((caller) => normalizeText(caller.full_name).toLowerCase() === normalizedName.toLowerCase());
      if (exactMatch?.id) return exactMatch.id as string;
    }

    if (!normalizedName && Array.isArray(existingByPhone) && existingByPhone.length === 1) return existingByPhone[0].id as string;

    if (normalizedName) {
      const nameQuery = ownerId
        ? admin.from("callers").select("id").eq("owner_id", ownerId).ilike("full_name", normalizedName).order("updated_at", { ascending: false }).limit(2)
        : admin.from("callers").select("id").is("owner_id", null).ilike("full_name", normalizedName).order("updated_at", { ascending: false }).limit(2);

      const { data: nameMatches, error: nameError } = await nameQuery;
      if (nameError) throw nameError;
      if (Array.isArray(nameMatches) && nameMatches.length === 1) return nameMatches[0].id as string;
    }

    if (normalizedName) {
      const { data: createdCaller, error: createError } = await admin
        .from("callers")
        .insert({
          owner_id: ownerId,
          phone_e164: phoneE164,
          full_name: normalizedName,
          preferred_language: detectLanguageMode(payload.transcript || payload.summary || normalizedName),
          metadata: { source: "transcript_sync", language: detectLanguageMode(payload.transcript || payload.summary || normalizedName) },
        })
        .select("id")
        .single();

      if (createError) throw createError;
      return createdCaller?.id ?? null;
    }
  }

  return null;
}

async function saveMemoryChunk(payload: MemorySyncPayload, ownerId: string | null, callerId: string | null, language: string) {
  const content = payload.memory_chunk?.content?.trim() || payload.summary?.trim();
  if (!content) return;

  const { error } = await admin.from("memory_chunks").insert({
    owner_id: ownerId,
    caller_id: callerId,
    session_id: payload.session_id,
    chunk_type: payload.memory_chunk?.chunk_type ?? "call_memory",
    content,
    source_text: payload.memory_chunk?.source_text ?? payload.summary ?? null,
    facts: payload.memory_chunk?.facts ?? {},
    tags: payload.memory_chunk?.tags ?? [],
    language,
    symptoms: payload.memory_chunk?.symptoms ?? [],
    importance: payload.memory_chunk?.importance ?? 50,
  });

  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });

  if (!serviceRoleKey) {
    return Response.json({ error: "Missing Supabase service role key" }, { status: 500, headers: corsHeaders });
  }

  const body = (await req.json()) as MemorySyncPayload;
  if (!body.session_id) {
    return Response.json({ error: "Missing session_id" }, { status: 400, headers: corsHeaders });
  }

  const { data: session, error: sessionError } = await admin
    .from("call_sessions")
    .select("id, owner_id, caller_id")
    .eq("id", body.session_id)
    .maybeSingle();

  if (sessionError) {
    return Response.json({ error: sessionError.message }, { status: 400, headers: corsHeaders });
  }

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404, headers: corsHeaders });
  }

  const ownerId = body.owner_id ?? session.owner_id ?? null;
  const transcript = body.transcript ?? "";
  const detectedName = body.full_name ?? detectCallerName(transcript);
  const language = body.metadata?.language ? String(body.metadata.language) : detectLanguageMode(transcript || body.summary || detectedName);
  const profileFacts = extractProfileFacts(body.memory_chunk);
  const resolvedCallerId = await resolveCallerId(body, ownerId, detectedName);

  const { error: sessionUpdateError } = await admin
    .from("call_sessions")
    .update({
      owner_id: ownerId,
      caller_id: resolvedCallerId,
      summary: body.summary ?? undefined,
      last_activity_at: new Date().toISOString(),
      metadata: {
        ...(body.metadata ?? {}),
        transcript_synced_at: new Date().toISOString(),
        language,
      },
    })
    .eq("id", body.session_id);

  if (sessionUpdateError) {
    return Response.json({ error: sessionUpdateError.message }, { status: 400, headers: corsHeaders });
  }

  let callerData: { symptoms?: string[]; interests?: string[]; current_activity?: string; metadata?: Record<string, unknown>; full_name?: string | null } | null = null;

  if (resolvedCallerId) {
    const { data, error } = await admin
      .from("callers")
      .select("symptoms, interests, current_activity, metadata, full_name")
      .eq("id", resolvedCallerId)
      .maybeSingle();

    if (error) return Response.json({ error: error.message }, { status: 400, headers: corsHeaders });
    callerData = data;
  }

  const mergedSymptoms = Array.from(new Set([...(callerData?.symptoms ?? []), ...profileFacts.symptoms]));
  const mergedInterests = Array.from(new Set([...(callerData?.interests ?? []), ...profileFacts.interests]));
  const currentActivity = profileFacts.currentActivity || callerData?.current_activity || "";

  if (resolvedCallerId) {
    const { error: callerUpdateError } = await admin
      .from("callers")
      .update({
        full_name: detectedName || callerData?.full_name || undefined,
        preferred_language: language,
        current_activity: currentActivity || undefined,
        interests: mergedInterests,
        symptoms: mergedSymptoms,
        metadata: {
          ...(callerData?.metadata ?? {}),
          elder_profile: {
            ...(typeof callerData?.metadata?.elder_profile === "object" && callerData.metadata?.elder_profile !== null ? callerData.metadata.elder_profile : {}),
            current_activity: currentActivity || undefined,
            interests: mergedInterests,
            symptoms: mergedSymptoms,
            last_synced_at: new Date().toISOString(),
          },
          source: "transcript_sync",
          language,
        },
      })
      .eq("id", resolvedCallerId);

    if (callerUpdateError) {
      return Response.json({ error: callerUpdateError.message }, { status: 400, headers: corsHeaders });
    }
  } else if (detectedName) {
    const { error: sessionMetadataError } = await admin
      .from("call_sessions")
      .update({
        metadata: {
          ...(body.metadata ?? {}),
          detected_caller_name: detectedName,
          language,
        },
      })
      .eq("id", body.session_id);

    if (sessionMetadataError) {
      return Response.json({ error: sessionMetadataError.message }, { status: 400, headers: corsHeaders });
    }
  }

  try {
    await saveMemoryChunk(body, ownerId, resolvedCallerId, language);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400, headers: corsHeaders });
  }

  return Response.json({
    ok: true,
    session_id: body.session_id,
    owner_id: ownerId,
    caller_id: resolvedCallerId,
    elder_id: resolvedCallerId,
    detected_name: detectedName || null,
    language,
  }, { headers: corsHeaders });
});
