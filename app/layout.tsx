import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Speech Transcriber",
  description: "Record from any microphone and transcribe with Gemini",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
