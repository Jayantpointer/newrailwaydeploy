import { createClient } from "npm:@supabase/supabase-js@2";

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

function mapTwilioStatus(status: string) {
  switch ((status || "").toLowerCase()) {
    case "initiated":
    case "ringing":
      return "ringing";
    case "in-progress":
    case "answered":
      return "live";
    case "completed":
      return "completed";
    case "canceled":
      return "cancelled";
    case "busy":
    case "no-answer":
    case "failed":
    default:
      return "failed";
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (req.method !== "POST" && req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
    }

    if (!serviceRoleKey) {
      return Response.json({ error: "Missing Supabase service role key" }, { status: 500, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const bodyText = req.method === "POST" ? await req.text() : url.searchParams.toString();
    const form = new URLSearchParams(bodyText);

    const sessionId = url.searchParams.get("session_id") ?? form.get("session_id") ?? "";
    const ownerId = url.searchParams.get("owner_id") ?? form.get("owner_id") ?? null;
    const callSid = form.get("CallSid") ?? form.get("call_sid") ?? "";
    const callStatus = form.get("CallStatus") ?? form.get("call_status") ?? "";
    const callDuration = form.get("CallDuration") ?? form.get("call_duration") ?? null;

    const sessionQuery = sessionId
      ? admin.from("call_sessions").select("id, owner_id, caller_id, provider_call_id, metadata").eq("id", sessionId)
      : admin.from("call_sessions").select("id, owner_id, caller_id, provider_call_id, metadata").eq("provider_name", "twilio").eq("provider_call_id", callSid);

    const { data: session, error: lookupError } = await sessionQuery.maybeSingle();
    if (lookupError) {
      return Response.json({ error: lookupError.message }, { status: 400, headers: corsHeaders });
    }

    if (!session) {
      return Response.json({ ok: true, matched: false }, { headers: corsHeaders });
    }

    const mappedStatus = mapTwilioStatus(callStatus);
    const terminal = mappedStatus === "completed" || mappedStatus === "failed" || mappedStatus === "cancelled";

    const { error: updateError } = await admin
      .from("call_sessions")
      .update({
        status: mappedStatus,
        ended_at: terminal ? new Date().toISOString() : null,
        last_activity_at: new Date().toISOString(),
        provider_call_id: callSid || session.provider_call_id || null,
        metadata: {
          ...(session.metadata ?? {}),
          twilio: {
            call_sid: callSid || null,
            call_status: callStatus || null,
            call_duration: callDuration,
          },
        },
      })
      .eq("id", session.id);

    if (updateError) {
      return Response.json({ error: updateError.message }, { status: 400, headers: corsHeaders });
    }

    await admin.from("call_events").insert({
      session_id: session.id,
      owner_id: session.owner_id ?? ownerId,
      caller_id: session.caller_id ?? null,
      event_type: "twilio.call_status",
      payload: {
        call_sid: callSid || null,
        call_status: callStatus || null,
        mapped_status: mappedStatus,
        call_duration: callDuration,
      },
    });

    return Response.json({ ok: true, session_id: session.id, status: mappedStatus }, { headers: corsHeaders });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders },
    );
  }
});
