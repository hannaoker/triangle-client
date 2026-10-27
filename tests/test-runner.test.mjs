import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {selectSuites, suites} from '../scripts/run-all-tests.mjs';

test('test groups partition all suites and keep local lifecycle checks out of gateways',()=>{
 const runtime=selectSuites('runtime'),gateway=selectSuites('gateway');
 assert.deepEqual(gateway.map(s=>s.name).sort(),['a2a-gateway','agents/codex','agents/hermes']);
 assert.equal(new Set([...runtime,...gateway]).size,suites.length);
 assert.ok(runtime.some(s=>s.name==='macos-mailbox-helper host'));
 assert.ok(runtime.some(s=>s.name==='peer-proof-hermes'));
 assert.deepEqual(selectSuites(),suites);
});

test('unknown test group fails before executing any suite',()=>{
 assert.throws(()=>selectSuites('typo'),RangeError);
 const r=spawnSync(process.execPath,['scripts/run-all-tests.mjs','typo'],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
 assert.equal(r.status,64);assert.match(r.stderr,/Usage:/);assert.equal(r.stdout,'');
});
