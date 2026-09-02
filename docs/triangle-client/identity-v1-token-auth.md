# Identity-v1 mailbox registration and local token custody

## Summary

Identity-v1 mailbox registration (`mesh.registration_challenge` +
`mesh.complete_registration`, server path `mesh/app/lib/identity-registration.ts`)
creates an agent and workload key but **does not return** a one-shot `mesh_`
compatibility bearer. The macOS helper's `EnrollmentService` fabricates a local
`mesh_*` token when the registration response omits `token` (see
`EnrollmentService.swift` around the `missing_mesh_token` journal path).

That fabricated bearer is **not** registered server-side. It cannot authenticate
mailbox REST calls that expect the real compatibility secret.

## Current working paths

| Path | Auth | Status |
| --- | --- | --- |
| Legacy `register-mailbox` / `mesh.mailbox.register` | One-shot `mesh_` token returned and stored | Works for worker bootstrap |
| Identity-v1 registration + interactive MCP | Workload JWT + DPoP via `MCPProxy` | Works; preferred for chatbot MCP |
| Identity-v1 registration + Triangle Client worker | Fabricated `mesh_` in Keychain bootstrap | **Broken** for bearer-only mailbox calls |

Workload DPoP is the supported MCP path (commit `92224cf`). See
[`KEYCHAIN_POLICY.md`](../../packages/macos-mailbox-helper/KEYCHAIN_POLICY.md)
for Keychain item layout (`dev.thetriangle.mesh.mailbox`,
`dev.thetriangle.mesh.workload-key`).

## Why not fix in place (medium effort)

A correct fix requires coordinated server and client changes:

1. **Server**: Return a one-shot `mesh_` compatibility token from identity-v1
   mailbox registration (today explicitly absent; see
   `identity-registration.test.mjs` — `Object.hasOwn(result, "token")` is false).
2. **Client**: Stop fabricating local secrets; store only server-issued material.
3. **Tests**: Update mesh identity-registration tests, enrollment contract tests,
   and any D1 persistence assertions for `token_prefix` / `token_hash`.

Estimated scope: medium (100+ lines, two packages, no single isolated hook).
ROI is lower than documenting the split and using workload DPoP for MCP plus
legacy registration for headless workers until a dedicated compatibility-token
mint exists.

## Operator workarounds

- **Interactive MCP**: Enroll via identity-v1; use `triangle-mailbox mcp
  --profile NAME`. No real `mesh_` needed; `MCPProxy` uses workload keys.
- **Headless worker**: Prefer legacy mailbox registration (admission token →
  `enroll` stdin) so the server returns a real one-shot `mesh_` token.
- **D1 / server sync**: If an agent exists only on identity-v1, use MESH
  credential recovery (`agent credential recovery` flows) rather than
  re-registering with the same handle.
- **Triangle Client + MCP**: Set `deliveryMode` to `mcp-interactive` so the
  coordinator does not compete with MCP polling:
  `triangle-client agent set-delivery-mode --profile X --mode mcp-interactive`.

## Future fix scope

When implemented, the fix should:

- Issue and return exactly one `mesh_[0-9a-f]{64}` token at identity-v1
  mailbox registration (same contract as `registerMailboxAgent`).
- Remove client-side `SecRandomCopyBytes` fabrication.
- Add regression tests on both server registration response and enrollment
  storage without weakening the "no token in logs" invariant.

Until then, treat fabricated Keychain bearers as enrollment placeholders only;
do not assume they authorize server APIs.
