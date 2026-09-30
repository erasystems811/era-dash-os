// Deepgram streaming speech-to-text -- fed directly from Twilio's own
// mu-law/8000/mono frames (engine/voice-stream-bridge.js), no transcoding
// needed on this side since Deepgram accepts that encoding natively
// (encoding=mulaw, sample_rate=8000 below). Chosen over Google Cloud STT
// specifically for pure pay-as-you-go billing with no minimum spend --
// Chidera's "like using normal credit" requirement -- and because it's
// built for exactly this real-time voice-agent shape, not batch
// transcription repurposed for it.
import WebSocket from 'ws';

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

// `onTranscript({ transcript, confidence, isFinal })` fires for every
// result Deepgram sends, interim and final alike -- voice-stream-bridge.js
// decides what to do with an interim one (barge-in detection) versus a
// final one (feed handleCallerUtterance), this module doesn't filter.
export function openDeepgramStream({ onTranscript, onError }) {
  if (process.env.EBOS_SANDBOX === '1') {
    let closed = false;
    return {
      sandbox: true,
      sendAudio() {},
      close() {
        closed = true;
      },
      // Test-only hook (sandbox/test-voice-telephony-bridge.mjs) -- stands
      // in for a real recognized utterance the same way EBOS_SANDBOX
      // branches in whatsapp-send.js stand in for a real Meta send,
      // letting the bridge's own wiring be proven without a live Deepgram
      // account.
      simulateTranscript(transcript, confidence = 0.95, isFinal = true, speechFinal = true) {
        if (!closed) onTranscript({ transcript, confidence, isFinal, speechFinal });
      },
    };
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not set -- Voice speech recognition is not connected yet.');

  const url = `${DEEPGRAM_URL}?${new URLSearchParams({
    model: 'nova-3',
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    endpointing: '300',
  })}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type !== 'Results') return;
    const alt = msg.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;
    // `isFinal` means this chunk's text won't change -- `speechFinal` means
    // Deepgram detected an actual pause (endpointing, 300ms) and this is
    // where a full caller turn ends. voice-stream-bridge.js accumulates
    // isFinal text and only calls handleCallerUtterance once speechFinal
    // fires, same distinction Deepgram's own docs draw between the two.
    onTranscript({
      transcript: alt.transcript,
      confidence: alt.confidence ?? null,
      isFinal: Boolean(msg.is_final),
      speechFinal: Boolean(msg.speech_final),
    });
  });
  ws.on('error', (err) => onError?.(err));

  return {
    sandbox: false,
    sendAudio(mulawBuffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(mulawBuffer);
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        ws.close();
      }
    },
  };
}
