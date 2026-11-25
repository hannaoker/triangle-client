# Triangle Client reduction target

Keep MESH, same-machine messaging, and direct peer delivery. Use 79,865 physical lines at commit `47462cc` as the application-source baseline. The 50% ceiling is 39,932 lines, requiring a reduction of 39,933. The earlier 80,685 and 17,916 figures were exploratory estimates with different file selections. Use the pinned counts below for progress.

## Reproducing the baseline

Run from the repository root. The first command counts 231 application source files, including blank lines, comments, and inline tests. Removing the pipe lists the selected files and their individual counts. The second counts a narrower, independently reproducible subset of 31 dedicated local-messaging and peer files (14,537 lines). Shared infrastructure and other local adapters fall outside that subset.

```sh
git grep -c '^' 47462cc -- ':(glob)packages/*/src/**/*.mjs' ':(glob)packages/*/src/**/*.cjs' ':(glob)packages/*/src/**/*.rs' ':(glob)packages/*/Sources/**/*.swift' ':(glob)packages/*/sql/**/*.sql' ':(glob)packages/*/runners/**/*.mjs' ':(glob)agents/**/*.mjs' ':(exclude,glob)agents/**/test/**' | awk -F: '{s+=$NF} END{print NR,s}'
git grep -c '^' 47462cc -- ':(glob)packages/agent-worker/src/local-messaging-*.mjs' ':(glob)packages/agent-worker/src/peer*.mjs' ':(glob)packages/agent-worker/src/peer/*.mjs' ':(glob)packages/peer-engine/src/**/*.rs' | awk -F: '{s+=$NF} END{print NR,s}'
```

For a subsequent commit, replace the revision in both commands. Track separate test directories, documentation, installer and release scripts, and installed bytes separately. If a port adds a language or relocates code, extend the rule to cover the replacement on both revisions before crediting savings.

## Measured feasibility at 47462cc

| Source area | Lines | Repeated physical lines found |
| --- | ---: | ---: |
| Other worker source and runners | 14,039 | 323 |
| macOS helper | 13,366 | 740 |
| Codex and Cursor runtime directories | 12,661 | 1,011 |
| Same-machine messaging and chat adapters | 11,387 | 251 |
| Worker identity and routing | 9,239 | 298 |
| Triangle CLI | 7,148 | 123 |
| Rust peer engine | 3,119 | 0 |
| A2A gateway | 2,939 | 53 |
| Node peer integration | 2,474 | 19 |
| Linux runtime | 1,673 | 19 |
| Client console | 1,005 | 0 |
| Agent entry points | 815 | 21 |
| **Total** | **79,865** | **2,858** |

The worker split assigns the two runtime directories first. Identity and routing includes installation inventory, local chat mapping, reply routes, sender authentication and the transport adapter contract. Same-machine includes local messaging, Claude session and other local chat adapters, and the shared journal and private-path helpers. Peer integration includes the peer directory and peer-prefixed modules. Remaining worker files and runners comprise the first row. These groups partition the baseline; the earlier 31-file transport subset is a separate view.

The repeat scan visits baseline files in path order, compares files with the same extension, and also looks within each file. It strips outer whitespace, matches eight consecutive lines containing at least four lines with letters or digits, extends each match, and counts each later copy once. This includes boilerplate and comments and misses equivalent logic written differently. The 2,858 lines (3.6% of source) measure textual overlap. They carry no automatic deletion credit.

**Tested candidate.** An isolated prototype replaced the Codex and Cursor drain loops (265 + 280 lines) with a 260-line common loop and two 12-line entry points, saving 261 lines. Both existing drain suites passed (26 tests). The prototype retained separate runtime objects, recovery requirements, diagnostics, and status shapes. It did not change the services owning claims or test installed launcher manifests. Landed savings must include the cost of packaging the shared module.

**Other candidates.** A separate pairwise comparison using contiguous blocks of at least four identical lines found 199 matching lines in the two drain service wrappers, 56 in the worker pools and 259 in the two protocol process modules. These counts overlap the global scan. They require individual contract checks before a net estimate. In Swift, 225 repeated lines occur inside ClientSupervisor.swift, which has parallel Codex and Cursor wake preparation as well as launch and marker handling. No replacement has been measured there yet.

**Language opportunity.** The portable credential stores are 137 Swift lines and 256 Node lines. The macOS transaction service and store together occupy 1,249 lines; the Linux transaction and store total 553, with another 277 in its transport. Their responsibilities and callers differ. Even deleting all 1,386 Swift lines across the three named files would cover only 3.5% of the target before replacement and migration costs.

**Merged checkpoint.** PR #203 at `ff35d0f` measures 79,227 application lines across the original 231 files, down 638 from 79,865. Reaching 39,932 requires another 39,295 lines. The merged work covers the shared drain and JSON-RPC session, supervisor wake admission and binding validation, and local and peer cleanup.

**Installed supervisor trace.** The Swift helper prepares the enabled profiles. The Node supervisor CLI validates the bootstrap, constructs one supervisor, waits for activation, and enters its watch loop. Ordinary worker instances use a mailbox client with their runner. Event-driven drains have their own mailbox clients. The installation watch starts from a bound shared app-server profile or a qualifying headless Codex profile. Cursor can join that watch. Same-machine messaging is enabled by its own bootstrap configuration. Direct peer runs through the experimental peer supervisor. The retired Grok webhook is rejected at bootstrap and by the supervisor constructor. Its standalone module still has a package export and appears in installer and launcher manifests. Only the unreachable private CLI validator was removed.

**Recipient trace.** Generic MCP and Claude MCP forward the requested address to server admission. Both now use one implementation for reply-window validation, retry IDs and the receipt. The installed CLI additionally accepts configured profile names and host labels and rejects undiscovered aliases before sending. It now reads the session directory once when checking attached sessions, Grok, and Antigravity. The server still resolves the destination and checks both credential scope and owner ACL before enqueueing. Preserve the CLI distinction between a pre-send refusal and a lost admission receipt.

**Working-tree progress after PR #203.** These changes save 45 additional application lines, bringing the count to 79,182 across the original 231 files.

**Supervisor startup checkpoint.** PR #205 brings the merged count to 79,064. Swift selects ordinary workers from the instance store, resolves their adapter and credential, and supplies the isolated runner environment. A headless profile instead needs a matching provider binding, verified identity, and a passing dedicated-drain check. The Node CLI checks the private bootstrap before reporting readiness. The supervisor creates an ordinary mailbox client and a concurrency-limited command runner, or admits the provider's claimer and constructs a headless drain. Work begins after parent activation.

**Node prototype.** Both CLI and direct supervisor callers now use the same runner environment, app-server binding, and headless list validation. The CLI retains exact wire keys, bounded input, duplicate JSON-key rejection, secret confinement, and cross-lane instance exclusion. Direct callers still receive independent validation. The prototype measures 78,957 application lines across 231 files, 107 below PR #205. A comparison against its parent returned identical serialized results or rejection messages across 901 valid and mutated bootstrap inputs.

**Identity resolution audit after PR #206.** The merged baseline for this slice is 78,957. Installation inventory observes local profiles and custody evidence. Identity inventory projects those observations for diagnostics. A send reads the registry snapshot and the server's recipient directory. The resolver intersects active MESH bindings with local recipients, and the router filters alias visibility and ambiguous candidates by sender permission. A configured chat destination also requires a confirmed mapping for the binding generation and authority, permission to see it, and a matching live session. Inventory observations cannot establish those facts.

The working prototype removes 76 lines by sharing the registry's checks for creating and clearing aliases and destination rules. Each audited write may change only its subject record. It removes another 28 lines by sharing the empty snapshot implementation for missing and unreadable registries while preserving their distinct states and errors. The application count is 78,853 across 231 files.

**Versioned registry readers.** PR #207 landed the identity routing checks at 78,853 application lines. Sharing the v1 and v2 registry header, audit head and binding validation removes a further 223 lines, bringing the count to 78,630. Each version retains its exact field set. Only v2 accepts peer bindings and validates pairings, aliases and destinations. The identity and router suites passed 301 cases, and the old and new readers returned equal records or equal error codes, messages and reasons for 749 valid and mutated inputs.

## Four product guarantees

These are acceptance criteria for the reduced client. The route evidence below identifies differences and an existing gap.

1. **Reach the intended conversation with the owner's permission.** Resolve the destination once. Reject ambiguity, enforce the grant at admission, and scope status and replies to authorized parties. An existing-chat address binds to that chat. Running a headless worker requires an explicitly selected destination or policy.
2. **Acceptance transfers durable custody.** A successful send identifies who owns the pending message and what the receipt means. A caller can distinguish queued mail, a saved reply, and a failure or expiry where the route supports it. A wake or network receipt alone proves only that step.
3. **Retry safely and make uncertainty visible.** Within the route's retention window, an identical submission should recover the existing record and conflicting reuse of its ID should fail. Message deduplication and execution deduplication are separate obligations. For work with side effects, require evidence that replay is safe or expose the uncertain outcome for a decision. The direct Node MESH path currently delegates execution deduplication to its adapter.
4. **Return the saved answer to the original requester.** Bind the reply to the request and participants. Once the answer is durably saved, recover it for local retrieval or retry its delivery without running the agent again.

## What the three routes do today

| Route | Durable custody and recovery boundary |
| --- | --- |
| Same-machine | The local SQLite journal atomically stores a runner's correlated reply and marks execution complete. The requester can pull the reply after restart. Interrupted execution can be held for owner reconciliation. See `local-messaging-journal.mjs`, especially `completeExecutionWithReply`. |
| Direct peer | The Rust engine owns the peer inbox, wire receipts, retries, and expiry. The Node drain persists execution results and tracks reply admission and input acknowledgement across IPC. A held request can be acknowledged to the engine and subsequently retried by an operator. Transport acknowledgement alone cannot tell the sender the runner succeeded. See `peer-drain-service.mjs` and `peer-engine/src/journal.rs`. |
| MESH | The server mailbox can retain work for an offline recipient. Execution recovery depends on the consuming runtime. The direct Node mailbox client explicitly allows at-least-once runner calls and requires adapter deduplication by message or task ID. Verify the relevant consumer before promising safe replay after a crash. See `mailbox-client.mjs`. |

## Order of work

1. Budget each major subsystem against the pinned baseline with a measured size and a named replacement. Even deleting the entire dedicated local and peer subset would fall short of the target. Include the Swift helper, CLI, identity and routing, MESH client, and provider integrations in the budget.
2. Trace suspected unused code through public exports, supported configurations, and installed entry points. Check the Python installer's artifact lists and the Swift launcher's versioned manifest checks before changing a shipped file set. Credit a deletion only when its maintenance burden actually disappears.
3. Compare the Codex and Cursor headless drain loops first. Exercise wake scheduling, concurrent kicks, and shutdown for both before sharing that code. Preserve each service’s profile identity, dedicated claimer owner, LaunchAgent label, and fail-closed sibling probes. Verify that competing services cannot both claim for one profile and that an inconclusive ownership probe prevents a claim. Keep Codex thread/turn operations and Cursor ACP session operations in their respective adapters. Trace address resolution through CLI, MCP, and server to find repeated decisions.
4. Preserve route-specific recovery boundaries. Test a crash before execution, after execution but before a durable result, and after saving the reply but before the caller receives it. For each route, check identical retries, conflicting IDs, authorization, and restart against pre-change data at its own custody boundary. Run the affected package and installation checks. Share a transition only where its observable effects match.

## Language and architecture

Assign one owner to each decision. The router resolves destinations, the transport tracks custody and retry, and the host adapter targets a conversation. Reason Network provides a reference for keeping host-specific plugins small. Its Rust daemon's line count alone cannot predict savings for Triangle.

Start with the same-language drain duplication. For a cross-language candidate, trace private file creation, ownership checks, reads, and replacement in `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/LocalFileCredentialCustody.swift` and `packages/triangle-cli/src/custody.mjs`. Linux uses the latter through `packages/linux-runtime/src/transport.mjs`. Separately compare mailbox transaction recovery in `MailboxTransactionService.swift` and `packages/linux-runtime/src/transaction.mjs`. Keep native Swift responsibilities such as Keychain access and preserve the security boundary of credential-bearing operations. Keep Iroh wire behavior with the existing Rust engine. Evaluate a port on one complete path, counting removed schemas, IPC calls, state transitions, and packaging requirements alongside new code, migration, and compatibility costs. A language change earns credit when the resulting implementation is simpler to operate and verify.
