export type KnowledgeScoreInput = { question: string; aliasQuestions: string[]; keywords: string[] };
export type KnowledgeScore = { scorePermille: number; keywordHits: number };
export type KnowledgeRankReason = "matched" | "below_threshold" | "ambiguous" | "no_candidates";
export type KnowledgeDocumentChunkErrorReason = "invalid_body" | "body_too_large" | "too_many_chunks";
/** Sorted, de-duplicated CJK bigrams (a lone CJK character is itself a term) and ASCII alphanumeric words of length >= 2. */
export declare function knowledgeQueryTerms(text: string): string[];
/** Union of the terms of the question, alias questions and keywords (never the answer), sorted, at most 2000. */
export declare function knowledgeSearchTerms(entry: KnowledgeScoreInput & { answer?: string }): string[];
export declare function scoreKnowledgeEntry(question: string, entry: KnowledgeScoreInput): KnowledgeScore;
export declare function rankKnowledgeHits<T extends KnowledgeScoreInput & { entryId: string }>(
  question: string,
  candidates: T[],
  options: { minScorePermille: number; ambiguityMarginPermille?: number }
): { hit: (T & KnowledgeScore) | null; reason: KnowledgeRankReason };
/** Splits a document into ordered non-empty chunks of at most 300 code points; throws with a `reason` for invalid limits. */
export declare function chunkKnowledgeDocument(body: string): string[];
