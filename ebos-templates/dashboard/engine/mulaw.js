// G.711 mu-law <-> linear PCM16, the one audio-codec detail the voice
// pipeline needs: Twilio Media Streams only accepts/sends 8kHz mono
// mu-law (engine/voice-stream-bridge.js's own comment has the full wire
// protocol), but Fish Audio's TTS only emits linear PCM16 -- never mu-law
// directly (checked against its own docs; "pcm" there means signed 16-bit
// linear, not G.711). Uses the `alawmulaw` package rather than a hand-rolled
// bit-shift table: this is exactly the kind of code where a one-bit mistake
// is inaudible in a code review and only shows up as garbled live audio.
import alawmulaw from 'alawmulaw';

// Twilio's own recommended outbound chunk size -- 20ms of 8kHz 8-bit mono
// audio is 160 bytes. Sending larger or smaller chunks still works, but
// 160 bytes/frame is what Twilio's reference examples use and keeps
// playback smooth without the receiving end needing to do its own
// re-buffering.
export const MULAW_FRAME_BYTES = 160;

// `pcm16` is a Buffer of signed 16-bit little-endian samples (what Fish
// Audio's format: 'pcm' returns). Returns a Buffer of mu-law bytes, half
// the length.
export function pcm16ToMulaw(pcm16) {
  const sampleCount = Math.floor(pcm16.length / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = pcm16.readInt16LE(i * 2);
  }
  return Buffer.from(alawmulaw.mulaw.encode(samples));
}

// Splits a mu-law Buffer into MULAW_FRAME_BYTES-sized chunks for sending
// to Twilio one `media` event at a time -- generator so the bridge can
// pace sends (see voice-stream-bridge.js) instead of dumping a whole
// reply's audio into Twilio's receive buffer at once.
export function* mulawFrames(mulawBuffer, frameBytes = MULAW_FRAME_BYTES) {
  for (let offset = 0; offset < mulawBuffer.length; offset += frameBytes) {
    yield mulawBuffer.subarray(offset, offset + frameBytes);
  }
}
