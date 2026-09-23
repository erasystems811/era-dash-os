// Chidera, 2026-09-23: "you can remove oracle i said i dint need it there"
// / "same with hetzner and ovh" / (DigitalOcean's own stored token also
// failed a live auth test the same day) -- every automated cloud-provider
// integration in this codebase (oracle.mjs, hetzner.mjs, ovh.mjs,
// digitalocean.mjs) is gone. Going forward a server is created by hand
// (whatever console/provider Chidera actually wants that day, including
// Claude driving it directly through her already-logged-in browser) and
// handed to create-client.mjs as a plain --ip=. This module is what makes
// THAT box usable regardless of which provider it came from or how it was
// made -- it doesn't assume a provider's own cloud-init ever ran.
//
// Actively runs the install over SSH and waits for it to finish, rather
// than the old pattern (wait for a provider's own cloud-init to eventually
// drop a marker file) -- a manually created box has no guarantee ANY
// cloud-init script was ever attached, so this has to be the thing that
// makes Docker exist, not just check for it.
import { runRemote, waitForSsh } from './ssh.mjs';

// The root-login fix and the local iptables rules below are specifically
// an Oracle stock-image quirk (see the old oracle.mjs's own comment for
// the full story of why they were needed there) -- kept here, defensively
// wrapped with `|| true`, because they're harmless no-ops on a provider
// that doesn't need them (Hetzner/DigitalOcean/a plain Ubuntu box already
// allow root and don't locally firewall 80/443) and this module no longer
// knows or cares which provider a given box came from.
const PROVISION_SCRIPT = `#!/bin/bash
set -e
if [ -f /home/ubuntu/.ssh/authorized_keys ] && [ ! -s /root/.ssh/authorized_keys ]; then
  mkdir -p /root/.ssh
  cp /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
fi
(iptables -I INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT && \\
 iptables -I INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT && \\
 (netfilter-persistent save || (mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4))) || true
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \\"\\$VERSION_CODENAME\\") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
mkdir -p /opt
touch /opt/cloud-init-done
`;

// Idempotent -- safe to call again on a box this already ran on (the
// docker install is skipped via `command -v docker`, everything else is
// naturally re-runnable). That matters because create-client.mjs's own
// --shared-server=ip join mode calls this too, every time a new tenant
// joins an existing shared box, not just once at creation.
export async function provisionExistingServer(ip) {
  await waitForSsh(ip);
  await runRemote(ip, `cat > /tmp/era-provision.sh << 'PROVISION_EOF'\n${PROVISION_SCRIPT}\nPROVISION_EOF\nchmod +x /tmp/era-provision.sh && /tmp/era-provision.sh && rm -f /tmp/era-provision.sh`);
}
