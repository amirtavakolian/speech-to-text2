# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A speech-to-text web app: pick a microphone, pick a language, record, and Gemini transcribes + writes the transcript in the chosen language. TypeScript throughout, Next.js (App Router) for both frontend and backend.

## Commands

- `npm run dev` — dev server at http://localhost:3000
- `npm run build` / `npm start` — production build / serve
- No linter or tests are configured.

## Architecture

- `app/page.tsx` — the entire UI (client component): Gemini API key entry + "Test key" validation gate, mic permission + device list (`enumerateDevices`), language dropdown, record/stop with `MediaRecorder` (sends the unsent audio segment to Gemini every 30s for a live partial transcript, appended in spoken order), elapsed timer, transcript display.
- `lib/audio.ts` — mic helpers and the WAV encoder: recorded blob → `decodeAudioData` → resample to 16 kHz mono 16-bit PCM WAV (optionally skipping already-sent leading seconds) → base64. WAV normalizes away browser codec differences (Chrome webm/opus, Safari mp4).
- `app/api/transcribe/route.ts` — the backend. Takes `{ audioBase64, apiKey, language }`, calls Gemini (`@google/genai`) with `inlineData` + a transcribe-and-translate prompt, returns `{ transcript }`. The API key comes from the request body — entered in the UI and validated up front via `app/api/test-key/route.ts` (one-token generateContent).

## Setup

No required env vars — the Gemini API key is entered in the UI (get one at https://aistudio.google.com/apikey) and tested with the "Test key" button before recording unlocks. Optional `GEMINI_MODEL` in `.env.local` overrides the default `gemini-3.6-flash`.

## Notes

- Mic labels are empty until the user grants permission via a button click — that's why the UI gates `enumerateDevices` behind an explicit "Enable microphone access" gesture.
- `aa.png` was the original UI reference image.
