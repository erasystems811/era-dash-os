// Self-contained (not imported from era-dash-os/scripts/lib) because this
// app deploys standalone onto the EBOS server, separate from the control
// server the scripts run on.
import { randomBytes } from 'node:crypto';

export function randomPassword(bytes = 12) {
  return randomBytes(bytes).toString('base64url');
}
