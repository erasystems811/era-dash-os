// Recognizing when a customer explicitly asks for a specific role, and
// handing off cleanly. Which roles a customer is even allowed to ask for is
// a per-business decision -- not every internal role should be
// customer-requestable -- so it's passed in as config, not hardcoded here.

export function requestableRoles(roles) {
  // roles: [{ key, label, requestable: true/false }] -- per-business config
  return roles.filter((r) => r.requestable);
}

export async function detectExplicitRoleRequest({ message, roles, askJson }) {
  const options = requestableRoles(roles);
  if (!options.length) return null;
  const labels = options.map((r) => r.label).join(', ');
  const result = await askJson(
    `Does this WhatsApp message explicitly ask to speak to one of these roles: ${labels}? Only match a clear, explicit request -- not a vague complaint or a passing mention. Reply ONLY with JSON: {"role_key": "..." or null}.`,
    message
  );
  const key = result?.role_key;
  return options.find((r) => r.key === key) || null;
}
