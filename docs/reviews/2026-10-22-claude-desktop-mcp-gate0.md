# Claude Desktop MCP launch — Gate 0

Verified 2026-10-22 on the Mini through the Claude desktop Code surface.

## Evidence

Antigravity authored the isolated fixture through installed Triangle request
`claude-m3-gate0-fixture-20261022`. Codex inspected its source and independently
ran `/Users/zhenyuhou/.local/bin/node --test
/private/tmp/triangle-claude-mcp-gate0/probe.test.mjs`: 4 passed, 0 failed.
The unit-test launch marker was renamed before opening the Desktop session.

Project: `/private/tmp/triangle-claude-mcp-gate0`, mode 0700. Its `.mcp.json`
defines only `triangle-session-probe`; no environment overrides or embedded
credentials. Codex selected that directory in a new local Code session and
trusted only the disposable workspace. No global MCP entries were edited.

Scratch chat: **Triangle MCP Gate 0 scratch test**.
Observed Desktop URL: `claude.ai/epitaxy/local_5b7ec8e9-5c48-45f0-8482-d7f1be30e7b8`.
This UI identifier is not asserted to equal the inherited CLI session UUID.

The fresh launch marker timestamp was `2026-10-23T05:06:52.078Z`
(2026-10-22 22:06:52 PDT). Actual MCP tool invocation then returned:

```json
{"sessionIdPresent":true,"sessionUuidValid":true,"socketPathPresent":true,"socketPathAbsolute":true,"tokenPresent":true,"socketExists":true,"socketIsSocket":true,"socketOwned":true,"socketMode":384,"parentExists":true,"parentIsDirectory":true,"parentOwned":true,"parentMode":448}
```

Numeric modes 384 and 448 are octal 0600 and 0700. The tool and marker expose
no token, session ID value, or raw socket path. Claude's visible result matched
the independently read metadata-only launch marker.

## Result and limits

Gate 0 passes for project-scoped MCP discovery, real Desktop child launch,
own-session environment inheritance and a successful metadata MCP call.
This does not establish the full Triangle adapter, identity pairing, durable
Claude wakes, reconnect/rebind behavior or bidirectional acceptance. The earlier
Desktop socket-write canary remains separate evidence. Production was not
upgraded; no Triangle capability was granted to this scratch MCP server.

The Desktop app may persist its own workspace trust/session metadata. This test
does not claim byte-for-byte equality of all application-managed settings.

Official shared-configuration reference:
https://code.claude.com/docs/en/desktop#shared-configuration
