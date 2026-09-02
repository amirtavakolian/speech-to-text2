// Mic permission + device listing + recorded-blob -> 16kHz mono WAV base64.

export type MicDevice = { deviceId: string; label: string };

/** Ask permission once (labels are empty until granted), then list input devices. */
export async function listMics(): Promise<MicDevice[]> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop()); // only needed for the permission prompt
  return refreshMics();
}

/** Re-list mics (labels available once permission granted). */
export async function refreshMics(): Promise<MicDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
    }));
}

/** Open a recording stream on a specific mic. */
export async function openMic(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });
}

/**
 * Convert a recorded audio blob to base64 16kHz mono 16-bit PCM WAV.
 * WAV sidesteps browser codec differences (webm/opus vs mp4) — Gemini takes it as-is.
 * skipSeconds drops the leading audio (already transcribed) — only the remainder is encoded.
 * Returns the full decoded duration so callers can track what has been sent.
 */
export async function blobToWavBase64(
  blob: Blob,
  skipSeconds = 0
): Promise<{ base64: string; duration: number }> {
  const bytes = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    return { base64: encodeWavBase64(decoded, skipSeconds), duration: decoded.duration };
  } finally {
    void ctx.close();
  }
}

// ponytail: 16 kHz mono is fine for speech; bump sample rate if music matters.
function encodeWavBase64(buffer: AudioBuffer, skipSeconds: number): string {
  const TARGET_RATE = 16000;
  const skip = Math.min(Math.floor(skipSeconds * buffer.sampleRate), buffer.length);
  const channels = (
    buffer.numberOfChannels > 1 ? mixToMono(buffer) : buffer.getChannelData(0)
  ).subarray(skip);
  const ratio = buffer.sampleRate / TARGET_RATE;
  const outLen = Math.floor(channels.length / ratio);
  const samples = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // linear interpolation resample — adequate for speech
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s = idx + 1 < channels.length ? channels[idx] * (1 - frac) + channels[idx + 1] * frac : channels[idx];
    samples[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
  }
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }
  return uint8ToBase64(bytes);
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

function writeStr(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000; // avoid call-stack limits on large inputs
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
