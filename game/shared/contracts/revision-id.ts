import { ParseResult, asEnumValue, asNonEmptyString, asRecord, coerceParseResult, fail, ok, pickValue } from './validation';

export const REVISION_KINDS = ['contract', 'content', 'scenario', 'telemetry', 'classroom'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export interface RevisionId {
  kind: RevisionKind;
  major: number;
  minor: number;
  patch: number;
  value: string;
}

export const CURRENT_CONTRACT_REVISION: RevisionId = {
  kind: 'contract',
  major: 1,
  minor: 0,
  patch: 0,
  value: 'contract.v1.0.0',
};

export function createRevisionId(kind: RevisionKind, major = 1, minor = 0, patch = 0): RevisionId {
  return { kind, major, minor, patch, value: `${kind}.v${major}.${minor}.${patch}` };
}

export function isRevisionId(value: unknown): value is RevisionId {
  return parseRevisionId(value).ok;
}

export function parseRevisionId(value: unknown): ParseResult<RevisionId> {
  const parsed = asNonEmptyString(value, 'revision_id');
  if (!parsed.ok) return coerceParseResult(parsed);

  const match = /^([a-z]+)\.v(\d+)\.(\d+)\.(\d+)$/.exec(parsed.value);
  if (!match) return fail('Invalid revision_id format');

  const kindResult = asEnumValue(match[1], REVISION_KINDS, 'revision kind');
  if (!kindResult.ok) return coerceParseResult(kindResult);

  const major = Number(match[2]);
  const minor = Number(match[3]);
  const patch = Number(match[4]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return fail('Invalid revision numbers');
  }

  return ok({
    kind: kindResult.value,
    major,
    minor,
    patch,
    value: parsed.value,
  });
}

export interface RevisionEnvelope {
  contract_revision_id: string;
  content_revision_id?: string;
  scenario_revision_id?: string;
  telemetry_revision_id?: string;
  classroom_revision_id?: string;
}

export function parseRevisionEnvelope(value: unknown): ParseResult<RevisionEnvelope> {
  const parsed = asRecord(value, 'revision envelope');
  if (!parsed.ok) return coerceParseResult(parsed);

  const contract = pickValue(parsed.value, 'contract_revision_id', asNonEmptyString);
  if (!contract.ok) return coerceParseResult(contract);

  const content = pickOptionalString(parsed.value, 'content_revision_id');
  if (!content.ok) return coerceParseResult(content);
  const scenario = pickOptionalString(parsed.value, 'scenario_revision_id');
  if (!scenario.ok) return coerceParseResult(scenario);
  const telemetry = pickOptionalString(parsed.value, 'telemetry_revision_id');
  if (!telemetry.ok) return coerceParseResult(telemetry);
  const classroom = pickOptionalString(parsed.value, 'classroom_revision_id');
  if (!classroom.ok) return coerceParseResult(classroom);

  return ok({
    contract_revision_id: contract.value,
    content_revision_id: content.value,
    scenario_revision_id: scenario.value,
    telemetry_revision_id: telemetry.value,
    classroom_revision_id: classroom.value,
  });
}

function pickOptionalString(source: Record<string, unknown>, key: string): ParseResult<string | undefined> {
  const value = source[key];
  if (value === undefined || value === null) return ok(undefined);
  return asNonEmptyString(value, key);
}
