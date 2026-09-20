#!/usr/bin/env node
/**
 * Generate / re-pin packages/agent-worker/src/codex-runtime/manifest/runtime-manifest.json.
 *
 * Prefers a local bundled Codex binary when available. Falls back to a pinned
 * upstream App Server v2 JSON Schema artifact (documented gap for Mini re-pin).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultOut = path.resolve(
  here,
  "../src/codex-runtime/manifest/runtime-manifest.json",
);

function parseArgs(argv) {
  const out = {
    out: defaultOut,
    codexBin: null,
    schemaUrl: null,
    schemaFile: null,
    sourceCommit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--out" && next) {
      out.out = path.resolve(next);
      i += 1;
    } else if (arg === "--codex-bin" && next) {
      out.codexBin = next;
      i += 1;
    } else if (arg === "--schema-url" && next) {
      out.schemaUrl = next;
      i += 1;
    } else if (arg === "--schema-file" && next) {
      out.schemaFile = path.resolve(next);
      i += 1;
    } else if (arg === "--source-commit" && next) {
      out.sourceCommit = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`Usage: generate-codex-runtime-manifest.mjs [options]

  --codex-bin <path>       Preferred: bundled Codex binary (Mini Darwin)
  --schema-file <path>     Local v2 schemas JSON
  --schema-url <url>       Remote v2 schemas JSON
  --source-commit <sha>    Provenance commit for schema artifact
  --out <path>             Output manifest path
`);
      process.exit(0);
    }
  }
  return out;
}

function extractAllowlists(schema) {
  const defs = schema.definitions ?? schema.$defs ?? {};
  const ask = defs.AskForApproval;
  const sandboxMode = defs.SandboxMode;
  const sandboxPolicy = defs.SandboxPolicy;
  if (!ask || !sandboxMode || !sandboxPolicy) {
    throw new Error("schema missing AskForApproval, SandboxMode, or SandboxPolicy");
  }

  const stringEnumAllowlist = [];
  let objectFormsAllowed = [];
  for (const branch of ask.oneOf ?? [ask]) {
    if (Array.isArray(branch.enum)) {
      stringEnumAllowlist.push(...branch.enum);
    } else if (branch.properties?.granular) {
      objectFormsAllowed = ["granular"];
    }
  }

  const sandboxModeAllowlist = Array.isArray(sandboxMode.enum) ? [...sandboxMode.enum] : [];
  const typeAllowlist = [];
  for (const branch of sandboxPolicy.oneOf ?? []) {
    const typeEnum = branch.properties?.type?.enum;
    if (Array.isArray(typeEnum)) typeAllowlist.push(...typeEnum);
  }

  if (stringEnumAllowlist.length === 0 || sandboxModeAllowlist.length === 0) {
    throw new Error("failed to extract enum allowlists from schema");
  }

  return {
    approvalPolicy: {
      schemaDefinition: "AskForApproval",
      threadStartField: "approvalPolicy",
      stringEnumAllowlist,
      objectFormsAllowed,
      headlessDefault: "never",
      headlessAllowlist: stringEnumAllowlist.includes("never") ? ["never"] : [stringEnumAllowlist[0]],
    },
    sandboxMode: {
      schemaDefinition: "SandboxMode",
      threadStartField: "sandbox",
      stringEnumAllowlist: sandboxModeAllowlist,
      headlessDefault: sandboxModeAllowlist.includes("workspace-write")
        ? "workspace-write"
        : sandboxModeAllowlist[0],
      headlessAllowlist: sandboxModeAllowlist.filter((value) => value !== "danger-full-access"),
    },
    sandboxPolicy: {
      schemaDefinition: "SandboxPolicy",
      turnStartField: "sandboxPolicy",
      typeAllowlist,
      headlessTypeAllowlist: typeAllowlist.filter(
        (value) => value === "readOnly" || value === "workspaceWrite",
      ),
    },
  };
}

async function loadSchema(options) {
  if (options.schemaFile) {
    const text = await readFile(options.schemaFile, "utf8");
    return {
      schema: JSON.parse(text),
      provenance: {
        source: "local-schema-file",
        artifact: options.schemaFile,
        sourceCommit: options.sourceCommit,
        sourceUrl: null,
        bundledCodexBinary: options.codexBin,
        generationMode: "local-schema-file",
        gap: options.codexBin
          ? null
          : "Generated without a bundled Codex binary; Mini should re-pin from ChatGPT.app Resources/codex.",
      },
    };
  }

  if (options.codexBin) {
    const version = spawnSync(options.codexBin, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    const versionText = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim() || null;
    // Bundled Codex does not yet expose a stable schema dump CLI in all builds.
    // Prefer an explicit schema file/url alongside the binary version stamp.
    if (!options.schemaUrl) {
      throw new Error(
        "bundled Codex binary provided but no --schema-url/--schema-file; pass the matching v2 schema artifact for this Codex version",
      );
    }
    const response = await fetch(options.schemaUrl);
    if (!response.ok) {
      throw new Error(`failed to fetch schema: HTTP ${response.status}`);
    }
    return {
      schema: await response.json(),
      provenance: {
        source: "bundled-codex-binary + schema artifact",
        artifact: options.schemaUrl,
        sourceCommit: options.sourceCommit,
        sourceUrl: options.schemaUrl,
        bundledCodexBinary: {
          path: options.codexBin,
          version: versionText,
        },
        generationMode: "bundled-binary-version + schema-artifact",
        gap: null,
      },
    };
  }

  const commit = options.sourceCommit ?? "2f34d236f533f5248263628e44d474616e545494";
  const url =
    options.schemaUrl ??
    `https://raw.githubusercontent.com/openai/codex/${commit}/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch schema: HTTP ${response.status}`);
  }
  return {
    schema: await response.json(),
    provenance: {
      source: "openai/codex app-server-protocol schema artifact",
      artifact: "codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json",
      sourceCommit: commit,
      sourceUrl: url,
      bundledCodexBinary: null,
      generationMode: "pinned-schema-artifact",
      gap: "No bundled Codex binary in this environment. Mini must re-pin from the exact local bundled binary before Phase 1.",
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { schema, provenance } = await loadSchema(options);
  const allowlists = extractAllowlists(schema);

  let previous = null;
  try {
    previous = JSON.parse(await readFile(options.out, "utf8"));
  } catch {
    previous = null;
  }

  const manifest = {
    manifestVersion: 1,
    immutable: true,
    generatedAt: new Date().toISOString(),
    provenance,
    protocol: previous?.protocol ?? {
      transport: "stdio-ndjson",
      listenDefault: "stdio://",
      jsonrpcVersion: "2.0",
      methods: [
        "initialize",
        "initialized",
        "thread/start",
        "thread/resume",
        "thread/read",
        "turn/start",
        "turn/interrupt",
      ],
    },
    ...allowlists,
    correlation: previous?.correlation ?? {
      preferredField: "clientUserMessageId",
      preferredFieldLocation: "turn/start params",
      survivesThreadReadAs:
        "thread.turns[].items[] userMessage.clientId (schema-supported; live survival unproved on Mini)",
      fallback: "input-preamble",
      preamblePattern: "^\\[\\[triangle-corr:([A-Za-z0-9._:-]{8,128})\\]\\]\\n",
      liveSurvivalStatus: "blocked-needs-mini-darwin",
    },
    sharedHomeConcurrency: previous?.sharedHomeConcurrency ?? {
      status: "unproved",
      forcedPoolSize: 1,
      desktopHandoffEnabled: false,
      fallbackToUserCodexHomeForbidden: true,
    },
    featureFlags: previous?.featureFlags ?? {
      helperConversationStore: false,
      headlessRuntime: false,
      desktopHandoff: false,
    },
  };

  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${options.out}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
