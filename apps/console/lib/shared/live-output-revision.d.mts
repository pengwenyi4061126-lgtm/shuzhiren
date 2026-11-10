export type LiveOutputRevisionState = "current" | "stale" | "unknown";
export function getLiveOutputRevisionDisplay(currentRevision: number, sourceRevision: number | null | undefined): { state: LiveOutputRevisionState; label: string };
export function matchesProjectRevision(currentRevision: number, expectedRevision: number): boolean;
export function matchesProjectScriptToPreparedSegments(script: string, segments: Array<{ kind: string; runtimeScript?: string }>): boolean;
