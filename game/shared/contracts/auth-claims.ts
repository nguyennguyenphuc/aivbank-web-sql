import {
  ParseResult,
  asBooleanValue,
  asEnumValue,
  asNonEmptyString,
  asStringArray,
  asRecord,
  coerceParseResult,
  fail,
  ok,
  pickValue,
} from './validation';
import { CURRENT_CONTRACT_REVISION, RevisionEnvelope } from './revision-id';

export const ACCOUNT_ROLES = ['student', 'teacher', 'analyst', 'admin', 'service'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export interface AuthClaims extends RevisionEnvelope {
  sub: string;
  session_id: string;
  roles: AccountRole[];
  scopes: string[];
  classroom_ids: string[];
  scenario_ids: string[];
  is_guest: boolean;
  issued_at: number;
  expires_at: number;
  issuer?: string;
  audience?: string;
  tenant_id?: string;
  actor_type: 'player' | 'teacher' | 'admin' | 'service';
}

export function parseAuthClaims(value: unknown): ParseResult<AuthClaims> {
  const parsed = asRecord(value, 'auth claims');
  if (!parsed.ok) return coerceParseResult(parsed);

  const sub = pickValue(parsed.value, 'sub', asNonEmptyString);
  if (!sub.ok) return coerceParseResult(sub);
  const session = pickValue(parsed.value, 'session_id', asNonEmptyString);
  if (!session.ok) return coerceParseResult(session);
  const roles = pickRoles(parsed.value);
  if (!roles.ok) return coerceParseResult(roles);
  const scopes = pickStringArray(parsed.value, 'scopes');
  if (!scopes.ok) return coerceParseResult(scopes);
  const classroomIds = pickStringArray(parsed.value, 'classroom_ids');
  if (!classroomIds.ok) return coerceParseResult(classroomIds);
  const scenarioIds = pickStringArray(parsed.value, 'scenario_ids');
  if (!scenarioIds.ok) return coerceParseResult(scenarioIds);
  const guest = pickValue(parsed.value, 'is_guest', asBooleanValue);
  if (!guest.ok) return coerceParseResult(guest);
  const issuedAt = pickInt(parsed.value, 'issued_at');
  if (!issuedAt.ok) return coerceParseResult(issuedAt);
  const expiresAt = pickInt(parsed.value, 'expires_at');
  if (!expiresAt.ok) return coerceParseResult(expiresAt);

  const revision = {
    contract_revision_id: CURRENT_CONTRACT_REVISION.value,
    content_revision_id: undefined,
    scenario_revision_id: undefined,
    telemetry_revision_id: undefined,
    classroom_revision_id: undefined,
  };

  const issuer = pickOptionalString(parsed.value, 'issuer');
  if (!issuer.ok) return coerceParseResult(issuer);
  const audience = pickOptionalString(parsed.value, 'audience');
  if (!audience.ok) return coerceParseResult(audience);
  const tenantId = pickOptionalString(parsed.value, 'tenant_id');
  if (!tenantId.ok) return coerceParseResult(tenantId);
  const actorType = pickActorType(parsed.value);
  if (!actorType.ok) return coerceParseResult(actorType);

  return ok({
    ...revision,
    sub: sub.value,
    session_id: session.value,
    roles: roles.value,
    scopes: scopes.value,
    classroom_ids: classroomIds.value,
    scenario_ids: scenarioIds.value,
    is_guest: guest.value,
    issued_at: issuedAt.value,
    expires_at: expiresAt.value,
    issuer: issuer.value,
    audience: audience.value,
    tenant_id: tenantId.value,
    actor_type: actorType.value,
  });
}

function pickRoles(source: Record<string, unknown>): ParseResult<AccountRole[]> {
  const parsed = pickValue(source, 'roles', asStringArray);
  if (!parsed.ok) return coerceParseResult(parsed);
  const roles: AccountRole[] = [];
  for (const role of parsed.value) {
    const roleResult = asEnumValue(role, ACCOUNT_ROLES, 'role');
    if (!roleResult.ok) return coerceParseResult(roleResult);
    roles.push(roleResult.value);
  }
  return ok(roles);
}

function pickStringArray(source: Record<string, unknown>, key: string): ParseResult<string[]> {
  const value = source[key];
  if (value === undefined || value === null) return ok([]);
  return asStringArray(value, key);
}

function pickInt(source: Record<string, unknown>, key: string): ParseResult<number> {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail(`Expected integer for ${key}`);
  return ok(value);
}

function pickOptionalString(source: Record<string, unknown>, key: string): ParseResult<string | undefined> {
  const value = source[key];
  if (value === undefined || value === null) return ok(undefined);
  return asNonEmptyString(value, key);
}

function pickActorType(source: Record<string, unknown>): ParseResult<AuthClaims['actor_type']> {
  const value = source.actor_type ?? 'player';
  return asEnumValue(value, ['player', 'teacher', 'admin', 'service'] as const, 'actor_type');
}
