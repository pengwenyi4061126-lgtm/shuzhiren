export declare const studioDemoProjectName: string;
export declare function buildStudioDemoSeedInput(input: {
  product: { name: string };
  version: {
    id: string;
    status: string;
    facts: {
      priceCent: number;
      unitCostCent?: number;
      stock: number;
      highlights: string[];
      faq: string[];
      sourceRef: string;
      sourceSyncedAt: string;
      validFrom: string;
      validUntil?: string;
    };
  };
  assets: Array<{ id: string; kind: string; approval: string; expiresAt?: string }>;
  now?: Date;
}): {
  name: string;
  goal: string;
  audience: string;
  outputMode: "both";
  productVersionId: string;
  assetIds: string[];
  script: string;
};
