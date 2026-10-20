# Private IPC proof command helper

The standalone Node helper is `packages/peer-engine/tools/peer-proof-ctl.mjs`.
It uses the broker's exported private Unix IPC client; it never invokes a shell.

```
printf '%s' '{"method":"status","params":{}}' | node packages/peer-engine/tools/peer-proof-ctl.mjs --socket /private/isolated/state/ipc/peer-engine.sock
```

Input must be exactly one JSON object with the two keys `method` and `params`.
`params` must be an object. Supported methods are `hello`, `status`,
`endpoint_addr`, `transport_diagnostics`, `inbox`, `ack`, `message_status`,
`send`, and `shutdown`. The IPC client performs hello automatically for each
request and closes the connection afterwards. Unknown keys/methods are rejected
before connecting. Request data goes through stdin rather than command arguments.

Input is limited to 65,536 UTF-8 bytes, including JSON overhead. A 32 KiB ordinary
text send fits this limit; heavily escaped text can exceed the limit and is
rejected. Output is one JSON result line, bounded to 2 MiB. RPC timeout is 30
seconds. Errors report a fixed code without echoing request content or internal
exception messages. The helper intentionally supports isolated local proof work;
it is not a network control API or a production broker.

For actual-path interpretation, see `TRANSPORT_DIAGNOSTICS.md`. Same-host direct
and public-relay exchanges are preparation, not a two-physical-machine proof.
