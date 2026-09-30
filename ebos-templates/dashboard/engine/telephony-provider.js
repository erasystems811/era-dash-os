// TelephonyProvider -- the abstraction the voice spec (section A2) calls
// for so a real phone call plugs into engine/voice.js's handleCallerUtterance
// without the rest of the engine caring which vendor is on the other end of
// the line. One implementation exists today (Twilio, chosen over Africa's
// Talking specifically because its Voice API is webhook+XML/record-then-
// process only -- no real-time bidirectional audio, which rules out live
// barge-in entirely; Twilio's Media Streams is pure pay-as-you-go, same
// "like normal credit" billing shape Chidera asked for, just from a
// different vendor). A second implementation is a matter of adding a file
// here and switching VOICE_TELEPHONY_PROVIDER -- nothing in
// voice-stream-bridge.js or engine/voice.js should ever import
// twilio-voice.js directly.
//
// Shape (per call):
//   answerTwiml({ streamUrl, voiceConfig }) -> XML string
//     Returns the markup to answer with when a call comes in -- for Twilio
//     this is <Connect><Stream>, handing the whole call over to streamUrl
//     for the rest of its lifetime.
//   transferCall(providerCallId, toNumber) -> Promise<void>
//     Live-transfers an in-progress call to a real staff number (A8,
//     Phase 2/gateway only -- Phase 1/forwarding has no real "transfer",
//     see handoff note in twilio-voice.js).
//   hangupCall(providerCallId) -> Promise<void>
//   capabilityFlags -> { realtimeAudio: boolean, bargeIn: boolean }
//     Read by voice-stream-bridge.js to decide whether to even attempt
//     barge-in (a future record-then-process provider would report
//     bargeIn: false and the bridge skips that logic entirely rather than
//     silently doing nothing).
import * as twilioVoice from './twilio-voice.js';

const PROVIDERS = {
  twilio: twilioVoice,
};

export function getTelephonyProvider() {
  const name = process.env.VOICE_TELEPHONY_PROVIDER || 'twilio';
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown VOICE_TELEPHONY_PROVIDER "${name}" -- no adapter registered for it.`);
  return provider;
}
