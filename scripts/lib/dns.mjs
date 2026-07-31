// Go54 (formerly WhoGoHost) manages DNS for erasystems.com.ng and confirms in
// its docs that its API can "configure DNS records for your domains" — but
// the exact base URL / auth header / record-endpoint shape wasn't fully
// readable from the public docs site (JS-rendered) as of writing this.
//
// NEEDS VERIFICATION the first time this actually runs with a real
// GO54_API_KEY: confirm base URL + auth header format against
// https://api-docs.go54.com (the "Authorization" and "API Structure" pages)
// or the account's API dashboard, and adjust addARecord()/deleteARecord()
// below to match. Everything that calls this module already treats a
// failure here as non-fatal and falls back to printing manual instructions,
// so a wrong guess here doesn't block the rest of setup.

const API_BASE = process.env.GO54_API_BASE || 'https://api.go54.com/v1';

function headers(go54ApiKey) {
  return {
    Authorization: `Bearer ${go54ApiKey}`,
    'Content-Type': 'application/json',
  };
}

// domain: the zone, e.g. "erasystems.com.ng"
// name: the subdomain host part only, e.g. "client-name" (not the full FQDN)
export async function addARecord(go54ApiKey, domain, name, ip) {
  const res = await fetch(`${API_BASE}/domains/${domain}/dns-records`, {
    method: 'POST',
    headers: headers(go54ApiKey),
    body: JSON.stringify({ type: 'A', name, content: ip, ttl: 3600 }),
  });
  if (!res.ok) throw new Error(`Go54 add DNS record failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function deleteARecord(go54ApiKey, domain, recordId) {
  const res = await fetch(`${API_BASE}/domains/${domain}/dns-records/${recordId}`, {
    method: 'DELETE',
    headers: headers(go54ApiKey),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Go54 delete DNS record failed: ${res.status} ${await res.text()}`);
}

export function manualInstructions(domain, name, ip) {
  return [
    `Automatic DNS setup didn't go through — add this manually in the Go54/WhoGoHost DNS panel for ${domain}:`,
    `  Type: A`,
    `  Name/Host: ${name}`,
    `  Points to: ${ip}`,
    `  TTL: 3600 (or default)`,
  ].join('\n');
}
