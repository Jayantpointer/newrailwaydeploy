const streamUrl = Deno.env.get("TWILIO_STREAM_URL") ?? "";

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id") ?? "";
  const ownerId = url.searchParams.get("owner_id") ?? "";
  const callerId = url.searchParams.get("caller_id") ?? "";
  const phoneE164 = url.searchParams.get("phone_e164") ?? "";
  const fullName = url.searchParams.get("full_name") ?? "";
  const targetStream = streamUrl || url.searchParams.get("stream_url") || "";

  if (!targetStream) {
    return new Response("Missing TWILIO_STREAM_URL", { status: 500 });
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(targetStream)}">
      <Parameter name="session_id" value="${xmlEscape(sessionId)}" />
      <Parameter name="owner_id" value="${xmlEscape(ownerId)}" />
      <Parameter name="caller_id" value="${xmlEscape(callerId)}" />
      <Parameter name="phone_e164" value="${xmlEscape(phoneE164)}" />
      <Parameter name="full_name" value="${xmlEscape(fullName)}" />
    </Stream>
  </Connect>
</Response>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
});
