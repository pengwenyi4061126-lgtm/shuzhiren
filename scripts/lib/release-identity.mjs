// Release_Manifest signer identity formats, shared by
// scripts/create-deployment-release-manifest.mjs (--issuer, --key-id) and
// scripts/release-environment.mjs signing (RELEASE_ISSUER, RELEASE_KEY_ID) so
// the run-time check and the signer cannot drift apart.
export const RELEASE_ISSUER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
export const RELEASE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
