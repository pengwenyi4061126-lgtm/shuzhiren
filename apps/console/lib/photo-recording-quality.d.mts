export interface PhotoNarrationMetadata {
  width: number;
  height: number;
  hasDecodedFrame: boolean;
  duration: number;
}

export declare function photoNarrationQualityProblems(metadata: PhotoNarrationMetadata, expectedDuration: number): string[];
