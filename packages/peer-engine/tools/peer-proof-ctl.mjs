#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createIpcClient } from './peer-proof-broker.mjs';
export const MAX_INPUT = 65536;
export const MAX_OUTPUT = 2 * 1024 * 1024;
const METHODS = new Set(['hello','status','endpoint_addr','transport_diagnostics','inbox','ack','message_status','send','shutdown']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function parseCommand(raw) {
 if (Buffer.byteLength(raw) > MAX_INPUT) fail('input_too_large');
 let command; try { command = JSON.parse(raw); } catch { fail('invalid_json'); }
 if (!command || Array.isArray(command) || Object.keys(command).sort().join() !== 'method,params' || !METHODS.has(command.method) || !command.params || typeof command.params !== 'object' || Array.isArray(command.params)) fail('invalid_command');
 return command;
}
export async function main(argv, { input=process.stdin, output=process.stdout, error=process.stderr, clientFactory=createIpcClient }={}) {
 try {
  if (argv.length !== 2 || argv[0] !== '--socket' || !path.isAbsolute(argv[1]) || path.resolve(argv[1]) !== argv[1] || /[\x00-\x1f]/.test(argv[1])) fail('usage');
  const chunks=[];let bytes=0;
  for await (const chunk of input) { const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>MAX_INPUT)fail('input_too_large');chunks.push(buffer); }
  const {method,params}=parseCommand(Buffer.concat(chunks).toString('utf8'));
  const result=await clientFactory({socketPath:argv[1],timeoutMs:30000}).request(method,params);
  const encoded=JSON.stringify(result)+'\n';if(Buffer.byteLength(encoded)>MAX_OUTPUT)fail('output_too_large');
  await new Promise((resolve,reject)=>output.write(encoded,e=>e?reject(e):resolve()));
  return 0;
 } catch (e) { const code=['usage','input_too_large','invalid_json','invalid_command','output_too_large'].includes(e.code)?e.code:'ipc_request_failed';error.write(code+'\n');return 1; }
}
try { if (import.meta.url===pathToFileURL(realpathSync(process.argv[1]??'')).href) process.exitCode=await main(process.argv.slice(2)); } catch { /* imported by test */ }
