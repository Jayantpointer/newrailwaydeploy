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
  const callerId = body.caller_id ?? session.caller_id ?? null;
  const language = body.metadata?.language ? String(body.metadata.language) : detectLanguageMode(body.transcript || body.summary || "");

  const { error: sessionUpdateError } = await admin
    .from("call_sessions")
    .update({
      owner_id: ownerId,
      caller_id: callerId,
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

  if (callerId) {
    const { error: callerLanguageError } = await admin
      .from("callers")
      .update({ preferred_language: language })
      .eq("id", callerId);

    if (callerLanguageError) {
      return Response.json({ error: callerLanguageError.message }, { status: 400, headers: corsHeaders });
    }
  }

  const symptomList = Array.isArray(body.memory_chunk?.symptoms) ? body.memory_chunk?.symptoms.filter(Boolean) : [];

  const transcript = body.transcript ?? "";
  const detectedName = body.full_name ?? detectCallerName(transcript);

  if (detectedName) {
    const { error: callerUpdateError } = await admin
      .from("callers")
      .update({ full_name: detectedName })
      .eq("id", callerId)
      .eq("owner_id", ownerId);

    if (callerUpdateError && callerId) {
      return Response.json({ error: callerUpdateError.message }, { status: 400, headers: corsHeaders });
    }

    if (!callerId) {
      if (body.phone_e164) {
      const { error: callerInsertError } = await admin.from("callers").insert({
        owner_id: ownerId,
        phone_e164: body.phone_e164,
        full_name: detectedName,
        preferred_language: language,
        symptoms: [],
        metadata: { source: "transcript_sync", language },
      });

        if (callerInsertError) {
          return Response.json({ error: callerInsertError.message }, { status: 400, headers: corsHeaders });
        }
      } else {
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
    }
  }

  try {
    await saveMemoryChunk(body, ownerId, callerId, language);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400, headers: corsHeaders });
  }

  if (callerId && symptomList.length) {
    const { data: existingCaller } = await admin
      .from("callers")
      .select("symptoms")
      .eq("id", callerId)
      .maybeSingle();

    const mergedSymptoms = Array.from(new Set([...(existingCaller?.symptoms ?? []), ...symptomList]));
    const { error: callerSymptomError } = await admin
      .from("callers")
      .update({ symptoms: mergedSymptoms, preferred_language: language })
      .eq("id", callerId);

    if (callerSymptomError) {
      return Response.json({ error: callerSymptomError.message }, { status: 400, headers: corsHeaders });
    }
  }

  return Response.json({
    ok: true,
    session_id: body.session_id,
    owner_id: ownerId,
    caller_id: callerId,
    detected_name: detectedName || null,
    language,
  }, { headers: corsHeaders });
});
