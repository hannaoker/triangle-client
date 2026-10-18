/**
 * Filesystem helpers for Triangle-owned migration trees (legacy Cursor
 * session / transcript copy and undo).
 *
 * Containment is PHYSICAL, not lexical: every operation re-resolves the owned
 * anchor with realpath, then walks each path component below it with lstat
 * and rejects any symlink or non-directory ancestor before reading, creating,
 * copying or removing anything. `path.relative` is only used to normalise
 * manifest strings, never as a containment guarantee.
 *
 * Residual limit: Node has no openat()/unlinkat() API, so a hostile writer
 * racing between the check and the syscall is not excluded. Every destructive
 * call re-validates immediately before acting, and callers must run these
 * helpers only while the Cursor ACP drain is stopped.
 *
 * Undo is identity-checked: a file is removed only if its size, mtime and
 * sha256 still equal the snapshot recorded when it was copied. Nothing is ever
 * removed recursively; directories are removed only when empty.
 */

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import path from "node:path";

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** Normalise a manifest-relative path; rejects absolute, empty and `..`. */
export function normalizeOwnedRelative(relative) {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\0")) {
    throw createCodedError("owned_path_invalid", "owned path must be a non-empty relative string");
  }
  if (path.isAbsolute(relative)) {
    throw createCodedError("owned_path_invalid", "owned path must be relative to the owned anchor");
  }
  const parts = relative.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw createCodedError("owned_path_invalid", "owned path must not contain '..'");
  }
  return parts;
}

/**
 * The anchor must be an existing directory whose realpath equals itself
 * (callers pass the already-realpath'd Triangle home / data dir). A swapped
 * anchor (now a symlink or relocated) is rejected.
 */
export function assertOwnedAnchor(anchor) {
  if (typeof anchor !== "string" || !path.isAbsolute(anchor)) {
    throw createCodedError("owned_anchor_invalid", "owned anchor must be an absolute path");
  }
  let real;
  try {
    real = realpathSync(anchor);
  } catch (error) {
    throw createCodedError("owned_anchor_missing", "owned anchor does not exist", { causeCode: error?.code });
  }
  if (real !== path.resolve(anchor)) {
    throw createCodedError("owned_path_symlink_rejected", "owned anchor is not a canonical physical path", {
      anchor,
    });
  }
  const stat = lstatSync(real);
  if (!stat.isDirectory()) {
    throw createCodedError("owned_anchor_invalid", "owned anchor is not a directory");
  }
  return real;
}

/**
 * Walk `relative` below `anchor` component by component. Every ancestor must
 * exist as a real directory (no symlink). The leaf may be missing when
 * `allowMissingLeaf`; missing ancestors are allowed only with
 * `allowMissingAncestors` (they are then reported, not created).
 *
 * Returns { absolute, leaf: Stats|null, missingFrom: index|null }.
 */
export function resolveOwnedPath(anchor, relative, {
  allowMissingLeaf = false,
  allowMissingAncestors = false,
} = {}) {
  const realAnchor = assertOwnedAnchor(anchor);
  const parts = normalizeOwnedRelative(relative);
  let current = realAnchor;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const isLeaf = index === parts.length - 1;
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (isLeaf && allowMissingLeaf) {
        return { absolute: current, leaf: null, missingFrom: index };
      }
      if (!isLeaf && allowMissingAncestors) {
        return { absolute: path.join(realAnchor, ...parts), leaf: null, missingFrom: index };
      }
      throw createCodedError("owned_path_missing", "owned path component is missing", {
        relative: parts.slice(0, index + 1).join("/"),
      });
    }
    if (stat.isSymbolicLink()) {
      throw createCodedError("owned_path_symlink_rejected", "owned path traverses a symlink", {
        relative: parts.slice(0, index + 1).join("/"),
      });
    }
    if (!isLeaf && !stat.isDirectory()) {
      throw createCodedError("owned_path_not_directory", "owned path ancestor is not a directory", {
        relative: parts.slice(0, index + 1).join("/"),
      });
    }
    if (isLeaf) return { absolute: current, leaf: stat, missingFrom: null };
  }
  /* c8 ignore next */
  throw createCodedError("owned_path_invalid", "unreachable");
}

/** Snapshot identity of a regular file (never follows symlinks). */
export function ownedFileIdentity(absolute) {
  const stat = lstatSync(absolute);
  if (!stat.isFile()) {
    throw createCodedError("owned_path_not_file", "identity requires a regular file");
  }
  const sha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  return Object.freeze({ size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
}

export function identitiesEqual(left, right) {
  return (
    left != null &&
    right != null &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256
  );
}

/**
 * Create any missing directories for `relativeDir` below `anchor`, one level
 * at a time (0700), re-validating physical containment after each level.
 * Returns the list of relative directories this call created.
 */
export function ensureOwnedDirectory(anchor, relativeDir) {
  const parts = normalizeOwnedRelative(relativeDir);
  const created = [];
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const relative = parts.slice(0, depth).join("/");
    const resolved = resolveOwnedPath(anchor, relative, { allowMissingLeaf: true });
    if (resolved.leaf == null) {
      mkdirSync(resolved.absolute, { mode: 0o700 });
      created.push(relative);
      const again = resolveOwnedPath(anchor, relative);
      if (!again.leaf.isDirectory()) {
        throw createCodedError("owned_path_not_directory", "created path is not a directory", { relative });
      }
    } else if (!resolved.leaf.isDirectory()) {
      throw createCodedError("owned_path_not_directory", "owned path is not a directory", { relative });
    }
  }
  return created;
}

/**
 * Resolve a copy SOURCE physically: `sourceRelative` below the canonical
 * `sourceAnchor` with every component lstat'ed (no symlinked ancestors, no
 * symlinked leaf). Returns { absolute, stat } of a regular file.
 */
export function resolveOwnedSourceFile(sourceAnchor, sourceRelative) {
  let resolved;
  try {
    resolved = resolveOwnedPath(sourceAnchor, sourceRelative);
  } catch (error) {
    throw createCodedError("owned_source_unsafe", "copy source is not physically contained", {
      causeCode: error?.code ?? null,
    });
  }
  if (!resolved.leaf.isFile()) {
    throw createCodedError("owned_source_unsafe", "copy source must be a regular file");
  }
  return { absolute: resolved.absolute, stat: resolved.leaf };
}

/**
 * Copy a regular source file to `relative` below `anchor` with exclusive
 * create (never overwrites), preserving atime/mtime. Target ancestors are
 * created/validated physically. The source is given either as
 * `{ sourceAnchor, sourceRelative }` (physically validated, preferred) or as a
 * plain `source` path (leaf lstat only). Returns { status, createdDirs, identity }.
 * status: "copied" | "already_present".
 */
export function copyFileIntoOwned({ anchor, relative, source, sourceAnchor, sourceRelative }) {
  let sourceStat;
  if (sourceAnchor != null) {
    ({ absolute: source, stat: sourceStat } = resolveOwnedSourceFile(sourceAnchor, sourceRelative));
  } else {
    sourceStat = lstatSync(source);
  }
  if (!sourceStat.isFile()) {
    throw createCodedError("owned_source_unsafe", "copy source must be a regular file");
  }
  const parts = normalizeOwnedRelative(relative);
  const createdDirs = parts.length > 1 ? ensureOwnedDirectory(anchor, parts.slice(0, -1).join("/")) : [];
  const target = resolveOwnedPath(anchor, parts.join("/"), { allowMissingLeaf: true });
  if (target.leaf != null) {
    return Object.freeze({ status: "already_present", createdDirs, identity: null });
  }
  try {
    copyFileSync(source, target.absolute, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return Object.freeze({ status: "already_present", createdDirs, identity: null });
    }
    // The exclusive create succeeded before the copy failed (e.g. EACCES on a
    // later read, ENOSPC): the partial target is ours, so remove it rather
    // than leave an unrecorded torn file behind. Re-validate first.
    try {
      const partial = resolveOwnedPath(anchor, parts.join("/"), { allowMissingLeaf: true });
      if (partial.leaf?.isFile()) unlinkSync(partial.absolute);
    } catch {
      // Unsafe or vanished: leave it; callers report the failure.
    }
    throw Object.assign(error, { createdDirs });
  }
  // Re-validate before touching metadata: the parent must still be physical.
  const copied = resolveOwnedPath(anchor, parts.join("/"));
  utimesSync(copied.absolute, sourceStat.atime, sourceStat.mtime);
  return Object.freeze({ status: "copied", createdDirs, identity: ownedFileIdentity(copied.absolute) });
}

/**
 * Remove a file below `anchor` only if it is still the exact file that was
 * copied (identity match). Never follows symlinks; never recursive.
 * Returns status: "removed" | "missing" | "modified" | "unsafe_path".
 */
export function removeOwnedFileIfUnchanged({ anchor, relative, identity }) {
  let resolved;
  try {
    resolved = resolveOwnedPath(anchor, relative, { allowMissingLeaf: true, allowMissingAncestors: true });
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("owned_")) {
      return Object.freeze({ status: "unsafe_path", reason: error.code });
    }
    throw error;
  }
  if (resolved.leaf == null) return Object.freeze({ status: "missing" });
  if (!resolved.leaf.isFile()) return Object.freeze({ status: "unsafe_path", reason: "owned_path_not_file" });
  if (identity == null || !identitiesEqual(ownedFileIdentity(resolved.absolute), identity)) {
    return Object.freeze({ status: "modified" });
  }
  // Re-validate the full chain immediately before the destructive call.
  try {
    resolveOwnedPath(anchor, relative);
  } catch (error) {
    return Object.freeze({ status: "unsafe_path", reason: error?.code ?? "owned_path_invalid" });
  }
  unlinkSync(resolved.absolute);
  return Object.freeze({ status: "removed" });
}

/**
 * Remove an empty directory below `anchor` (never recursive, never through a
 * symlink). Returns status: "removed" | "missing" | "not_empty" | "unsafe_path".
 */
export function removeOwnedEmptyDirectory({ anchor, relative }) {
  let resolved;
  try {
    resolved = resolveOwnedPath(anchor, relative, { allowMissingLeaf: true, allowMissingAncestors: true });
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("owned_")) {
      return Object.freeze({ status: "unsafe_path", reason: error.code });
    }
    throw error;
  }
  if (resolved.leaf == null) return Object.freeze({ status: "missing" });
  if (!resolved.leaf.isDirectory()) return Object.freeze({ status: "unsafe_path", reason: "owned_path_not_directory" });
  try {
    rmdirSync(resolved.absolute);
  } catch (error) {
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return Object.freeze({ status: "not_empty" });
    throw error;
  }
  return Object.freeze({ status: "removed" });
}
