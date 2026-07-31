export function patchEnv(text, updates) {
  const lines = text.split('\n');
  const seen = new Set();
  const patched = lines.map((line) => {
    const eq = line.indexOf('=');
    if (eq === -1) return line;
    const key = line.slice(0, eq).trim();
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) patched.push(`${key}=${value}`);
  }
  return patched.join('\n');
}
