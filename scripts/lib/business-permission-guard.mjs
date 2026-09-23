// Chidera, 2026-09-23, right after the live pomodoro/dee incident: "nobody
// should just push to a business without my permission, you can always
// push to sandbox and era-demo but the rest should be manual". A hard
// gate, not a memory note that a future session could forget -- any client
// that isn't a sandbox and isn't era-demo (her own always-trusted test/demo
// businesses) requires an explicit --confirmed flag on the command itself.
// Deliberately named after HER, not a generic "--force" -- typing
// --confirmed is meant to be the moment of "yes, Chidera actually said go
// ahead on this specific real business", not a habit to reach for.
//
// This is defense in depth, not a replacement for actually asking her in
// chat first -- see the standing feedback memory this fix was saved
// alongside. A determined session could still pass --confirmed without
// really having asked; this only stops an ACCIDENTAL sweep (a bulk
// --all-ebos, a copy-pasted command meant for era-demo that silently
// included others), the same class of mistake that caused the original
// incident.
const ALWAYS_TRUSTED_NAMES = new Set(['era-demo']);

export function requireBusinessPermission(targets, confirmed) {
  const needsPermission = targets.filter((c) => !c.sandbox && !ALWAYS_TRUSTED_NAMES.has(c.name));
  if (needsPermission.length === 0) return;
  if (confirmed) return;
  throw new Error(
    `Refusing -- ${needsPermission.map((c) => c.name).join(', ')} ${needsPermission.length === 1 ? 'is a real business' : 'are real businesses'} outside sandbox/era-demo. ` +
      `Chidera's explicit rule, 2026-09-23: nothing pushes/migrates there without her say-so. ` +
      `Ask her in chat first. Once she's said yes, re-run with --confirmed.`
  );
}
