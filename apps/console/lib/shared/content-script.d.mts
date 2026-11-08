export function splitNarrationScript(source: string, maxLength?: number): string[];
export function generateProductScript(input: { name: string; goal: string; audience: string; priceCent?: number; highlights: string[]; faq: string[]; style?: "friendly" | "professional" | "faq"; length?: "short" | "standard" | "detailed" }): string;
