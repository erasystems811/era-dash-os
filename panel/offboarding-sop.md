# Offboarding a business — standard steps

Follow in order. Steps 1–2 are one click each in this panel. Steps 3–5 happen on Meta's own site, by hand — nothing here can do them for you.

1. **Click "Begin offboarding" for this business.** This downloads their complete data (every customer, message, order, menu item) to a file, and marks the business offboarded. **Nothing is deleted. Their server and bot keep running exactly as before.**
2. **Hand the exported file to the business owner.** It's theirs — every conversation and order they ever had.
3. **Go to Meta Business Manager → WhatsApp Manager → Phone numbers**, find this business's number.
4. **Migrate the number to the business's own WhatsApp Business Account** (Meta supports this directly — look for a migrate/transfer option on the number, or start from the business's own Embedded Signup if they're setting up their own WABA to receive it). This is the one part Meta requires to be manual — there is no API for it.
5. Confirm with the business that the number now works under their own account (a fresh sign-in on the WhatsApp Business app, or their own tech setup).
6. **Only now, separately, decide whether to tear down the server.** Offboarding does not do this automatically — it's a distinct, later decision. When ready: `node teardown-client.mjs --client=<name>` from the control server. This permanently deletes the server — only run it once steps 1–5 are actually done.
