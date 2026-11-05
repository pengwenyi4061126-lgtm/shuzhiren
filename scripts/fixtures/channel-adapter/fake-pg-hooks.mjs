const fakePg = new URL("./fake-pg.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "pg") return { url: fakePg, shortCircuit: true };
  return nextResolve(specifier, context);
}
