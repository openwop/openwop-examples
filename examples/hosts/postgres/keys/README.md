# Bundle-signing key

`host.pub.pem` is the Ed25519 public key (SPKI PEM) that verifies this host's certification bundles v3 (`signature.keyId: postgres-reference-1`, RFC 0168 §E.2). The host derives the `signingKeys[]` entry its **v1** discovery root publishes from this file (`src/signing-keys.ts`), so the published value cannot drift from the committed key: a certification bundle is v3 regardless of major, and a v1-only host has only that document to hand a verifier.

The private half (PKCS8 PEM, mode 0600) lives **only** at `~/.openwop-keys/postgres-reference-1.host.pem` on the steward's machine. It never enters this repository or a worktree — the v2 reference host rotated three times because its private half lived in a worktree that was later deleted. `scripts/cut-bundle.sh` reads it from there (override with `OPENWOP_BUNDLE_SIGNING_KEY`) and refuses to cut if it is not mode 600 or does not pair with `host.pub.pem`.

Rotation: `node scripts/keygen.mjs --key-id postgres-reference-2`, set `BUNDLE_SIGNING_KEY_ID` in `src/signing-keys.ts`, and keep the old key listed in `signingKeys[]` with `retiredAt` — dropping it silently invalidates every bundle it signed.
