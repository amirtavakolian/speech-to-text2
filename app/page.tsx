"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { blobToWavBase64, listMics, openMic, refreshMics, type MicDevice } from "@/lib/audio";
const LANGUAGES = [
  "English",
  "Persian (فارسی)",
  "Arabic (العربية)",
  "Turkish (Türkçe)",
  "Spanish (Español)",
  "French (Français)",
  "German (Deutsch)",
  "Russian (Русский)",
  "Chinese (中文)",
  "Japanese (日本語)",
  "Hindi (हिन्दी)",
  "Hebrew (עברית)",
];
// recognition language tags for the browser engine (Gemini gets the display name in its prompt)
const LANG_TAGS: Record<string, string> = {
  English: "en-US",
  "Persian (فارسی)": "fa-IR",
  "Arabic (العربية)": "ar-SA",
  "Turkish (Türkçe)": "tr-TR",
  "Spanish (Español)": "es-ES",
  "French (Français)": "fr-FR",
  "German (Deutsch)": "de-DE",
  "Russian (Русский)": "ru-RU",
  "Chinese (中文)": "zh-CN",
  "Japanese (日本語)": "ja-JP",
  "Hindi (हिन्दी)": "hi-IN",
  "Hebrew (עברית)": "he-IL",
};
const getSpeechRecognition = (): any =>
  typeof window !== "undefined" &&
  ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

type Phase = "idle" | "recording" | "transcribing";
type Engine = "gemini" | "browser";

export default function Home() {
  const [mics, setMics] = useState<MicDevice[]>([]);
  const [micId, setMicId] = useState("");
  const [language, setLanguage] = useState(LANGUAGES[0]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [partialMsg, setPartialMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"untested" | "testing" | "valid" | "invalid">("untested");
  const [engine, setEngine] = useState<Engine>("gemini"); // set to browser in an effect to avoid SSR hydration mismatch
  // default to the free browser engine where it exists
  useEffect(() => {
    if (getSpeechRecognition()) setEngine("browser");
  }, []);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sentSecondsRef = useRef(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const lastAudioRef = useRef<string>(""); // unsent-segment WAV from the last send, for retry
  const recognitionRef = useRef<any>(null);
  const finalTextRef = useRef(""); // browser engine: committed text, kept separate from in-flight partial
  const phaseRef = useRef<Phase>("idle"); // phase mirror — recognition callbacks capture stale state

  const enableMics = useCallback(async () => {
    setError("");
    try {
      const devices = await listMics();
      setMics(devices);
      setMicId((prev) => prev || devices[0]?.deviceId || "");
    } catch {
      setError("Microphone permission denied — allow mic access and try again.");
    }
  }, []);

  // editing the key invalidates the previous test result
  useEffect(() => setKeyStatus("untested"), [apiKey]);

  const testKey = async (key: string) => {
    setKeyStatus("testing");
    setError("");
    try {
      const res = await fetch("/api/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      setKeyStatus(res.ok ? "valid" : "invalid");
      if (res.ok) {
        localStorage.setItem("gemini-api-key", key.trim()); // remember validated keys
      } else {
        localStorage.removeItem("gemini-api-key"); // drop stale ones
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Key check failed.");
      }
    } catch {
      setKeyStatus("invalid");
      setError("Could not reach the key check endpoint.");
    }
  };

  // restore a previously validated key and re-verify it once on load
  useEffect(() => {
    const stored = localStorage.getItem("gemini-api-key");
    if (stored) {
      setApiKey(stored);
      void testKey(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // re-list when devices are plugged/unplugged
  useEffect(() => {
    const onChange = async () => {
      if (mics.length > 0) {
        const devices = await refreshMics();
        setMics(devices);
      }
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [mics.length]);

  // Transcribe one segment (audio from sentSeconds onward), append its text in order.
  // All sends go through chainRef so segments land in the transcript in spoken order,
  // regardless of which Gemini call finishes first.
  const sendSegment = useCallback(
    async (opts?: { final?: boolean }) => {
      if (chunksRef.current.length === 0) return;
      const blob = new Blob(chunksRef.current, { type: recorderRef.current?.mimeType });
      if (blob.size === 0) return;
      const run = async () => {
        const from = sentSecondsRef.current;
        if (opts?.final) {
          setPhase("transcribing");
          setPartialMsg("");
        } else {
          setPartialMsg(from === 0 ? "First 30s transcribing…" : `Transcribing ${from}–${from + 30}s…`);
        }
        let b64 = "";
        try {
          const { base64, duration } = await blobToWavBase64(blob, from);
          if (duration - from < 0.5) return; // nothing new to send
          b64 = base64;
          sentSecondsRef.current = duration;
          const res = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audioBase64: base64, apiKey, language }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
          setTranscript((t) => (t ? `${t} ${data.transcript}` : data.transcript));
          if (opts?.final) chunksRef.current = []; // transcription done — raw audio freed
        } catch (e) {
          sentSecondsRef.current = from; // roll back — the next send re-includes this span
          const message = e instanceof Error ? e.message : "Transcription failed.";
          if (opts?.final) {
            lastAudioRef.current = b64;
            setRetryable(Boolean(b64)); // no Retry button if even the WAV encode failed
            setError(message);
          }
          // partials fail silent — rollback makes the next 30s send self-heal them
        } finally {
          if (!opts?.final) setPartialMsg("");
          if (opts?.final) setPhase("idle");
        }
      };
      const p = chainRef.current.then(run, run);
      chainRef.current = p.catch(() => {});
      await p;
    },
    [language, apiKey]
  );

  // elapsed-time ticker while recording; every 30 ticks quietly sends the unsent segment
  useEffect(() => {
    if (phase === "recording") {
      let ticks = 0;
      timerRef.current = setInterval(() => {
        ticks++;
        setElapsed(ticks);
        if (engine === "gemini" && ticks % 30 === 0) void sendSegment();
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase, sendSegment, engine]);

  const startBrowserRecording = () => {
    setError("");
    setTranscript("");
    setRetryable(false);
    finalTextRef.current = "";
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setError("This browser has no built-in speech recognition — use Chrome/Edge or the Gemini engine.");
      return;
    }
    const rec = new Recognition();
    rec.lang = LANG_TAGS[language] ?? "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalTextRef.current += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      setTranscript((finalTextRef.current + interim).trim());
    };
    rec.onerror = (e: any) => {
      if (e.error === "not-allowed") setError("Microphone permission denied — allow mic access and try again.");
      else if (e.error !== "aborted") setError(`Speech recognition error: ${e.error}`);
    };
    // Chrome auto-stops after silence — restart to keep a long recording alive
    rec.onend = () => {
      if (recognitionRef.current && phaseRef.current === "recording") rec.start();
    };
    rec.start();
    recognitionRef.current = rec;
    setElapsed(0);
    setPhase("recording");
  };

  const stopBrowserRecording = () => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    rec?.stop();
    setPhase("idle");
  };

  const startRecording = async () => {
    if (engine === "browser") return startBrowserRecording();
    setError("");
    setTranscript("");
    setPartialMsg("");
    setRetryable(false);
    lastAudioRef.current = "";
    try {
      const stream = await openMic(micId);
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      sentSecondsRef.current = 0;
      recorder.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (chunksRef.current.length === 0) {
          setError("No audio captured — check the selected microphone.");
          setPhase("idle");
          return;
        }
        // transcribe the remainder and append it after the earlier segments
        await sendSegment({ final: true });
      };
      // ponytail: 30s slices just to get ondataavailable chunks; sent cumulatively, not per-chunk.
      recorder.start(30000);
      recorderRef.current = recorder;
      setElapsed(0);
      setPhase("recording");
    } catch {
      setError("Could not open the selected microphone.");
      setPhase("idle");
    }
  };

  const stopRecording = () => {
    if (engine === "browser") return stopBrowserRecording();
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  };

  const retryTranscribe = async () => {
    if (!lastAudioRef.current) return;
    setError("");
    setRetryable(false);
    setPhase("transcribing");
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64: lastAudioRef.current, apiKey, language }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setTranscript((t) => (t ? `${t} ${data.transcript}` : data.transcript));
      lastAudioRef.current = ""; // success — audio freed
      chunksRef.current = [];
    } catch (e) {
      setRetryable(true);
      setError(e instanceof Error ? e.message : "Transcription failed.");
    } finally {
      setPhase("idle");
    }
  };

  const copyTranscript = async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500); // transient ✓ — no permanent state
    } catch {
      setError("Could not copy — select the transcript and copy manually.");
    }
  };

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  phaseRef.current = phase; // keep the mirror current for recognition callbacks

  return (
    <main className="container">
      <h1>Speech Transcriber</h1>

      <section className="panel">
        <label htmlFor="engine">Engine</label>
        <select
          id="engine"
          value={engine}
          onChange={(e) => setEngine(e.target.value as Engine)}
          disabled={phase !== "idle"}
        >
          <option value="browser">Browser (free, live, Chrome/Edge — same language out)</option>
          <option value="gemini">Gemini (API key, translates to any language)</option>
        </select>

        <label htmlFor="apikey">Gemini API key</label>
        <div className="keyrow">
          <input
            id="apikey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your key (aistudio.google.com/apikey)"
            disabled={phase !== "idle"}
          />
          <button
            onClick={() => testKey(apiKey)}
            disabled={apiKey.trim() === "" || keyStatus === "testing" || phase !== "idle"}
          >
            {keyStatus === "testing" ? (
              <>
                <span className="spinner" /> Testing…
              </>
            ) : keyStatus === "valid" ? (
              "✓ Key valid"
            ) : (
              "Test key"
            )}
          </button>
        </div>

        {mics.length === 0 ? (
          <>
            <label>Microphone</label>
            <button onClick={enableMics}>Enable microphone access</button>
          </>
        ) : (
          <>
            <label htmlFor="mic">Microphone</label>
            <select id="mic" value={micId} onChange={(e) => setMicId(e.target.value)} disabled={phase !== "idle"}>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>

            <label htmlFor="lang">Transcript language</label>
            <select id="lang" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={phase !== "idle"}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>

            {phase === "recording" ? (
              <button className="stop" onClick={stopRecording}>
                {engine === "browser" ? "■ Stop" : `■ Stop & transcribe (${mmss})`}
              </button>
            ) : (
              <button
                onClick={startRecording}
                disabled={phase === "transcribing" || (engine === "gemini" && keyStatus !== "valid")}
                title={engine === "gemini" && keyStatus !== "valid" ? "Test your API key first" : undefined}
              >
                {phase === "transcribing" ? (
                  <>
                    <span className="spinner" /> Transcribing…
                  </>
                ) : (
                  "● Record"
                )}
              </button>
            )}
          </>
        )}
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}
        {retryable && (
          <button className="retry" onClick={retryTranscribe}>
            ↻ Retry transcription
          </button>
        )}
      </section>

      <section className="panel">
        <div className="transcript-head">
          <label style={{ margin: 0 }}>Transcript</label>
          <div className="transcript-actions">
            <button className="ghost" onClick={copyTranscript} disabled={!transcript}>
              {copied ? "✓ Copied" : "Copy"}
            </button>
            <button
              className="ghost"
              onClick={() => {
                if (phase === "recording" && engine === "browser") finalTextRef.current = ""; // keep live session, drop committed text
                else setTranscript("");
              }}
              disabled={!transcript}
            >
              Clear
            </button>
          </div>
        </div>
        {partialMsg && (
          <p className="status" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" /> {partialMsg}
          </p>
        )}
        <p className="transcript">{transcript || "— nothing yet —"}</p>
      </section>
    </main>
  );
}
