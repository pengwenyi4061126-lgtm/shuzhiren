import { createHash } from "node:crypto";

// Read-only subset of the OCI Distribution v2 API: manifests and blobs by digest. Every download is hashed and
// must equal the requested digest. Credentials are only ever sent to the registry host itself (Basic or the
// Bearer token endpoint when it is on that host); a token realm on another host is asked anonymously.
const manifestAccept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json"
].join(", ");
const maxManifestBytes = 4 * 1024 * 1024;
const maxBlobBytes = 256 * 1024 * 1024;

export class RegistryError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

/** Splits "<host>/<path>@sha256:<hex>" into its parts; returns null for anything else. */
export function parseImageReference(image) {
  const match = /^([a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?)\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@(sha256:[a-f0-9]{64})$/.exec(typeof image === "string" ? image : "");
  return match ? { host: match[1], repository: match[3], digest: match[4] } : null;
}

export function createRegistryClient({ host, credentials, fetch: fetchImpl = globalThis.fetch, scheme = "https" }) {
  const tokens = new Map();
  const base = `${scheme}://${host}`;
  const basic = credentials?.username && credentials?.password ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` : null;

  async function token(challenge, scope) {
    const params = Object.fromEntries([...challenge.matchAll(/([a-z]+)="([^"]*)"/gi)].map((match) => [match[1].toLowerCase(), match[2]]));
    if (!params.realm) throw new RegistryError("registry_auth_failed", "Bearer challenge without realm");
    const realm = new URL(params.realm);
    if (realm.protocol !== `${scheme}:`) throw new RegistryError("registry_auth_failed", "token realm must use the registry's scheme");
    if (params.service) realm.searchParams.set("service", params.service);
    realm.searchParams.set("scope", params.scope ?? scope);
    const headers = realm.host === host && basic ? { authorization: basic } : {};
    const response = await fetchImpl(realm, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new RegistryError("registry_auth_failed", `token endpoint answered ${response.status}`);
    const body = await response.json();
    const value = body?.token ?? body?.access_token;
    if (typeof value !== "string" || !value) throw new RegistryError("registry_auth_failed", "token endpoint returned no token");
    return `Bearer ${value}`;
  }

  async function get(repository, kind, digest, accept, limit) {
    const url = `${base}/v2/${repository}/${kind}/${digest}`;
    const scope = `repository:${repository}:pull`;
    const request = (authorization) => fetchImpl(url, { headers: { ...(accept ? { accept } : {}), ...(authorization ? { authorization } : {}) }, signal: AbortSignal.timeout(60_000) });
    let response;
    try {
      response = await request(tokens.get(scope) ?? basic);
      if (response.status === 401) {
        const challenge = response.headers.get("www-authenticate") ?? "";
        await response.body?.cancel();
        if (/^bearer\s/i.test(challenge)) {
          tokens.set(scope, await token(challenge, scope));
          response = await request(tokens.get(scope));
        }
      }
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      throw new RegistryError("registry_request_failed", `${kind} ${digest}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) { await response.body?.cancel(); throw new RegistryError("registry_request_failed", `${kind} ${digest} answered ${response.status}`); }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new RegistryError("registry_response_too_large", `${kind} ${digest}`);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) throw new RegistryError("digest_mismatch", `${kind} ${digest}`);
    return { bytes, contentType: response.headers.get("content-type") ?? "" };
  }

  return {
    async manifest(repository, digest) {
      const { bytes, contentType } = await get(repository, "manifests", digest, manifestAccept, maxManifestBytes);
      let json;
      try { json = JSON.parse(bytes.toString("utf8")); } catch { throw new RegistryError("invalid_manifest", digest); }
      return { json, mediaType: json?.mediaType ?? contentType.split(";")[0].trim() };
    },
    async blob(repository, digest) {
      return (await get(repository, "blobs", digest, null, maxBlobBytes)).bytes;
    }
  };
}
