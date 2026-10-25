# PR #117 independent review

2026-10-24. Reviewed head `ab7b741` against base `5b6c5c8` with an independent
read-only Codex reviewer. Scope: identity/authorization, private credentials and
claims, queued delivery/recovery, and packaging compatibility.

Two actionable P2 findings were reproduced in disposable fixtures:

1. Stdin decoding per Buffer chunk corrupted multibyte UTF-8 split across reads.
   Fixed with bounded byte collection and a single decode. A real local socket
   regression now exercises both send and reply with `你好🌍` split into bytes.
2. Pairing could append beyond the workspace policy's 64-entry ceiling, making
   existing Claude session policy unreadable. Fixed by validating existing policy
   and both combined list bounds before any owner file is written. Regression
   covers the 32-worker/desktop/31-Grok boundary, both grant directions, and
   unchanged policy/config/binding state on rejected overflow.

The reviewer independently checked the fixes and reran the Grok suite: 10/10
passed; both findings resolved. No identity or authorization bypass was found in
this review. This is a scoped review result, not a general security certification.
Installed-runtime acceptance remains separate from review and source-host proof.
