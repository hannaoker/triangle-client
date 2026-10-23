# Claude session socket spike — October 22

## Observed capability

Installed CLI: Claude Code 2.1.307. Authentication status reported signed in.
No persistent Claude settings changed; no registry or other session token files
were opened. All socket credentials stayed inside the MCP child that inherited
them from this scratch Claude process.

The first harmless `-p` session with a session-scoped, no-tools MCP configuration
returned exactly `CLAUDE_PROBE_OK`. The child reported only booleans for presence
of `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, and
`CLAUDE_CODE_MESSAGING_TOKEN`; all three were present. Values were not recorded.

A second isolated CLI used stream-json input/output with stdin held open and
`--strict-mcp-config --no-session-persistence --tools ''`. Initial user input
requested `CLAUDE_IDLE_READY` with no tools. The session returned that exact
text and a non-error result. The child's own MCP tools-list initialization
scheduled one canary after 15 seconds. It opened only its inherited inbox,
wrote newline-delimited auth then user frames, and closed the connection.
The fixed automated/untrusted user frame requested only `CLAUDE_SOCKET_OK`.
The same running CLI emitted exactly that second assistant response without
another parent stdin prompt. Scratch process and child were then terminated.

Captured event timestamps (Unix seconds): initial assistant 1792724093.967792,
initial result 1792724093.999619, injected-turn assistant 1792724108.582517.
The approximately 14.6-second gap includes the intentional injection timer;
it is not transport latency. Socket write status was accepted; the separately
observed assistant response establishes execution for this one canary.
Transient evidence: `/private/tmp/triangle-claude-spike/socket-events.json`.

## Evidence limits and next gate

This proves one idle injection into an isolated CLI session, not a packaged
Triangle Claude adapter, desktop-app wake, busy-session ordering, restart,
clear/rebind handling or bidirectional Triangle messaging. No Triangle identity
was enrolled and no Codex integration capability was passed to Claude.

Current production local host maps recipients to executable worker runners.
An interactive Claude session needs an owner-paired scoped identity, an inbox,
explicit reply/ack lifecycle and session fencing rather than pretending to be
a synchronous executable worker. Those shared changes require a concrete design
before integration. The delivery primitive can be tested independently first.

The socket is an unsupported internal interface pinned to this tested version;
missing/changed capability must degrade to pull. No development-channel bypass
was used. No Reason code was copied; only the wire protocol was consulted:
https://github.com/reason-machines/reason-network/blob/main/src/agent.rs

## Hardened transport implementation checkpoint

The delivery module and focused tests implement inherited-credential-only access,
fixed metadata hints, session/environment/socket replacement fencing, bounded
transport, close-before-settlement, busy refusal and conservative uncertainty.
The initial module live CLI attempt refused the exported socket as noncanonical;
no second assistant response was observed. Sanitized metadata showed a private
owned socket parent (0700) but a noncanonical exported path. A narrow Darwin
normalization now permits only root-owned `/var -> /private/var`, verifies the
system directories, and rejects any remaining alias or final symlink. Arbitrary
user aliases remain rejected. Parent/device/inode checks are retained.

Final focused tests: 10 passed. Independent initial review and alias re-review
found no P1/P2 defect; re-review independently passed all ten tests. The first
parent run of the alias test hit sandbox EPERM under `/private/var/tmp`; its
fixture was moved to the canonical system temporary directory, retaining actual
`/var` alias coverage, and all ten then passed without escalation.

The owner selected Claude Code in the desktop app. A new desktop scratch session
was created for that acceptance surface. CLI results remain preliminary.

## Desktop acceptance checkpoint

Owner-selected surface: Claude Code in the desktop app. A fresh scratch session
named `Triangle desktop wake scratch test` was created at
`claude.ai/epitaxy/local_bd1a4257-97ec-4c05-a72f-469b7af525d7`.
The desktop model launched the own-session background probe and visibly returned
`DESKTOP_CANARY_READY`. The primitive returned unsupported with
`unsafe_claude_socket`; it did not send a hint and no wake was observed.

A subsequent narrow metadata diagnostic was blocked by Claude Code Auto mode's
classifier with reason `[Credential Exploration]`. No alternate tool or
permission mode was used to bypass that denial. The owner was asked to approve
that exact diagnostic in Claude and answered that they would do so. Approval
completion is not inferred from that intention. Desktop acceptance is pending.

The desktop probe ran in a tool child, not a session-installed Triangle MCP
child; even a later successful scratch wake would not close MCP registration,
scoped identity or bidirectional-message gates. Production Triangle configuration
and Codex–Antigravity wake remain unchanged by this source-only branch.

The desktop UI subsequently showed the owner's explicit message, "I've allowed
that command. Run the metadata script again." Claude retried the identical
command once, and its Auto classifier denied it again with the same reason.
The parent did not retry through another tool or inspect other processes'
credentials. The owner was asked to use Ask mode in this scratch session and
approve the exact command there; no permission-mode change was made by Codex.

## Desktop `/tmp` alias diagnosis and correction

The owner subsequently supplied successful in-session diagnostic JSON:
absolute true, canonical false, varAlias false, tmpAlias true, socket true,
socketOwned true, socketMode 600, parentOwned true, parentMode 700,
sessionPresent true and tokenPresent true. No path or credential value was
provided. This identifies the exported `/tmp` alias as the custody mismatch.

A new regression failed before the fix (10 pass/one fail). The module now also
normalizes Darwin's exact root-owned `/tmp -> /private/tmp` alias. The shared
system ancestor is accepted only when root-owned, nonsymlink and sticky 1777;
the socket's immediate parent must still be private and owner-held, all remaining
components canonical, and inode/session fences remain unchanged. Final-socket
symlinks and nonprivate immediate parents are tested and rejected. Focused suite:
11 passed. A fresh desktop canary was submitted with wake ID
`caeae11f-efca-48d8-b864-e905bb0b93e6`; observed result follows when available.
