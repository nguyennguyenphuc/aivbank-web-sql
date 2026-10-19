import {
  ParseResult,
  asBooleanValue,
  asEnumValue,
  asNonEmptyString,
  asRecord,
  coerceParseResult,
  fail,
  ok,
  pickValue,
} from './validation';
import { CURRENT_CONTRACT_REVISION, RevisionEnvelope } from './revision-id';

export const TELEMETRY_PLATFORMS = ['web', 'android', 'ios', 'unknown'] as const;
export type TelemetryPlatform = (typeof TELEMETRY_PLATFORMS)[number];

export interface ImmutableEventBase extends RevisionEnvelope {
  event_id: string;
  event_name: string;
  event_schema_version: string;
  event_ts_client?: string;
  event_ts_server: string;
  ingested_at?: string;
  user_id: string;
  session_id?: string;
  account_id?: string;
  classroom_id?: string;
  classroom_role?: 'student' | 'teacher' | 'analyst' | 'admin';
  scenario_id?: string;
  platform: TelemetryPlatform;
  country?: string;
  app_version?: string;
  build_hash?: string;
  screen_context?: string;
  world_id?: string;
  level_id?: string;
  attempt_id?: string;
  experiment_id?: string;
  variant?: string;
  payload_json: Record<string, unknown>;
}

export interface TelemetryEvent<TPayload extends Record<string, unknown> = Record<string, unknown>>
  extends ImmutableEventBase {
  payload_json: TPayload;
}

export function parseTelemetryEventBase(value: unknown): ParseResult<ImmutableEventBase> {
  const parsed = asRecord(value, 'telemetry event');
  if (!parsed.ok) return coerceParseResult(parsed);

  const eventId = pickValue(parsed.value, 'event_id', asNonEmptyString);
  if (!eventId.ok) return coerceParseResult(eventId);
  const eventName = pickValue(parsed.value, 'event_name', asNonEmptyString);
  if (!eventName.ok) return coerceParseResult(eventName);
  const revision = pickValue(parsed.value, 'contract_revision_id', asNonEmptyString);
  if (!revision.ok) return coerceParseResult(revision);
  const schemaVersion = pickValue(parsed.value, 'event_schema_version', asNonEmptyString);
  if (!schemaVersion.ok) return coerceParseResult(schemaVersion);
  const eventTsServer = pickValue(parsed.value, 'event_ts_server', asNonEmptyString);
  if (!eventTsServer.ok) return coerceParseResult(eventTsServer);
  const userId = pickValue(parsed.value, 'user_id', asNonEmptyString);
  if (!userId.ok) return coerceParseResult(userId);
  const platform = pickPlatform(parsed.value);
  if (!platform.ok) return coerceParseResult(platform);
  const payload = pickPayload(parsed.value);
  if (!payload.ok) return coerceParseResult(payload);

  const eventTsClient = pickOptionalString(parsed.value, 'event_ts_client');
  if (!eventTsClient.ok) return coerceParseResult(eventTsClient);
  const ingestedAt = pickOptionalString(parsed.value, 'ingested_at');
  if (!ingestedAt.ok) return coerceParseResult(ingestedAt);
  const sessionId = pickOptionalString(parsed.value, 'session_id');
  if (!sessionId.ok) return coerceParseResult(sessionId);
  const accountId = pickOptionalString(parsed.value, 'account_id');
  if (!accountId.ok) return coerceParseResult(accountId);
  const classroomId = pickOptionalString(parsed.value, 'classroom_id');
  if (!classroomId.ok) return coerceParseResult(classroomId);
  const classroomRole = pickOptionalClassroomRole(parsed.value);
  if (!classroomRole.ok) return coerceParseResult(classroomRole);
  const scenarioId = pickOptionalString(parsed.value, 'scenario_id');
  if (!scenarioId.ok) return coerceParseResult(scenarioId);
  const country = pickOptionalString(parsed.value, 'country');
  if (!country.ok) return coerceParseResult(country);
  const appVersion = pickOptionalString(parsed.value, 'app_version');
  if (!appVersion.ok) return coerceParseResult(appVersion);
  const buildHash = pickOptionalString(parsed.value, 'build_hash');
  if (!buildHash.ok) return coerceParseResult(buildHash);
  const screenContext = pickOptionalString(parsed.value, 'screen_context');
  if (!screenContext.ok) return coerceParseResult(screenContext);
  const worldId = pickOptionalString(parsed.value, 'world_id');
  if (!worldId.ok) return coerceParseResult(worldId);
  const levelId = pickOptionalString(parsed.value, 'level_id');
  if (!levelId.ok) return coerceParseResult(levelId);
  const attemptId = pickOptionalString(parsed.value, 'attempt_id');
  if (!attemptId.ok) return coerceParseResult(attemptId);
  const experimentId = pickOptionalString(parsed.value, 'experiment_id');
  if (!experimentId.ok) return coerceParseResult(experimentId);
  const variant = pickOptionalString(parsed.value, 'variant');
  if (!variant.ok) return coerceParseResult(variant);
  const contentRevision = pickOptionalString(parsed.value, 'content_revision_id');
  if (!contentRevision.ok) return coerceParseResult(contentRevision);
  const scenarioRevision = pickOptionalString(parsed.value, 'scenario_revision_id');
  if (!scenarioRevision.ok) return coerceParseResult(scenarioRevision);
  const telemetryRevision = pickOptionalString(parsed.value, 'telemetry_revision_id');
  if (!telemetryRevision.ok) return coerceParseResult(telemetryRevision);
  const classroomRevision = pickOptionalString(parsed.value, 'classroom_revision_id');
  if (!classroomRevision.ok) return coerceParseResult(classroomRevision);

  return ok({
    contract_revision_id: revision.value,
    content_revision_id: contentRevision.value,
    scenario_revision_id: scenarioRevision.value,
    telemetry_revision_id: telemetryRevision.value,
    classroom_revision_id: classroomRevision.value,
    event_id: eventId.value,
    event_name: eventName.value,
    event_schema_version: schemaVersion.value,
    event_ts_client: eventTsClient.value,
    event_ts_server: eventTsServer.value,
    ingested_at: ingestedAt.value,
    user_id: userId.value,
    session_id: sessionId.value,
    account_id: accountId.value,
    classroom_id: classroomId.value,
    classroom_role: classroomRole.value,
    scenario_id: scenarioId.value,
    platform: platform.value,
    country: country.value,
    app_version: appVersion.value,
    build_hash: buildHash.value,
    screen_context: screenContext.value,
    world_id: worldId.value,
    level_id: levelId.value,
    attempt_id: attemptId.value,
    experiment_id: experimentId.value,
    variant: variant.value,
    payload_json: payload.value,
  });
}

export function makeTelemetryEvent<TPayload extends Record<string, unknown>>(
  event: Omit<TelemetryEvent<TPayload>, 'contract_revision_id' | 'payload_json'> & { payload_json: TPayload },
): TelemetryEvent<TPayload> {
  return {
    ...event,
    contract_revision_id: CURRENT_CONTRACT_REVISION.value,
  };
}

function pickPlatform(source: Record<string, unknown>): ParseResult<TelemetryPlatform> {
  const value = source.platform ?? 'unknown';
  return asEnumValue(value, TELEMETRY_PLATFORMS, 'platform');
}

function pickPayload(source: Record<string, unknown>): ParseResult<Record<string, unknown>> {
  const value = source.payload_json;
  if (value === undefined || value === null) return ok({});
  return asRecord(value, 'payload_json');
}

function pickOptionalString(source: Record<string, unknown>, key: string): ParseResult<string | undefined> {
  const value = source[key];
  if (value === undefined || value === null || value === '') return ok(undefined);
  return asNonEmptyString(value, key);
}

function pickOptionalClassroomRole(
  source: Record<string, unknown>,
): ParseResult<ImmutableEventBase['classroom_role'] | undefined> {
  const value = source.classroom_role;
  if (value === undefined || value === null || value === '') return ok(undefined);
  return asEnumValue(value, ['student', 'teacher', 'analyst', 'admin'] as const, 'classroom_role');
}
