import { createClient } from "npm:@supabase/supabase-js@2";

type OrchestratorPayload = {
  owner_id?: string;
  phone_e164?: string;
  full_name?: string;
  direction?: "inbound" | "outbound";
  provider_name?: string;
  provider_call_id?: string;
  provider_session_id?: string;
  session_id?: string;
  event_type?: string;
  content?: string;
  role?: "system" | "user" | "assistant" | "tool";
  summary?: string;
  transcript?: string;
  caller_name?: string;
  memory_chunk?: {
    chunk_type?: "call_memory" | "caller_profile" | "follow_up" | "preference" | "task";
    content?: string;
    source_text?: string;
    facts?: Record<string, unknown>;
    tags?: string[];
    language?: string;
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
const anthropicModel = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5";
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const sarvamVoiceId = Deno.env.get("SARVAM_VOICE_ID") ?? "";
const sarvamApiKey = Deno.env.get("SARVAM_API_KEY") ?? "";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function persistMemoryChunk(params: {
  sessionId: string;
  ownerId: string | null;
  callerId: string | null;
  chunk?: OrchestratorPayload["memory_chunk"];
  summary?: string;
  transcript?: string;
}) {
  const { sessionId, ownerId, callerId, chunk, summary, transcript } = params;

  const content = chunk?.content?.trim() || summary?.trim() || transcript?.trim();
  if (!content) return;

  const { error } = await admin.from("memory_chunks").insert({
    owner_id: ownerId,
    caller_id: callerId,
    session_id: sessionId,
    chunk_type: chunk?.chunk_type ?? "call_memory",
    content,
    source_text: chunk?.source_text ?? transcript ?? summary ?? null,
    facts: chunk?.facts ?? {},
    tags: chunk?.tags ?? [],
    language: chunk?.language ?? "en",
    symptoms: chunk?.symptoms ?? [],
    importance: chunk?.importance ?? 50,
  });

  if (error) {
    throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  const body = (await req.json()) as OrchestratorPayload;

  if (!serviceRoleKey) {
    return Response.json({ error: "Missing Supabase service role key" }, { status: 500, headers: corsHeaders });
  }

  const ownerId = body.owner_id ?? null;
  let callerId = null as string | null;
  let sessionId = body.session_id ?? null;

  if (body.phone_e164) {
    const callerQuery = ownerId
      ? admin.from("callers").select("id").eq("owner_id", ownerId).eq("phone_e164", body.phone_e164)
      : admin.from("callers").select("id").is("owner_id", null).eq("phone_e164", body.phone_e164);

    const { data: existingCaller, error: callerLookupError } = await callerQuery.maybeSingle();

    if (callerLookupError) {
      return Response.json({ error: callerLookupError.message }, { status: 400, headers: corsHeaders });
    }

    if (existingCaller?.id) {
      const { error: callerUpdateError } = await admin
        .from("callers")
        .update({ full_name: body.full_name ?? body.caller_name ?? null })
        .eq("id", existingCaller.id);

      if (callerUpdateError) {
        return Response.json({ error: callerUpdateError.message }, { status: 400, headers: corsHeaders });
      }

      callerId = existingCaller.id;
    } else {
      const { data: caller, error: callerInsertError } = await admin
        .from("callers")
        .insert({
          owner_id: ownerId,
          phone_e164: body.phone_e164,
          full_name: body.full_name ?? body.caller_name ?? null,
        })
        .select("id")
        .single();

      if (callerInsertError) {
        return Response.json({ error: callerInsertError.message }, { status: 400, headers: corsHeaders });
      }

      callerId = caller?.id ?? null;
    }
  }

  if (!sessionId) {
    const { data: session, error: sessionError } = await admin
      .from("call_sessions")
      .insert({
        owner_id: ownerId,
        caller_id: callerId,
        provider_name: body.provider_name ?? "custom",
        provider_call_id: body.provider_call_id ?? null,
        provider_session_id: body.provider_session_id ?? null,
        direction: body.direction ?? "outbound",
        status: "live",
        started_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        summary: body.summary ?? null,
        transcript: body.transcript ?? null,
        metadata: body.metadata ?? {},
      })
      .select("id")
      .single();

    if (sessionError) {
      return Response.json({ error: sessionError.message }, { status: 400, headers: corsHeaders });
    }

    sessionId = session.id;
  }

  const shouldPersistMemory = Boolean(body.memory_chunk?.content || body.summary || body.transcript);

  if (body.event_type) {
    const { error: eventError } = await admin.from("call_events").insert({
      session_id: sessionId,
      owner_id: ownerId,
      caller_id: callerId,
      event_type: body.event_type,
      payload: body.metadata ?? {},
    });

    if (eventError) {
      return Response.json({ error: eventError.message }, { status: 400, headers: corsHeaders });
    }
  }

  if (body.content) {
    const { error: turnError } = await admin.from("call_turns").insert({
      session_id: sessionId,
      owner_id: ownerId,
      caller_id: callerId,
      role: body.role ?? "user",
      content: body.content,
      metadata: body.metadata ?? {},
    });

    if (turnError) {
      return Response.json({ error: turnError.message }, { status: 400, headers: corsHeaders });
    }
  }

  if (shouldPersistMemory) {
    const { error: memoryError } = await persistMemoryChunk({
      sessionId,
      ownerId,
      callerId,
      chunk: body.memory_chunk,
      summary: body.summary,
      transcript: body.transcript,
    }).catch((error) => ({ error }));

    if (memoryError) {
      return Response.json({ error: memoryError.message ?? String(memoryError) }, { status: 400, headers: corsHeaders });
    }
  }

  const { data: settings } = await admin
    .from("agent_settings")
    .select("agent_name,system_prompt,anthropic_model")
    .eq("id", 1)
    .maybeSingle();

  return Response.json(
    {
      session_id: sessionId,
      caller_id: callerId,
      brain: {
        model: anthropicModel,
        system_prompt: settings?.system_prompt ?? "",
        api_key_configured: Boolean(anthropicApiKey),
      },
      voice: {
        provider: "sarvam",
        voice_id: sarvamVoiceId,
        api_key_configured: Boolean(sarvamApiKey),
      },
    },
    { headers: corsHeaders },
  );
});
