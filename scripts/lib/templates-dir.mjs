import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 'default' is the generic single-client starter (templates/). Any other
// name (e.g. 'ebos') reads from a sibling '<name>-templates/' folder instead
// -- same pipeline, different schema.sql/dashboard baked onto the server.
// Shared by create-client.mjs and push-update.mjs so the two can never
// disagree about which folder a given template name maps to.
export function templatesDirFor(template) {
  const folder = template === 'default' ? 'templates' : `${template}-templates`;
  return path.join(__dirname, '..', '..', folder);
}
