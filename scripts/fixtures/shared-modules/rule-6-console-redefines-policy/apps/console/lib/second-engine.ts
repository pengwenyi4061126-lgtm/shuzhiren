export function evaluatePolicy(question: string) {
  return { action: question ? "answer" : "refuse" };
}
