// Flat copy of esf-templates/dashboard/client/src/proofTypes.js -- same
// flat-copy convention used everywhere else in this repo (client/server
// can't share a live import across the Vite/Node boundary). Keep in sync
// by hand if a proof type's fields change.

export const PROOF_TYPES = ['tap', 'photo', 'location', 'number', 'text', 'choice', 'code', 'api', 'countersign'];

export const PROOF_TYPE_LABELS = {
  tap: 'Tap',
  photo: 'Photo',
  location: 'Location',
  number: 'Number',
  text: 'Text',
  choice: 'Choice',
  code: 'Code',
  api: 'API check',
  countersign: 'Countersign',
};

export const PROOF_CONFIG_FIELDS = {
  tap: [],
  photo: [
    { name: 'min', label: 'Minimum photos', type: 'number', default: 1 },
    { name: 'max', label: 'Maximum photos', type: 'number' },
  ],
  location: [{ name: 'radius_m', label: 'Radius (meters) -- blank uses the business default', type: 'number' }],
  number: [
    { name: 'label', label: 'What is this a count of (e.g. "Cash counted")', type: 'text' },
    { name: 'min', label: 'Minimum value', type: 'number' },
    { name: 'max', label: 'Maximum value', type: 'number' },
  ],
  text: [{ name: 'min_length', label: 'Minimum length', type: 'number', default: 1 }],
  choice: [{ name: 'options', label: 'Options, one per line', type: 'textarea' }],
  code: [{ name: 'source', label: 'Who holds the code (e.g. "otp", "receptionist")', type: 'text' }],
  api: [
    { name: 'url', label: 'Verification URL (use {{value}} for what she enters)', type: 'text' },
    { name: 'method', label: 'Method', type: 'select', options: ['GET', 'POST'] },
    { name: 'headers', label: 'Headers, one per line as Name: value (use {{secret.ENV_VAR_NAME}} for a secret)', type: 'textarea' },
    { name: 'success_path', label: 'Field in the response that means success (e.g. status)', type: 'text' },
    { name: 'success_value', label: 'What that field must equal (e.g. success)', type: 'text' },
    { name: 'on_fail', label: 'If it fails to verify', type: 'select', options: ['reject', 'flag'] },
  ],
  countersign: [{ name: 'role', label: 'Which role must confirm', type: 'text' }],
};

export const DAY_CODES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// Flat copy of routes/tasks.js's buildProofConfig -- turns the raw string
// field values the step form collects into the normalized JSON esf-seed.mjs
// writes straight into proof_config, same as a live PATCH would.
export function buildProofConfig(proofType, rawConfig = {}) {
  const fields = PROOF_CONFIG_FIELDS[proofType] || [];
  const config = {};
  for (const f of fields) {
    const raw = rawConfig[f.name];
    if (raw === undefined || raw === null || raw === '') continue;
    if (f.name === 'options') config.options = String(raw).split('\n').map((s) => s.trim()).filter(Boolean);
    else if (f.name === 'headers') {
      const headers = {};
      for (const line of String(raw).split('\n')) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      config.headers = headers;
    } else if (f.type === 'number') config[f.name] = Number(raw);
    else config[f.name] = raw;
  }
  return config;
}
