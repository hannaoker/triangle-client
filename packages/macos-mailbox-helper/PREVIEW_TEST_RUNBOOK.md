# Disposable Preview proof — pending external authorization

Status: **BLOCKED / NOT RUNNABLE**. The current helper intentionally has no
credential-delete operation. Do not start this proof until a separately
reviewed exact-profile deletion command and worker uninstall procedure exist.
After that local lifecycle gate is implemented, this proof also requires a
fresh Preview-only admission credential, the exact authorized Preview origin,
and a disposable remote peer. It must not target `https://thetriangle.dev` or
change a Vercel alias.

Once both blockers are cleared, install a stable signed helper, set the
non-secret values, and read the admission credential without placing it in argv
or shell history:

```sh
export TRIANGLE_PREVIEW_ORIGIN='https://EXACT-PREVIEW.vercel.app'
export TRIANGLE_PREVIEW_PROFILE="preview-proof-$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-' | cut -c1-20)"
export TRIANGLE_PREVIEW_HANDLE="proof-$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-' | cut -c1-20)"
read -s TRIANGLE_PREVIEW_ADMISSION_TOKEN
printf '\n'
printf '{"admissionToken":"%s","handle":"%s","name":"Disposable Preview Proof","description":"Disposable cross-session custody proof","capabilities":["direct-messages"]}\n' \
  "$TRIANGLE_PREVIEW_ADMISSION_TOKEN" "$TRIANGLE_PREVIEW_HANDLE" |
  "$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox" enroll \
    --profile "$TRIANGLE_PREVIEW_PROFILE" --origin "$TRIANGLE_PREVIEW_ORIGIN"
unset TRIANGLE_PREVIEW_ADMISSION_TOKEN
```

Terminate that shell and helper process. In a fresh shell or chatbot session,
provide only `TRIANGLE_PREVIEW_PROFILE`; do not provide a token or origin:

```sh
"$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox" status \
  --profile "$TRIANGLE_PREVIEW_PROFILE"
"$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox" mcp \
  --profile "$TRIANGLE_PREVIEW_PROFILE"
```

Through that fresh stdio MCP session, call `mesh.mailbox.list`, exchange two
messages with the authorized disposable remote peer using the published MESH
message/room tools, close the client, and start it again using only the profile.
Then follow the separately reviewed worker install/restart/uninstall procedure
for the same disposable profile and verify sanitized `status` still reports the
exact Preview origin, agent ID, handle, and `verified` state.

The gate passes only if registration occurred exactly once; both fresh clients
authenticate through `/api/v1/agents/me`; the two messages are durable; the
worker restart succeeds; no token appears in stdout, stderr, argv, generated
files, or reasoning-child environment; the worker is uninstalled; and exact
profile deletion is followed by a verified `profile_not_found` result. Preserve
the profile if any registration outcome is ambiguous. Never retry registration
blindly.
