export interface DictationEvent {
  resultIndex: number;
  results: { length: number; [index: number]: { isFinal: boolean; [index: number]: { transcript: string } } };
}
export interface Dictation {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: DictationEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type VoiceWindow = Window & {
  SpeechRecognition?: new () => Dictation;
  webkitSpeechRecognition?: new () => Dictation;
};
export function dictationConstructor(window: VoiceWindow) {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}
export function voiceError(error: string) {
  if (error === "not-allowed" || error === "service-not-allowed") return "Microphone access was denied. Allow it in browser settings, or keep typing.";
  if (error === "no-speech") return "No speech was detected. Try again or type your message.";
  if (error === "audio-capture") return "No working microphone was found. Text chat is still available.";
  return "Dictation is unavailable or its speech service could not connect. Text chat is still available.";
}
