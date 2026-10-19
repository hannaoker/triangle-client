// Setup never accepts an invitation in argv: terminals hide it and files must be private.
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { LocalStateError } from './errors.mjs';

export function readPrivateInvite(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new LocalStateError('Invite file must be a private regular file owned by you (chmod 600), at most 16 KiB.');
    }
    const link = readFileSync(fd, 'utf8').trim();
    if (!link || /[\r\n]/.test(link)) throw new LocalStateError('Invite file must contain one invitation link.');
    return link;
  } catch (error) {
    if (error instanceof LocalStateError) throw error;
    throw new LocalStateError('Cannot read the private invite file. Use a regular file with mode 600.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function createSetupPrompts({ input = process.stdin, output = process.stderr } = {}) {
  const requireTerminal = () => {
    if (!input.isTTY || !output.isTTY) throw new LocalStateError('Interactive setup needs a terminal. Supply --profile, --harness and a private --invite-file (or --identity-only).');
  };
  return {
    async ask(label, fallback = '') {
      requireTerminal();
      const rl = createInterface({ input, output });
      try { return (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback; }
      finally { rl.close(); }
    },
    async invite() {
      requireTerminal();
      output.write('Invitation link (hidden): ');
      return new Promise((resolve, reject) => {
        const previousRaw = input.isRaw;
        let value = '';
        const cleanup = () => { input.removeListener('data', data); input.removeListener('end', ended); input.setRawMode(previousRaw); input.pause(); output.write('\n'); };
        const ended = () => { cleanup(); reject(new LocalStateError('Invitation input ended; nothing was enrolled.')); };
        const data = (chunk) => {
          for (const char of chunk.toString('utf8')) {
            if (char === '\u0003' || char === '\u0004') { cleanup(); reject(new LocalStateError('Setup cancelled.')); return; }
            if (char === '\r' || char === '\n') { cleanup(); resolve(value.trim()); return; }
            if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
            else if (char >= ' ') value += char;
            if (value.length > 16384) { cleanup(); reject(new LocalStateError('Invitation input is too long.')); return; }
          }
        };
        input.setRawMode(true);
        input.on('data', data);
        input.once('end', ended);
        input.resume();
      });
    },
  };
}
