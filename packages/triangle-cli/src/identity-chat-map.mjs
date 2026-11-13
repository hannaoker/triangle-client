// Owner-only CLI bridge for D4 local chat mappings (`client/local/chat-mappings-v1.json`).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical.mjs';
import {
  AGENT_ID_PATTERN,
  DESTINATION_HARNESSES,
  SELECTOR_ID_PATTERN,
  isValidWorkspacePath,
} from '../../agent-worker/src/identity-primitives.mjs';
import { readIdentityRegistry } from '../../agent-worker/src/identity-registry.mjs';
import {
  SESSION_ADDRESS_PATTERN,
  confirmChatMapping,
  deriveChatSelectorId,
  readChatMappings,
} from '../../agent-worker/src/local-chat-mapping.mjs';
import { createOwnerApprovalCoordinator, describeOwnerOperation, normalizeOwnerOperation } from './owner-approval.mjs';
import { loadPackagedOwnerApprovalProvider } from './owner-approval-package.mjs';
import { createChatMappingApprovalAdapter } from './owner-approval-registry.mjs';

function fail(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  throw error;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertAbsDir(dirPath) {
  if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath) || path.resolve(dirPath) !== dirPath) {
    fail('invalid_owner_operation');
  }
}

function resolveSelectorId({ selectorId = null, harness = null, workspace = null }) {
  if (selectorId !== null && selectorId !== undefined) {
    if (typeof selectorId !== 'string' || !SELECTOR_ID_PATTERN.test(selectorId)) {
      fail('invalid_owner_operation');
    }
    return selectorId;
  }
  if (!DESTINATION_HARNESSES.includes(harness) || !isValidWorkspacePath(workspace)) {
    fail('invalid_owner_operation');
  }
  return deriveChatSelectorId({ harness, workspace });
}

function findActiveMeshBinding(registry, principalId) {
  const bindings = Object.values(registry?.bindings ?? {});
  const active = bindings.filter(
    (b) => b && b.principal_id === principalId && b.revoked_at === null
  );
  if (active.length === 0) fail('identity_binding_not_active');
  const mesh = active.filter((b) => b.trust_mode === 'mesh-managed');
  if (mesh.length === 0) fail('identity_binding_not_supported');
  return mesh.sort((a, b) => (b.binding_generation ?? 0) - (a.binding_generation ?? 0))[0];
}

export async function discoverLiveAttachedSessions({ storeRoot, now = Date.now() }) {
  const dbPath = path.join(storeRoot, 'local-messaging.db');
  if (!fs.existsSync(dbPath)) return [];
  const { createLocalMessagingJournal } = await import('../../agent-worker/src/local-messaging-journal.mjs');
  const journal = createLocalMessagingJournal({ stateRoot: storeRoot });
  try {
    return await journal.listAllLiveAttachedSessions(now);
  } finally {
    await journal.close?.();
  }
}

export function loadPackagedChatMapProvider({ command, releaseRoot, platform = process.platform } = {}) {
  return loadPackagedOwnerApprovalProvider({ command, releaseRoot, platform });
}

export function planChatMapSet({ storeRoot, registryRoot, principal, harness, workspace }) {
  assertAbsDir(storeRoot);
  assertAbsDir(registryRoot);
  if (typeof principal !== 'string' || !AGENT_ID_PATTERN.test(principal) ||
      !DESTINATION_HARNESSES.includes(harness) || !isValidWorkspacePath(workspace)) {
    fail('invalid_owner_operation');
  }
  const regRead = readIdentityRegistry({ root: registryRoot });
  if (regRead.state !== 'ok') fail('identity_registry_unavailable');
  const binding = findActiveMeshBinding(regRead.registry, principal);

  const canonicalWorkspace = fs.realpathSync(workspace);
  const selectorId = deriveChatSelectorId({ harness, workspace: canonicalWorkspace });
  const store = readChatMappings({ storeRoot });
  const existing = Object.values(store.mappings);
  if (store.mappings[selectorId] || existing.some((e) => e.harness === harness && e.workspace === canonicalWorkspace)) {
    fail('chat_mapping_exists');
  }
  if (existing.some((e) => e.principalId === principal)) {
    fail('chat_mapping_principal_exists');
  }

  const operation = normalizeOwnerOperation({
    action: 'chat.map.set',
    storeRoot,
    expectedSequence: store.sequence,
    selectorId,
    harness,
    workspace: canonicalWorkspace,
    principalId: principal,
    authorityOrigin: binding.authority_origin,
    bindingGeneration: binding.binding_generation,
    before: null,
  });
  const body = {
    schema: 'identity_chat_map_plan_v1',
    action: 'set',
    scope: 'local-chat-mapping',
    registryRoot,
    operation,
  };
  return Object.freeze({ ...body, planId: sha256Hex(canonicalJson(body)) });
}

export async function planChatMapConfirm({
  storeRoot,
  selectorId = null,
  harness = null,
  workspace = null,
  attachedSessions = null,
  now = () => Date.now(),
}) {
  assertAbsDir(storeRoot);
  const resolvedId = resolveSelectorId({ selectorId, harness, workspace });
  const store = readChatMappings({ storeRoot });
  const entry = store.mappings[resolvedId];
  if (!entry) fail('chat_mapping_not_found');
  if (entry.state === 'confirmed') fail('chat_mapping_already_confirmed');

  const live = attachedSessions ?? await discoverLiveAttachedSessions({ storeRoot, now: now() });
  const matches = live.filter(
    (s) => s && s.harness === entry.harness && s.workspace === entry.workspace && SESSION_ADDRESS_PATTERN.test(s.address ?? '')
  );
  if (matches.length === 0) fail('chat_mapping_no_live_session');
  if (matches.length > 1) fail('chat_mapping_ambiguous_session');

  const body = {
    schema: 'identity_chat_map_confirm_plan_v1',
    action: 'confirm',
    scope: 'local-chat-mapping',
    storeRoot,
    expectedSequence: store.sequence,
    selectorId: resolvedId,
    harness: entry.harness,
    workspace: entry.workspace,
    principalId: entry.principalId,
    sessionAddress: matches[0].address,
  };
  return Object.freeze({ ...body, planId: sha256Hex(canonicalJson(body)) });
}

export function planChatMapRevoke({ storeRoot, selectorId = null, harness = null, workspace = null }) {
  assertAbsDir(storeRoot);
  const resolvedId = resolveSelectorId({ selectorId, harness, workspace });
  const store = readChatMappings({ storeRoot });
  const entry = store.mappings[resolvedId];
  if (!entry) fail('chat_mapping_not_found');

  const operation = normalizeOwnerOperation({
    action: 'chat.map.revoke',
    storeRoot,
    expectedSequence: store.sequence,
    selectorId: resolvedId,
    before: {
      harness: entry.harness,
      workspace: entry.workspace,
      principalId: entry.principalId,
      authorityOrigin: entry.authorityOrigin,
      bindingGeneration: entry.bindingGeneration,
    },
  });
  const body = {
    schema: 'identity_chat_map_plan_v1',
    action: 'revoke',
    scope: 'local-chat-mapping',
    operation,
  };
  return Object.freeze({ ...body, planId: sha256Hex(canonicalJson(body)) });
}

function assertConfirmMatches(confirm, planId) {
  if (typeof confirm !== 'string' || confirm.length !== 64 || !/^[a-f0-9]{64}$/.test(confirm)) {
    fail('confirmation_mismatch');
  }
  if (confirm !== planId) fail('plan_stale');
}

export async function identityChatMapSet({
  storeRoot,
  registryRoot,
  principal,
  harness,
  workspace,
  confirm = null,
  provider,
  releaseRoot,
  now,
  signal,
  onOperation = () => {},
}) {
  const plan = planChatMapSet({ storeRoot, registryRoot, principal, harness, workspace });
  if (confirm === null) return plan;
  assertConfirmMatches(confirm, plan.planId);
  const coordinator = createOwnerApprovalCoordinator({
    provider: provider ?? loadPackagedChatMapProvider({ command: 'chat.map.set', releaseRoot }),
    withLockedRegistry: createChatMappingApprovalAdapter(plan.operation, { now }),
  });
  await onOperation(describeOwnerOperation(plan.operation));
  const result = await coordinator.execute(coordinator.prepare(plan.operation), { signal });
  return {
    schema: 'identity_chat_map_result_v1',
    action: 'set',
    scope: 'local-chat-mapping',
    selectorId: plan.operation.selectorId,
    principal: plan.operation.principalId,
    harness: plan.operation.harness,
    workspace: plan.operation.workspace,
    state: 'pending',
    sequence: result.registry.sequence,
  };
}

export async function identityChatMapConfirm({
  storeRoot,
  selectorId = null,
  harness = null,
  workspace = null,
  attachedSessions = null,
  confirm = null,
  isTty = Boolean(process.stdin?.isTTY && process.stdout?.isTTY),
  now,
}) {
  const plan = await planChatMapConfirm({ storeRoot, selectorId, harness, workspace, attachedSessions });
  if (confirm === null) return plan;
  assertConfirmMatches(confirm, plan.planId);
  if (!isTty) fail('owner_tty_required');

  const live = attachedSessions ?? await discoverLiveAttachedSessions({ storeRoot });
  const updated = confirmChatMapping({
    storeRoot,
    selectorId: plan.selectorId,
    attachedSessions: live,
    expectedSequence: plan.expectedSequence,
    now,
  });
  const entry = updated.mappings[plan.selectorId];
  return {
    schema: 'identity_chat_map_result_v1',
    action: 'confirm',
    scope: 'local-chat-mapping',
    selectorId: plan.selectorId,
    principal: entry.principalId,
    harness: entry.harness,
    workspace: entry.workspace,
    sessionAddress: entry.sessionAddress,
    state: entry.state,
    sequence: updated.sequence,
  };
}

export async function identityChatMapRevoke({
  storeRoot,
  selectorId = null,
  harness = null,
  workspace = null,
  confirm = null,
  provider,
  releaseRoot,
  now,
  signal,
  onOperation = () => {},
}) {
  const plan = planChatMapRevoke({ storeRoot, selectorId, harness, workspace });
  if (confirm === null) return plan;
  assertConfirmMatches(confirm, plan.planId);
  const coordinator = createOwnerApprovalCoordinator({
    provider: provider ?? loadPackagedChatMapProvider({ command: 'chat.map.revoke', releaseRoot }),
    withLockedRegistry: createChatMappingApprovalAdapter(plan.operation, { now }),
  });
  await onOperation(describeOwnerOperation(plan.operation));
  const result = await coordinator.execute(coordinator.prepare(plan.operation), { signal });
  return {
    schema: 'identity_chat_map_result_v1',
    action: 'revoke',
    scope: 'local-chat-mapping',
    selectorId: plan.operation.selectorId,
    principal: plan.operation.before.principalId,
    revoked: true,
    sequence: result.registry.sequence,
  };
}

export function renderChatMapPlan(plan) {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  if (plan.action === 'set') {
    const op = plan.operation;
    const apply = `triangle identity chat-map set --store-root ${quote(op.storeRoot)} --registry-root ${quote(plan.registryRoot ?? '')} --harness ${op.harness} --workspace ${quote(op.workspace)} --principal ${op.principalId} --confirm ${plan.planId}`;
    return `Set chat mapping ${op.selectorId}\n${describeOwnerOperation(op)}\nPlan: ${plan.planId}\n` +
      'Fresh owner authentication is required. To apply this exact plan:\n' + apply;
  }
  if (plan.action === 'confirm') {
    const apply = `triangle identity chat-map confirm --store-root ${quote(plan.storeRoot)} --selector ${plan.selectorId} --confirm ${plan.planId}`;
    return `Confirm chat mapping ${plan.selectorId}\nPrincipal: ${plan.principalId}\nHarness: ${plan.harness}\nWorkspace: ${plan.workspace}\nSession: ${plan.sessionAddress}\nPlan: ${plan.planId}\n` +
      'Local owner TTY confirmation is required. To apply this exact plan:\n' + apply;
  }
  const op = plan.operation;
  const apply = `triangle identity chat-map revoke --store-root ${quote(op.storeRoot)} --selector ${op.selectorId} --confirm ${plan.planId}`;
  return `Revoke chat mapping ${op.selectorId}\n${describeOwnerOperation(op)}\nPlan: ${plan.planId}\n` +
    'Fresh owner authentication is required. To apply this exact plan:\n' + apply;
}

export function renderChatMapResult(result) {
  if (result.action === 'set') {
    return `Set pending chat mapping ${result.selectorId} for ${result.principal} (${result.harness} at ${result.workspace}) [sequence ${result.sequence}]`;
  }
  if (result.action === 'confirm') {
    return `Confirmed chat mapping ${result.selectorId} -> ${result.sessionAddress} for ${result.principal} [sequence ${result.sequence}]`;
  }
  return `Revoked chat mapping ${result.selectorId} for ${result.principal} [sequence ${result.sequence}]`;
}
