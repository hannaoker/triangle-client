# Hermes over Iroh: isolated proof

The approved path is requester → Iroh → local Triangle broker → sandboxed Hermes CLI → broker → Iroh → the same requester. Begin with a same-host proof using separate endpoint identities; this is not a two-computer or cross-network claim.

The trusted controller fetches a fixed PR's metadata and diff using its existing GitHub login. Only that data enters the reasoning request. The reasoning process does not receive GitHub or MESH credentials and does not merge or post a review.

Implementation and acceptance:

1. Recognize the installed Hermes source launcher and its pinned Python/selected dependency generation without evaluating shell text or approving a broad home/root directory. Keep installer and runtime discovery aligned and retain legacy-launcher support.
2. Prepare one isolated Hermes model home with only its selected local provider configuration. Hermes requires its own committed dependency generation in that home; initialize it with a controller preflight, leaving the owner's settings and dependency generation untouched.
3. Add a small proof-only Hermes adapter over the existing runner and sandbox boundary. Send the prompt on stdin via `chat --query-file - --quiet`; reject a CLI that lacks that capability. Keep resource limits and interruption behavior explicit.
4. Verify native sandbox startup, custody-read and project-write denials, basic request/reply, and a read-only assessment of PR #101. Correlate and consume the reply at the actual requesting endpoint.
5. Do not describe a timeout, transport receipt, or direct unsandboxed CLI success as completed work. Preserve failed work as unsettled/quarantined according to the broker contract.

This proof does not install a production service, enroll another MESH identity, change global Hermes configuration, or establish cross-network NAT traversal. Package/service rollout is a separate acceptance step after the proof works.
