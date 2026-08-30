// One place a bot's stages and allowed moves get defined. Every other part
// of the bot asks this module "is this move allowed?" instead of each file
// re-guessing on its own with a fresh if/else chain on a status string.

export function defineStates(transitions) {
  // transitions: { stateName: [allowedNextState, ...], ... }
  const states = Object.keys(transitions);

  function isValidState(state) {
    return states.includes(state);
  }

  function canTransition(from, to) {
    if (!isValidState(from)) throw new Error(`Unknown state "${from}" -- not defined in this bot's state map.`);
    if (!isValidState(to)) throw new Error(`Unknown state "${to}" -- not defined in this bot's state map.`);
    return (transitions[from] || []).includes(to);
  }

  function assertTransition(from, to) {
    if (!canTransition(from, to)) {
      throw new Error(
        `Blocked: "${from}" -> "${to}" is not an allowed move. Allowed from "${from}": ${(transitions[from] || []).join(', ') || '(none)'}`
      );
    }
    return to;
  }

  return { states, isValidState, canTransition, assertTransition };
}
