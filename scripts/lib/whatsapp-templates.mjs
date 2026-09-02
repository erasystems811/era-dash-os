// Template creation is a per-WABA operation (each EBOS business gets its own
// WABA -- confirmed while wiring up ebos_admin_alert this session, where the
// first attempt landed on the wrong shared WABA). This helper is called once
// per business, from add-whatsapp.mjs, the moment that business's own WABA
// credentials are known.

// Meta rejects a template whose body ends in a bare variable ("Leading or
// trailing params not allowed") -- hit this directly building
// ebos_admin_alert. Every template built here keeps real static text after
// the last {{n}}.
export async function createOutreachTemplate({ accessToken, wabaId, businessName }) {
  const res = await fetch(`https://graph.facebook.com/v23.0/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'business_outreach',
      language: 'en_US',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: `Hello, reaching out from ${businessName}. {{1}}\n\nReply anytime to continue the conversation.`,
          example: { body_text: [['we have an update on your recent order']] },
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`business_outreach template creation failed: ${JSON.stringify(json)}`);
  return json; // { id, status: 'PENDING', category }
}
