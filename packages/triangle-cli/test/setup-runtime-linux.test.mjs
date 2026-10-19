import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveNativeCodex } from '../src/setup-runtime-linux.mjs';
test('official npm Codex launcher resolves native optional platform package without executing JavaScript', () => {
 const root=mkdtempSync(path.join(tmpdir(),'triangle-codex-discover-'));
 try {
 const packageRoot=path.join(root,'@openai/codex');mkdirSync(path.join(packageRoot,'bin'),{recursive:true,mode:0o700});
 writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({name:'@openai/codex'}),{mode:0o600});
 const launcher=path.join(packageRoot,'bin/codex.js');writeFileSync(launcher,'throw Error("must not run")',{mode:0o700});
 const native=path.join(root,'@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex');mkdirSync(path.dirname(native),{recursive:true,mode:0o700});writeFileSync(native,Buffer.from([127,69,76,70]),{mode:0o700});
 assert.equal(resolveNativeCodex(launcher,'arm64'),realpathSync(native));
 writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({name:'untrusted'}),{mode:0o600});
 assert.throws(()=>resolveNativeCodex(launcher,'arm64'),/Unsupported Codex launcher/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
