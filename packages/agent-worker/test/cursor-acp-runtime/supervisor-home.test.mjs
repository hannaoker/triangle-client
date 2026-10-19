import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runtimeEnvForCursorAcpWake} from '../../src/cursor-acp-runtime/headless-drain-service.mjs';
import {createCursorAcpProcess} from '../../src/cursor-acp-runtime/acp-process.mjs';

test('installed Cursor lane resolves private data paths when the Swift supervisor omits HOME', () => {
  const home=realpathSync(mkdtempSync(path.join(process.platform==='win32'?os.tmpdir():'/tmp','tch-')));
  try {
    const source={PATH:process.env.PATH};
    const env=runtimeEnvForCursorAcpWake(source,home);
    assert.equal(env.HOME,home);
    assert.equal(source.HOME,undefined);
    const processOwner=createCursorAcpProcess({cursorHome:path.join(home,'cursor-config'),env});
    assert.equal(processOwner.status().cursorDataDir,path.join(home,'.triangle','cursor-data'));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('explicit Cursor HOME is preserved instead of replaced with the account fallback', () => {
  assert.equal(runtimeEnvForCursorAcpWake({HOME:'/explicit/home'},'/account/home').HOME,'/explicit/home');
});
