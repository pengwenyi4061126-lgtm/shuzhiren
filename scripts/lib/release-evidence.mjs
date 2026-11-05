import { createRegistryClient, parseImageReference, RegistryError } from "./oci-registry-client.mjs";

// Release evidence is read from the registry, not asserted: for every pushed image index the linux/amd64 image,
// the Buildx attestation manifest that references it, and in that manifest exactly one SPDX SBOM and one SLSA
// provenance in-toto statement whose subject is the linux/amd64 image digest.
export const sbomPredicateType = "https://spdx.dev/Document";
export const provenancePredicatePrefix = "https://slsa.dev/provenance/";
const indexMediaTypes = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);

export class ReleaseEvidenceError extends Error {
  constructor(failures) { super(failures.map(({ key, reason }) => `ERROR  ${key} ${reason}`).join("\n")); this.failures = failures; }
}

/** Validates the ten schemaVersion 2 build results and returns { key -> image } in imageKeys order. */
export function releaseImagesFromResults(results, imageKeys, revision) {
  if (results.length !== imageKeys.length) throw new Error("release image results must contain exactly ten files");
  const byKey = new Map();
  for (const result of results) {
    if (!result || result.schemaVersion !== 2 || !imageKeys.includes(result.key) || !parseImageReference(result.image) || result.revision !== revision) throw new Error("release image result is invalid or was built from a different revision");
    if (byKey.has(result.key)) throw new Error(`duplicate release image result: ${result.key}`);
    byKey.set(result.key, result.image);
  }
  if (imageKeys.some((key) => !byKey.has(key))) throw new Error("release image results are missing a required service");
  return Object.fromEntries(imageKeys.map((key) => [key, byKey.get(key)]));
}

/** Reads the attestations of one image index from the registry; throws RegistryError with a reason code. */
export async function readImageAttestations(client, image) {
  const reference = parseImageReference(image);
  const index = await client.manifest(reference.repository, reference.digest);
  if (!indexMediaTypes.has(index.mediaType) || !Array.isArray(index.json?.manifests)) throw new RegistryError("not_an_image_index");
  const referenceType = (entry) => entry?.annotations?.["vnd.docker.reference.type"];
  const platforms = index.json.manifests.filter((entry) => entry?.platform?.os === "linux" && entry?.platform?.architecture === "amd64" && referenceType(entry) === undefined);
  if (platforms.length !== 1) throw new RegistryError("platform_manifest_not_unique", `${platforms.length} linux/amd64 images`);
  const platformDigest = platforms[0].digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(platformDigest ?? "")) throw new RegistryError("invalid_manifest", "linux/amd64 digest");
  const attestationEntries = index.json.manifests.filter((entry) => referenceType(entry) === "attestation-manifest" && entry?.annotations?.["vnd.docker.reference.digest"] === platformDigest);
  if (attestationEntries.length !== 1) throw new RegistryError("attestation_manifest_not_unique", `${attestationEntries.length} attestation manifests reference ${platformDigest}`);
  const attestationDigest = attestationEntries[0].digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(attestationDigest ?? "")) throw new RegistryError("invalid_manifest", "attestation manifest digest");
  const attestation = await client.manifest(reference.repository, attestationDigest);
  const layers = Array.isArray(attestation.json?.layers) ? attestation.json.layers : [];
  const predicateOf = (layer) => layer?.annotations?.["in-toto.io/predicate-type"];
  const pick = (kind, matches) => {
    const found = layers.filter((layer) => typeof predicateOf(layer) === "string" && matches(predicateOf(layer)));
    if (found.length !== 1) throw new RegistryError(`${kind}_layer_not_unique`, `${found.length} ${kind} layers`);
    return found[0];
  };
  const statements = {};
  for (const [kind, layer] of [["sbom", pick("sbom", (type) => type === sbomPredicateType)], ["provenance", pick("provenance", (type) => type.startsWith(provenancePredicatePrefix))]]) {
    if (!/^sha256:[a-f0-9]{64}$/.test(layer.digest ?? "")) throw new RegistryError("invalid_manifest", `${kind} layer digest`);
    const bytes = await client.blob(reference.repository, layer.digest);
    let statement;
    try { statement = JSON.parse(bytes.toString("utf8")); } catch { throw new RegistryError("invalid_statement", `${kind} is not JSON`); }
    if (statement?.predicateType !== predicateOf(layer)) throw new RegistryError("predicate_type_mismatch", `${kind} statement declares ${statement?.predicateType}`);
    const subjectDigest = platformDigest.slice("sha256:".length);
    if (!Array.isArray(statement.subject) || !statement.subject.some((subject) => subject?.digest?.sha256 === subjectDigest)) throw new RegistryError("subject_mismatch", `${kind} statement does not name ${platformDigest}`);
    statements[kind] = { platform: "linux/amd64", platformManifestDigest: platformDigest, attestationManifestDigest: attestationDigest, predicateType: predicateOf(layer), digest: layer.digest };
  }
  return statements;
}

/**
 * Reads every image's attestations and builds the three evidence documents. Image registries must equal
 * `registry` when it is given, otherwise all images must share one registry, so a tampered result cannot send the
 * read credentials elsewhere. Throws ReleaseEvidenceError listing every failed image.
 */
export async function assembleReleaseEvidence({ images, revision, source, registry, credentials, fetch, scheme }) {
  const hosts = new Set(Object.values(images).map((image) => parseImageReference(image).host));
  const trusted = registry || (hosts.size === 1 ? [...hosts][0] : null);
  const clients = new Map();
  const failures = [];
  const sbom = {};
  const provenance = {};
  for (const [key, image] of Object.entries(images)) {
    const { host } = parseImageReference(image);
    if (!trusted || host !== trusted) { failures.push({ key, reason: `registry_not_trusted: ${host}` }); continue; }
    if (!clients.has(host)) clients.set(host, createRegistryClient({ host, credentials, fetch, scheme }));
    try {
      const statements = await readImageAttestations(clients.get(host), image);
      sbom[key] = statements.sbom;
      provenance[key] = statements.provenance;
    } catch (error) {
      failures.push({ key, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failures.length) throw new ReleaseEvidenceError(failures);
  const index = { schemaVersion: 2, releaseRevision: revision, source, images };
  return {
    images,
    sbomIndex: { ...index, artifactType: "oci-buildx-sbom-index", attestations: sbom },
    provenanceIndex: { ...index, artifactType: "oci-buildx-provenance-index", builder: "github-actions-buildx", attestations: provenance }
  };
}
