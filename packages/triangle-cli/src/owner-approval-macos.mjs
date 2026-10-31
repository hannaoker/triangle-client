// Selected only by an explicit owner-command package capability. Executable/hash
// are trusted release inputs, never arguments supplied by a peer or approval JSON.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from './canonical.mjs';
import { normalizeOwnerOperation, describeOwnerOperation } from './owner-approval.mjs';

function frame(challenge, now) {
  const {request,digest,summary} = challenge ?? {};
  if (!request || request.schema !== 'owner_operation_v1' || typeof request.nonce !== 'string' || request.nonce.length !== 64 || !/^[a-f0-9]{64}$/.test(request.nonce) ||
      !Number.isSafeInteger(request.issuedAt) || !Number.isSafeInteger(request.deadline) ||
      request.deadline <= request.issuedAt || request.deadline-request.issuedAt > 120000 ||
      now < request.issuedAt || now >= request.deadline) return null;
  const {schema,nonce,issuedAt,deadline,...raw} = request;
  const op = normalizeOwnerOperation(raw);
  const canonicalRequest = canonicalJson(request);
  if (typeof digest !== 'string' || createHash('sha256').update(canonicalRequest).digest('hex') !== digest ||
      summary !== describeOwnerOperation(op)) return null;
  const data = JSON.stringify({version:1,canonicalRequest,digest,nonce,summary,timeoutMs:deadline-now});
  return Buffer.byteLength(data) <= 16384 ? data : null;
}

export function createMacOSOwnerApprovalProvider({ executable, sha256, platform = process.platform,
  clockMs = () => Math.floor(performance.now()), killGraceMs = 250 } = {}) {
  return Object.freeze({ async authenticate(challenge,{signal}={}) {
    if (signal?.aborted) return 'cancelled';
    let input,remaining;
    try {
      const now = clockMs();
      if (platform !== 'darwin' || !Number.isSafeInteger(now) || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 1000 ||
          typeof executable !== 'string' || !path.isAbsolute(executable) || realpathSync(executable) !== executable ||
          typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return 'unavailable';
      const stat = lstatSync(executable);
      if (!stat.isFile() || stat.size > 32*1024*1024 || stat.uid !== process.getuid() || stat.nlink !== 1 ||
          (stat.mode & 0o077) !== 0 || (stat.mode & 0o500) !== 0o500 ||
          createHash('sha256').update(readFileSync(executable)).digest('hex') !== sha256) return 'unavailable';
      // Hashing and filesystem checks can consume the remaining approval window.
      const dispatchNow=clockMs();
      if (!Number.isSafeInteger(dispatchNow) || dispatchNow < now) return 'unavailable';
      input = frame(challenge,dispatchNow);
      if (!input) return 'unavailable';
      remaining=challenge.request.deadline-dispatchNow;
    } catch { return 'unavailable'; }
    return await new Promise(resolve => {
      let child,timer,killTimer,onAbort,forced=null,output='',size=0,finished=false;
      const finish = outcome => {
        if (finished) return;finished=true;clearTimeout(timer);clearTimeout(killTimer);
        signal?.removeEventListener('abort',onAbort);resolve(outcome);
      };
      const stop = outcome => {
        if (finished || forced) return;forced=outcome;
        try { child.kill('SIGTERM'); } catch {}
        killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},killGraceMs);
      };
      try {
        child=spawn(executable,['--authenticate'],{cwd:path.dirname(executable),
          env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:['pipe','pipe','ignore']});
      } catch { finish('unavailable');return; }
      onAbort=()=>stop('cancelled');signal?.addEventListener('abort',onAbort,{once:true});
      child.on('error',()=>{if(!forced)forced='unavailable';});
      child.stdin.on('error',()=>stop('unavailable'));
      child.stdout.on('data',chunk=>{
        size+=chunk.length;if(size>4096){stop('unavailable');return;}output+=chunk.toString('utf8');
      });
      child.on('close',code=>{
        if (forced) {finish(forced);return;}
        try {
          const response=JSON.parse(output);
          if (code!==0 || canonicalJson(response)!==output.trim() ||
              Object.keys(response).sort().join(',')!=='digest,nonce,outcome,version' || response.version!==1 ||
              response.digest!==challenge.digest || response.nonce!==challenge.request.nonce ||
              !['approved','denied','cancelled','unavailable'].includes(response.outcome)) {finish('unavailable');return;}
          finish(response.outcome);
        } catch {finish('unavailable');}
      });
      timer=setTimeout(()=>stop('unavailable'),remaining);
      if (signal?.aborted) {stop('cancelled');child.stdin.end();return;}
      child.stdin.end(input);
    });
  }});
}
