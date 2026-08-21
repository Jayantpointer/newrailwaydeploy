import { createClient } from "npm:@supabase/supabase-js@2";

type StartCallPayload = {
  to: string;
  owner_id?: string;
  caller_id?: string;
  session_id?: string;
  full_name?: string;
  voice_webhook_url?: string;
  provider_call_id?: string;
  metadata?: Record<string, unknown>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";
const twilioAccountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const twilioFromNumber = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
const twilioVoiceWebhookUrl = Deno.env.get("TWILIO_VOICE_WEBHOOK_URL") ?? "";
const twilioStatusCallbackUrl = Deno.env.get("TWILIO_STATUS_CALLBACK_URL") ?? "";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function basicAuthHeader(accountSid: string, authToken: string) {
  return `Basic ${btoa(`${accountSid}:${authToken}`)}`;
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
    }

    if (!serviceRoleKey) {
      return Response.json({ error: "Missing Supabase service role key" }, { status: 500, headers: corsHeaders });
    }

    if (!twilioAccountSid || !twilioAuthToken || !twilioFromNumber || !twilioVoiceWebhookUrl || !twilioStatusCallbackUrl) {
      return Response.json(
        { error: "Missing Twilio env vars" },
        { status: 500, headers: corsHeaders },
      );
    }

    const body = (await req.json()) as StartCallPayload;

    if (!body.to) {
      return Response.json({ error: "Missing destination number" }, { status: 400, headers: corsHeaders });
    }

    let sessionId = body.session_id ?? null;

    if (!sessionId) {
      const { data: session, error: sessionError } = await admin
        .from("call_sessions")
        .insert({
          owner_id: body.owner_id ?? null,
          caller_id: body.caller_id ?? null,
          provider_name: "twilio",
          direction: "outbound",
          status: "queued",
          metadata: body.metadata ?? {},
        })
        .select("id")
        .single();

      if (sessionError) {
        return Response.json({ error: sessionError.message }, { status: 400, headers: corsHeaders });
      }

      sessionId = session.id;
    }

    const webhookUrl = new URL(body.voice_webhook_url ?? twilioVoiceWebhookUrl);
    webhookUrl.searchParams.set("session_id", sessionId);
    if (body.owner_id) webhookUrl.searchParams.set("owner_id", body.owner_id);

    const statusCallbackUrl = new URL(twilioStatusCallbackUrl);
    statusCallbackUrl.searchParams.set("session_id", sessionId);
    if (body.owner_id) statusCallbackUrl.searchParams.set("owner_id", body.owner_id);

    const form = new URLSearchParams();
    form.set("To", body.to);
    form.set("From", twilioFromNumber);
    form.set("Url", webhookUrl.toString());
    form.set("Method", "POST");
    form.set("StatusCallback", statusCallbackUrl.toString());
    form.set("StatusCallbackMethod", "POST");
    form.set("StatusCallbackEvent", "initiated ringing answered completed");

    const twilioResponse = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: basicAuthHeader(twilioAccountSid, twilioAuthToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
    );

    const raw = await twilioResponse.text();
    let payload: any = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }

    if (!twilioResponse.ok) {
      return Response.json(
        { error: payload?.message ?? payload?.raw ?? "Twilio call creation failed", details: payload },
        { status: twilioResponse.status, headers: corsHeaders },
      );
    }

    const { error: updateError } = await admin
      .from("call_sessions")
      .update({
        provider_call_id: payload.sid ?? body.provider_call_id ?? null,
        status: "ringing",
        started_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        metadata: {
          ...(body.metadata ?? {}),
          twilio: payload,
        },
      })
      .eq("id", sessionId);

    if (updateError) {
      return Response.json({ error: updateError.message }, { status: 400, headers: corsHeaders });
    }

    return Response.json(
      {
        session_id: sessionId,
        twilio_call_sid: payload.sid,
        status: payload.status,
        to: body.to,
        from: twilioFromNumber,
        voice_webhook_url: webhookUrl.toString(),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders },
    );
  }
});
