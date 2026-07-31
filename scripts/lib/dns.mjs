// erasystems.com.ng's DNS is hosted on a DirectAdmin server behind Go54's
// panel (confirmed live 2026-07-31: https://<DA_HOST>/CMD_API_DNS_CONTROL,
// HTTP Basic auth using a DirectAdmin "Login Key" — Account menu > Login
// Keys — scoped to CMD_API_DNS_CONTROL only and locked to the control
// server's IP). DA_USERNAME/DA_LOGIN_KEY/DA_HOST live in secrets.env.

function authHeader(username, loginKey) {
  return { Authorization: `Basic ${Buffer.from(`${username}:${loginKey}`).toString('base64')}` };
}

// name: the subdomain host part only, e.g. "client-name" (not the full FQDN)
export async function addARecord({ host, username, loginKey }, domain, name, ip) {
  const url = `https://${host}/CMD_API_DNS_CONTROL?domain=${encodeURIComponent(domain)}&action=add&type=A&name=${encodeURIComponent(name)}&value=${encodeURIComponent(ip)}&ttl=3600&json=yes`;
  const res = await fetch(url, { headers: authHeader(username, loginKey) });
  const text = await res.text();
  if (!res.ok) throw new Error(`DirectAdmin add DNS record failed: ${res.status} ${text}`);
  const data = JSON.parse(text);
  if (data.error && Number(data.error) !== 0) throw new Error(`DirectAdmin add DNS record failed: ${data.details || text}`);
  return data;
}

export async function deleteARecord({ host, username, loginKey }, domain, name, ip) {
  const url = `https://${host}/CMD_API_DNS_CONTROL?domain=${encodeURIComponent(domain)}&action=select&type=A&name=${encodeURIComponent(name)}&value=${encodeURIComponent(ip)}&json=yes`;
  const res = await fetch(url, { headers: authHeader(username, loginKey) });
  if (!res.ok && res.status !== 404) throw new Error(`DirectAdmin delete DNS record failed: ${res.status} ${await res.text()}`);
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
