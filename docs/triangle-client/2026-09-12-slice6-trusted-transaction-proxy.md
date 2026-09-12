# Slice 6: Trusted Swift transaction proxy

Status: Implementation landed (2026-09-12) — Mac security review still required

Updated: 2026-09-12

## Scope

Hard gate before production Hermes / `coordinator-delivery-v1` claim/reply/ack.
Out of Phase 1/2 Complete. Not Bob canary. Not optional Codex SDK.

## Landed in this PR

### Swift (`packages/macos-mailbox-helper`)

- `MailboxTransactionModels.swift` — exact `open.json` schema, deterministic
  `claim_` / `reply_` IDs, protocol ownership (`self-serve-drain` vs
  `coordinator-delivery-v1`)
- `MailboxTransactionStore.swift` — owner-only paths, symlink rejection,
  single-writer lock, atomic replace, file + parent-directory fsync, quarantine
  without pretending the MESH claim was released
- `MailboxPolicyEvaluator.swift` — shared preflight / MCP list filtering rule set
- `MailboxTransactionService.swift` — claim/reply/ack state machine with crash
  injection points
- `MCPTransactionRewriter.swift` — ignores model-supplied claim/reply IDs;
  enforces room match, nested-claim refusal, unrelated-ack refusal
- Helper CLI: `transaction-preflight`, `transaction-status`,
  `transaction-claim`, `transaction-reply` (text on stdin), `transaction-ack`,
  `transaction-abandon --confirm`, `transaction-record-failure`
- `triangle-mailbox mcp` enables the rewriter against the durable store
- Contract cases covering crash boundaries, storage faults, malicious params,
  protocol mismatch, stuck after five failures, and no message content in
  storage/logs

### Node (`packages/agent-worker`)

- `helper-transaction-proxy.mjs` — CLI adapter for claim/reply/ack
- `createTrustedTransactionProxy()` resolves to helper when `helperPath` +
  profile are present; otherwise keeps the fail-closed stub
- Self-serve local adapter tests may still proceed without the proxy

## Not claimed / still required

- Darwin host suite execution (`bash scripts/test-host.sh`) — Linux CI cannot
  compile the macOS Swift package
- Independent Mac security review of the expanded signed-helper boundary
- Live MESH integration / Bob end-to-end canary
- Optional Codex SDK adapter

## Verification (Linux, this environment)

```sh
cd packages/agent-worker && node --test test/helper-transaction-proxy.test.mjs test/shared-codex-app-server.test.mjs
# 18/18 pass

cd packages/agent-worker && npm test
# 177 tests, 169 pass, 8 skip (Darwin-only), 0 fail
```

Darwin (required before production):

```sh
cd packages/macos-mailbox-helper && bash scripts/test-host.sh
# includes MailboxTransactionContractCases crash + fault suite
```
