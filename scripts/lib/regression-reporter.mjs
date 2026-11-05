// node:test reporter for scripts/regression-evidence.mjs (design part 8 §2.1
// step 5). Writes one JSON line per test:fail with the fields classifyRun
// needs, one per test:pass, and the last stderr chunks of each test file so
// that load failures (which node:test reports as a bare "test failed") can be
// explained. Use with --test-reporter-destination=<file>.
const MAX_STDERR_EVENTS = 200;
const MAX_MESSAGE = 2000;

function text(value, limit = MAX_MESSAGE) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, limit);
}

export function describeFailure(data) {
  const error = data?.details?.error;
  const cause = error?.cause;
  const causeIsObject = cause !== null && typeof cause === "object";
  return {
    type: "test:fail",
    name: text(data?.name, 500),
    nesting: data?.nesting ?? null,
    file: text(data?.file, 500),
    failureType: error?.failureType ?? null,
    code: error?.code ?? null,
    causeCode: causeIsObject ? (cause.code ?? null) : null,
    causeName: causeIsObject ? (cause.name ?? null) : null,
    message: text(causeIsObject ? cause.message : (cause ?? error?.message))
  };
}

export default async function* regressionReporter(source) {
  let stderrEvents = 0;
  for await (const event of source) {
    switch (event.type) {
      case "test:fail":
        yield `${JSON.stringify(describeFailure(event.data))}\n`;
        break;
      case "test:pass":
        if (event.data?.details?.type !== "suite") yield `${JSON.stringify({ type: "test:pass", name: text(event.data?.name, 500), nesting: event.data?.nesting ?? null, skip: Boolean(event.data?.skip), todo: Boolean(event.data?.todo) })}\n`;
        break;
      case "test:stderr":
        if (stderrEvents < MAX_STDERR_EVENTS) {
          stderrEvents += 1;
          yield `${JSON.stringify({ type: "test:stderr", file: text(event.data?.file, 500), message: text(event.data?.message) })}\n`;
        }
        break;
      default:
        break;
    }
  }
}
