import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // ~15 MB of WAV ≈ 8 minutes at 16 kHz mono

export async function POST(req: NextRequest) {
  let body: { audioBase64?: string; apiKey?: string; language?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { audioBase64, apiKey, language } = body;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return NextResponse.json({ error: "API key is required." }, { status: 401 });
  }
  if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
    return NextResponse.json({ error: "audioBase64 is required." }, { status: 400 });
  }
  if (audioBase64.length > MAX_AUDIO_BYTES * 4 / 3) {
    return NextResponse.json({ error: "Audio too long — keep recordings under ~8 minutes." }, { status: 413 });
  }
  const lang = typeof language === "string" && language.trim() ? language.trim() : "English";

  try {
    const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
    const res = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "audio/wav", data: audioBase64 } },
            { text: `Transcribe the audio. Write the transcript in ${lang}. Output only the transcript text.` },
          ],
        },
      ],
    });
    const transcript = res.text?.trim();
    if (!transcript) {
      return NextResponse.json({ error: "Gemini returned no transcript (audio may be silent)." }, { status: 502 });
    }
    return NextResponse.json({ transcript });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Gemini API call failed.";
    return NextResponse.json({ error: `Transcription failed: ${message}` }, { status: 502 });
  }
}
