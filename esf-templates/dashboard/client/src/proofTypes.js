// Field metadata for the step builder's dynamic "answer format" panel --
// mirrors ../../routes/tasks.js's PROOF_CONFIG_FIELDS exactly (same
// flat-copy convention as bot-engine/lib.js, google-auth.js elsewhere in
// this template: client and server can't share a live import across the
// Vite/Node boundary, so keep both in sync by hand if a proof type's
// fields change). The server is the source of truth for what's actually
// accepted -- this only drives what the form shows.

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
