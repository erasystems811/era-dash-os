// erasystems.com.ng's DNS is hosted on a DirectAdmin server behind Go54's
// panel (confirmed live 2026-07-31: https://<DA_HOST>/CMD_API_DNS_CONTROL,
// HTTP Basic auth using a DirectAdmin "Login Key" — Account menu > Login
// Keys — scoped to CMD_API_DNS_CONTROL only and locked to the control
// server's IP). DA_USERNAME/DA_LOGIN_KEY/DA_HOST live in secrets.env.

function authHeader(username, loginKey) {
  return { Authorization: `Basic ${Buffer.from(`${username}:${loginKey}`).toString('base64')}` };
}

// name: the subdomain host part only, e.g. "client-name" (not the full FQDN)
// ttl defaults to 3600 (DirectAdmin's own default) -- a hostname that might
// ever need a fast DNS-based failover (scripts/failover-standby.mjs) should
// pass a short one instead, since a cached resolver won't see a change
// until its copy of the OLD ttl expires, however fast the record itself
// updates.
export async function addARecord({ host, username, loginKey }, domain, name, ip, ttl = 3600) {
  const url = `https://${host}/CMD_API_DNS_CONTROL?domain=${encodeURIComponent(domain)}&action=add&type=A&name=${encodeURIComponent(name)}&value=${encodeURIComponent(ip)}&ttl=${ttl}&json=yes`;
  const res = await fetch(url, { headers: authHeader(username, loginKey) });
  const text = await res.text();
  if (!res.ok) throw new Error(`DirectAdmin add DNS record failed: ${res.status} ${text}`);
  const data = JSON.parse(text);
  if (data.error && Number(data.error) !== 0) throw new Error(`DirectAdmin add DNS record failed: ${data.details || text}`);
  return data;
}

// DirectAdmin deletes by "select"-ing records via arecs0=name=X&value=Y
// (URL-encoded as one param), not by passing name/value directly — verified
// live 2026-07-31 against a throwaway record.
export async function deleteARecord({ host, username, loginKey }, domain, name, ip) {
  const combined = `name=${name}&value=${ip}`;
  const url = `https://${host}/CMD_API_DNS_CONTROL?domain=${encodeURIComponent(domain)}&type=A&arecs0=${encodeURIComponent(combined)}&action=select&json=yes`;
  const res = await fetch(url, { headers: authHeader(username, loginKey) });
  const text = await res.text();
  if (!res.ok && res.status !== 404) throw new Error(`DirectAdmin delete DNS record failed: ${res.status} ${text}`);
}

export function manualInstructions(domain, name, ip) {
  return [
    `Automatic DNS setup didn't go through — add this manually (da17.host-ww.net:2222 > DNS Management, or Go54's DNS panel) for ${domain}:`,
    `  Type: A`,
    `  Name/Host: ${name}`,
    `  Points to: ${ip}`,
    `  TTL: 3600 (or default)`,
  ].join('\n');
}

// For a business's own domain — DNS lives on whatever registrar/host they
// use, never automatable from here. This is always what to hand the client,
// not a fallback for when automation failed.
export function customDomainInstructions(hostname, ip) {
  return [
    `"${hostname}" is not on the erasystems.com.ng DNS account, so this step is always manual — give this to whoever manages that domain's DNS:`,
    `  Type: A`,
    `  Name/Host: ${hostname.split('.').length > 2 ? hostname.split('.')[0] : '@'} (or the full host "${hostname}", depending on their DNS panel)`,
    `  Points to: ${ip}`,
    `  TTL: 3600 (or default)`,
    `The app won't be reachable at https://${hostname} and TLS won't issue until that record resolves.`,
  ].join('\n');
}
