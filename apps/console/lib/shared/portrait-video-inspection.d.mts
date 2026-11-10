export type PortraitVideoInspection =
  | { state: "invalid"; reason: string }
  | { state: "ready"; durationSeconds: number; width: number; height: number; orientation: "portrait" | "landscape"; audioTrackCount: number | null };
export function inspectPortraitVideoMetadata(metadata: { durationSeconds: number; width: number; height: number; audioTrackCount?: number | null }): PortraitVideoInspection;
