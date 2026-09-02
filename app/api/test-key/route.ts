import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

/** Cheapest possible validation: one-token generateContent. 401 on bad key. */
export async function POST(req: NextRequest) {
  let body: { apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return NextResponse.json({ error: "API key is required." }, { status: 400 });

  try {
    const ai = new GoogleGenAI({ apiKey });
    await ai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
      contents: "hi",
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Gemini API call failed.";
    return NextResponse.json(
      { error: /api key|permission|401|403/i.test(message) ? "Invalid API key." : `Key check failed: ${message}` },
      { status: 401 }
    );
  }
}
