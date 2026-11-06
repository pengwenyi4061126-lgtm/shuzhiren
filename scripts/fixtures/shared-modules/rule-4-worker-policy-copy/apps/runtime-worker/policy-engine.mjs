export function evaluatePolicy(question) {
  return { action: question ? "answer" : "refuse" };
}
