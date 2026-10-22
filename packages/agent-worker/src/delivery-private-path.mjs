import path from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";

export const coded = (code) => Object.assign(new Error(code), { code });

export function ancestors(root) {
  let p = path.parse(root).root;
  for (const part of root.slice(p.length).split(path.sep).filter(Boolean)) {
    p = path.join(p, part);
    const s = lstatSync(p, { throwIfNoEntry: false });
    if (
      s &&
      (s.isSymbolicLink() ||
        !s.isDirectory() ||
        ![0, process.getuid()].includes(s.uid) ||
        (s.mode & 0o022 && !(s.mode & 0o1000 && s.uid === 0)))
    ) {
      throw coded("unsafe_path");
    }
  }
}

export function privateDir(root, { create = false } = {}) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    throw coded("unsafe_path");
  }
  ancestors(root);
  if (create && !existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  if (realpathSync(root) !== root) {
    throw coded("unsafe_path");
  }
  const s = lstatSync(root);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o077) !== 0) {
    throw coded("unsafe_path");
  }
}

export function privateFile(file) {
  const s = lstatSync(file, { throwIfNoEntry: false });
  if (
    s &&
    (!s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      s.uid !== process.getuid() ||
      (s.mode & 0o077) !== 0)
  ) {
    throw coded("unsafe_path");
  }
}
