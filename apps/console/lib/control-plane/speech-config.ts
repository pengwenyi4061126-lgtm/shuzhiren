export function configuredSpeechVoice() {
  const voice = process.env.RUNTIME_SPEECH_VOICE ?? (process.env.NODE_ENV === "production" ? undefined : "approved_voice_demo");
  if (!voice || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(voice)) throw new Response("Approved runtime speech voice is not configured", { status: 503 });
  return voice;
}
