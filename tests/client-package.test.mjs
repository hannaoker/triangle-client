import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
function run(args) {
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
}
function fixture() {
  const dir = mkdtempSync(
    join(realpathSync(tmpdir()), "triangle-package-install-"),
  );
  mkdirSync(join(dir, "home"), { mode: 0o700 });
  const helper = join(dir, "helper");
  writeFileSync(helper, "#!/bin/sh\necho fake-helper\n", { mode: 0o700 });
  const out = join(dir, "out");
  const built = run([
    "scripts/release/build-client-package.mjs",
    "--version",
    "0.1.0-test",
    "--helper",
    helper,
    "--client",
    helper,
    "--node",
    process.execPath,
    "--output",
    out,
    "--test-root",
    dir,
  ]);
  assert.equal(built.status, 0, built.stderr);
  const { archive, installer } = JSON.parse(built.stdout);
  return {
    dir,
    archive,
    installer,
    install: () =>
      spawnSync(
        "/bin/bash",
        [
          installer,
          "--archive",
          archive,
          "--sha256",
          sha(archive),
          "--test-root",
          dir,
        ],
        {
          cwd: dir,
          env: { ...process.env, PATH: "/nonexistent" },
          encoding: "utf8",
        },
      ),
  };
}
test("prebuilt package installs without build tools, stages stopped service and reruns safely", () => {
  const f = fixture();
  try {
    let result = f.install();
    assert.equal(result.status, 0, result.stderr);
    const home = join(f.dir, "home");
    const untouched = join(
      home,
      "Library/Application Support/The Triangle/owner-kept.json",
    );
    writeFileSync(untouched, "existing local identity and harness settings", {
      mode: 0o600,
    });
    assert.ok(existsSync(join(home, ".local/bin/triangle")));
    assert.ok(
      existsSync(
        join(home, "Library/LaunchAgents/dev.thetriangle.client.plist"),
      ),
    );
    assert.ok(
      !existsSync(
        join(
          home,
          "Library/Application Support/The Triangle/client/activate.json",
        ),
      ),
    );
    const wrapper = spawnSync(join(home, ".local/bin/triangle"), ["--help"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(wrapper.status, 0, wrapper.stderr);
    assert.match(wrapper.stdout, /triangle/);
    result = f.install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(untouched, "utf8"),
      "existing local identity and harness settings",
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("archive corruption is rejected before destination mutation", () => {
  const f = fixture();
  try {
    const bytes = readFileSync(f.archive);
    bytes[25] ^= 1;
    writeFileSync(f.archive, bytes);
    const result = spawnSync(
      "/bin/bash",
      [
        "scripts/install.sh",
        "--archive",
        f.archive,
        "--sha256",
        "0".repeat(64),
        "--test-root",
        f.dir,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(join(f.dir, "home/Library")));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("existing unrelated wrapper and symlink ancestor are rejected without overwrite", () => {
  for (const type of ["wrapper", "ancestor"]) {
    const f = fixture();
    try {
      const home = join(f.dir, "home");
      if (type === "wrapper") {
        mkdirSync(join(home, ".local/bin"), { recursive: true, mode: 0o700 });
        writeFileSync(join(home, ".local/bin/triangle"), "unrelated", {
          mode: 0o700,
        });
      } else {
        mkdirSync(join(f.dir, "elsewhere"));
        symlinkSync(join(f.dir, "elsewhere"), join(home, "Library"));
      }
      const result = f.install();
      assert.notEqual(result.status, 0);
      if (type === "wrapper")
        assert.equal(
          readFileSync(join(home, ".local/bin/triangle"), "utf8"),
          "unrelated",
        );
      assert.ok(
        !existsSync(
          join(
            home,
            "Library/Application Support/The Triangle/bin/triangle-mailbox",
          ),
        ),
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});
function tarGz(entries) {
  const chunks = [];
  for (const {
    path,
    type = "0",
    data = Buffer.alloc(0),
    size = data.length,
  } of entries) {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "ascii");
    header.write("0000600\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write("ustar\0", 257, 6);
    header.write(
      [...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
      8,
    );
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
import { gzipSync } from "node:zlib";
test("bootstrap rejects traversal, symlinks, duplicate names and expansion bombs before execution", () => {
  const rootDir = mkdtempSync(
    join(realpathSync(tmpdir()), "triangle-package-install-"),
  );
  mkdirSync(join(rootDir, "home"), { mode: 0o700 });
  try {
    const cases = [
      { entries: [{ path: "../escape" }], error: /Unsafe archive path/ },
      {
        entries: [{ path: "bin/node", type: "2" }],
        error: /Only regular files/,
      },
      {
        entries: [{ path: "same" }, { path: "same" }],
        error: /Duplicate archive path/,
      },
      {
        entries: [{ path: "huge", size: 1024 * 1024 * 1024 + 1 }],
        error: /Expanded archive is too large/,
      },
    ];
    for (const [i, item] of cases.entries()) {
      const archive = join(rootDir, `unsafe-${i}.tgz`);
      writeFileSync(archive, tarGz(item.entries));
      const result = spawnSync(
        "/bin/bash",
        [
          "scripts/install.sh",
          "--archive",
          archive,
          "--sha256",
          sha(archive),
          "--test-root",
          rootDir,
        ],
        { cwd: root, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, item.error);
      assert.ok(!existsSync(join(rootDir, "home/Library")));
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
test("bootstrap rejects manifest hash mismatch and foreign platform before bundled code runs", () => {
  const dir = mkdtempSync(
    join(realpathSync(tmpdir()), "triangle-package-install-"),
  );
  mkdirSync(join(dir, "home"), { mode: 0o700 });
  try {
    for (const wrong of ["hash", "arch"]) {
      const node = Buffer.from("#!/bin/sh\ntouch SHOULD_NOT_RUN\n");
      const manifest = {
        schema: 1,
        version: "1.0.0",
        platform: "darwin",
        arch: wrong === "arch" ? "foreign" : process.arch,
        signingMode: "public_ad_hoc",
        credentialCustody: "file",
        testOnly: true,
        files: [
          {
            path: "bin/node",
            size: node.length,
            mode: 0o700,
            sha256:
              wrong === "hash"
                ? "0".repeat(64)
                : createHash("sha256").update(node).digest("hex"),
          },
        ],
      };
      const archive = join(dir, wrong + ".tgz");
      writeFileSync(
        archive,
        tarGz([
          {
            path: "package-manifest.json",
            data: Buffer.from(JSON.stringify(manifest)),
          },
          { path: "bin/node", data: node },
        ]),
      );
      const result = spawnSync(
        "/bin/bash",
        [
          "scripts/install.sh",
          "--archive",
          archive,
          "--sha256",
          sha(archive),
          "--test-root",
          dir,
        ],
        { cwd: root, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        wrong === "hash"
          ? /Manifest metadata mismatch/
          : /Unsupported package platform/,
      );
      assert.ok(!existsSync(join(dir, "home/Library")));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
function legacyInstall(f, { corrupt = false, custom = false } = {}) {
  const home = join(f.dir, "home"),
    app = join(home, "Library/Application Support/The Triangle");
  for (const dir of [
    app,
    join(app, "bin"),
    join(app, "install-manifest"),
    join(home, ".local/bin"),
  ])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ["triangle-mailbox", "triangle-client"]) {
    const binary = join(app, "bin", name);
    writeFileSync(binary, "legacy binary", { mode: 0o700 });
    const digest = sha(binary);
    writeFileSync(
      join(app, "install-manifest", name + ".sha256"),
      digest + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(app, "install-manifest", name + "-install.json"),
      JSON.stringify({
        version: 1,
        signingMode: "public_ad_hoc",
        credentialCustody: "file",
        sha256: digest,
      }),
      { mode: 0o600 },
    );
    if (corrupt) writeFileSync(binary, "changed binary");
  }
  const target = join(app, "bin/triangle");
  writeFileSync(
    target,
    custom
      ? "#!/bin/sh\necho custom\n"
      : `#!/bin/bash\nexec ${home}/.hermes/node/bin/node "${app}/owner-cli/src/cli.mjs" "$@"\n`,
    { mode: 0o700 },
  );
  symlinkSync(target, join(home, ".local/bin/triangle"));
  return { app, target };
}
test("verified legacy public/file install and its exact CLI symlink upgrade preserving user state", () => {
  const f = fixture();
  try {
    const { app } = legacyInstall(f);
    const state = join(app, "identity-kept");
    writeFileSync(state, "keep", { mode: 0o600 });
    let result = f.install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(state, "utf8"), "keep");
    result = f.install();
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("legacy hash mismatch or custom CLI wrapper refuses upgrade without replacing binaries", () => {
  for (const kind of ["corrupt", "custom"]) {
    const f = fixture();
    try {
      const { app, target } = legacyInstall(f, { [kind]: true });
      const before = readFileSync(join(app, "bin/triangle-mailbox"));
      const wrapperBefore = readFileSync(target);
      const result = f.install();
      assert.notEqual(result.status, 0);
      assert.deepEqual(readFileSync(join(app, "bin/triangle-mailbox")), before);
      assert.deepEqual(readFileSync(target), wrapperBefore);
      assert.ok(!existsSync(join(app, "package-install.json")));
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});
test("builder refuses an output archive symlink without following it", () => {
  const f = fixture();
  try {
    const output = join(f.dir, "hostile-output");
    mkdirSync(output, { mode: 0o700 });
    const victim = join(f.dir, "unrelated-victim");
    symlinkSync(
      victim,
      join(output, `triangle-client-0.1.0-test-darwin-${process.arch}.tar.gz`),
    );
    const result = run([
      "scripts/release/build-client-package.mjs",
      "--version",
      "0.1.0-test",
      "--helper",
      join(f.dir, "helper"),
      "--client",
      join(f.dir, "helper"),
      "--node",
      process.execPath,
      "--output",
      output,
      "--test-root",
      f.dir,
    ]);
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(victim));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
