import { describe, expect, it, vi } from 'vitest';
import type { AnalysisEvidenceCard, AnalysisJourneyStep, AnalysisStepResponse } from '../../shared/contracts/classroom/index.js';
import { AnalysisJourneyService } from '../../server/src/modules/classroom/analysis-journey.service.js';

const steps: AnalysisJourneyStep[] = Array.from({ length: 10 }, (_, index) => ({
  stepId: `step-${index + 1}`,
  title: `Step ${index + 1}`,
  prompt: 'Analyze the evidence',
  guidance: 'Use claim, evidence, reasoning, and uncertainty.',
  minNarrativeLength: 20,
  minEvidenceCount: 1,
  evidenceCategories: ['activation'],
}));

const evidence: AnalysisEvidenceCard[] = [{
  evidenceId: 'activation.step4.2.1.0', category: 'activation', label: 'Step 4 completion',
  value: 67, unit: 'percent', segment: 'Android SEA', sampleSize: 1000, maturity: 'ready',
}];

function assignmentRow() {
  const now = new Date();
  return {
    assignment_id: 'assignment-1', classroom_id: 'class-1', classroom_name: 'Class', owner_account_id: 'teacher-1',
    scenario_id: 'scenario-1', scenario_title: 'Regression', scenario_description: 'Investigate regression',
    scenario_filters: { platform: 'Android' }, learning_objectives: ['RCA'], scenario_revision: 'scenario.v1',
    journey_definition: { estimatedMinutes: 90, steps },
    rubric_definition: { steps: steps.map(step => ({ stepId: step.stepId, expectedCategories: ['activation'] })) },
    title: 'Analysis journey', opens_at: new Date(now.getTime() - 60_000), closes_at: new Date(now.getTime() + 60_000),
    attempt_id: 'attempt-1', attempt_status: 'draft' as const, attempt_revision: 10, attempt_current_step: 9,
    attempt_responses: Object.fromEntries(steps.map(step => [step.stepId, completeResponse()])),
    evidence_snapshot: evidence, rubric_result: null, started_at: now, updated_at: now, submitted_at: null,
  };
}

function completeResponse(): AnalysisStepResponse {
  return { narrative: 'This evidence supports the claim while uncertainty remains.', evidenceIds: [evidence[0].evidenceId] };
}

describe('analysis journey service', () => {
  it('prevents a non-owner instructor from listing another classroom assignments', async () => {
    const database = { query: vi.fn(async () => [{ owner_account_id: 'teacher-1' }]) };
    const service = new AnalysisJourneyService(database as never);
    await expect(service.assignmentsForTeacher('teacher-2', 'class-1', false)).rejects.toThrow(/does not own/i);
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('submits a complete ten-step journey with a deterministic rubric and makes the result immutable', async () => {
    const row = assignmentRow();
    const attempt = {
      attempt_id: row.attempt_id, assignment_id: row.assignment_id, account_id: 'student-1', status: 'draft' as const,
      current_step: row.attempt_current_step, revision: row.attempt_revision, responses: row.attempt_responses,
      evidence_snapshot: row.evidence_snapshot, rubric_result: null, started_at: row.started_at, updated_at: row.updated_at, submitted_at: null,
    };
    const client = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('opens_at <= now()')) return { rows: [{ is_open: true }], rowCount: 1 };
      if (sql.startsWith('select * from teaching_assignment_attempts')) return { rows: [attempt] };
      if (sql.includes("set status = 'submitted'")) {
        const result = JSON.parse(String(params?.[1]));
        attempt.status = 'submitted' as never;
        attempt.rubric_result = result;
        attempt.revision += 1;
        attempt.submitted_at = new Date() as never;
        row.attempt_status = 'submitted';
        row.attempt_revision = attempt.revision;
        row.rubric_result = result;
        row.submitted_at = attempt.submitted_at;
      }
      return { rows: [], rowCount: 1 };
    }) };
    const database = {
      query: vi.fn(async () => [row]),
      withClient: vi.fn(async (operation: (value: typeof client) => Promise<unknown>) => operation(client)),
    };
    const service = new AnalysisJourneyService(database as never);

    const submitted = await service.submit('student-1', 'assignment-1');
    expect(submitted.result).toMatchObject({ score: 100, maxScore: 100 });
    expect(submitted.attempt.status).toBe('submitted');
    expect(submitted.result?.dimensions).toEqual([
      expect.objectContaining({ dimension: 'completion', score: 40 }),
      expect.objectContaining({ dimension: 'evidence', score: 40 }),
      expect.objectContaining({ dimension: 'reasoning', score: 20 }),
    ]);

    await service.submit('student-1', 'assignment-1');
    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes("set status = 'submitted'"))).toHaveLength(1);
  });

  it('starts idempotently and represents unavailable aggregate evidence as missing instead of zero', async () => {
    const row = assignmentRow();
    Object.assign(row, {
      attempt_id: null, attempt_status: null, attempt_revision: null, attempt_current_step: null,
      attempt_responses: null, evidence_snapshot: null, started_at: null, updated_at: null,
    });
    const client = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('opens_at <= now()')) return { rows: [{ is_open: true }], rowCount: 1 };
      if (sql.startsWith('insert into teaching_assignment_attempts') && row.attempt_id === null) {
        const now = new Date();
        Object.assign(row, {
          attempt_id: params?.[0], attempt_status: 'draft', attempt_revision: 0, attempt_current_step: 0,
          attempt_responses: {}, evidence_snapshot: JSON.parse(String(params?.[3])), started_at: now, updated_at: now,
        });
      }
      return { rows: [], rowCount: 1 };
    }) };
    const database = {
      query: vi.fn(async (sql: string) => sql.includes('from teaching_assignments a') ? [row] : []),
      withClient: vi.fn(async (operation: (value: typeof client) => Promise<unknown>) => operation(client)),
    };
    const service = new AnalysisJourneyService(database as never);

    const first = await service.start('student-1', 'assignment-1');
    const second = await service.start('student-1', 'assignment-1');

    expect(second.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(first.evidence).toContainEqual(expect.objectContaining({
      evidenceId: 'progression.win.2.1.1.28', value: null, maturity: 'missing',
    }));
    expect(client.query.mock.calls.filter(([sql]) => String(sql).startsWith('insert into teaching_assignment_attempts'))).toHaveLength(1);
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("member.role = 'student'"))).toBe(true);
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes('from jelly_analytics.users cohort'))).toBe(true);
  });

  it('rejects a stale draft revision rather than overwriting another session', async () => {
    const row = assignmentRow();
    const attempt = {
      attempt_id: row.attempt_id, assignment_id: row.assignment_id, account_id: 'student-1', status: 'draft',
      current_step: 0, revision: 4, responses: row.attempt_responses, evidence_snapshot: evidence,
      rubric_result: null, started_at: row.started_at, updated_at: row.updated_at, submitted_at: null,
    };
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('opens_at <= now()')) return { rows: [{ is_open: true }], rowCount: 1 };
      return sql.startsWith('select * from teaching_assignment_attempts') ? { rows: [attempt] } : { rows: [], rowCount: 1 };
    }) };
    const database = { query: vi.fn(async () => [row]), withClient: vi.fn(async (operation: (value: typeof client) => Promise<unknown>) => operation(client)) };
    const service = new AnalysisJourneyService(database as never);

    await expect(service.saveStep('student-1', 'assignment-1', 'step-1', {
      expectedRevision: 3,
      currentStep: 1,
      response: { narrative: 'A competing session wrote a different response.', evidenceIds: [evidence[0].evidenceId] },
    })).rejects.toThrow(/changed in another session/i);
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('update teaching_assignment_attempts'))).toBe(false);
  });

  it('rejects an incomplete journey without persisting a score', async () => {
    const row = assignmentRow();
    row.attempt_responses = { 'step-1': completeResponse() };
    const attempt = {
      attempt_id: row.attempt_id, assignment_id: row.assignment_id, account_id: 'student-1', status: 'draft',
      current_step: 0, revision: 1, responses: row.attempt_responses, evidence_snapshot: evidence,
      rubric_result: null, started_at: row.started_at, updated_at: row.updated_at, submitted_at: null,
    };
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('opens_at <= now()')) return { rows: [{ is_open: true }], rowCount: 1 };
      return sql.startsWith('select * from teaching_assignment_attempts') ? { rows: [attempt] } : { rows: [], rowCount: 1 };
    }) };
    const database = { query: vi.fn(async () => [row]), withClient: vi.fn(async (operation: (value: typeof client) => Promise<unknown>) => operation(client)) };
    const service = new AnalysisJourneyService(database as never);

    await expect(service.submit('student-1', 'assignment-1')).rejects.toThrow(/step step-2 is incomplete/i);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("set status = 'submitted'"))).toBe(false);
  });

  it('rechecks the assignment window inside the write transaction', async () => {
    const row = assignmentRow();
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('opens_at <= now()')) return { rows: [{ is_open: false }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }) };
    const database = { query: vi.fn(async () => [row]), withClient: vi.fn(async (operation: (value: typeof client) => Promise<unknown>) => operation(client)) };
    const service = new AnalysisJourneyService(database as never);

    await expect(service.saveStep('student-1', 'assignment-1', 'step-1', {
      expectedRevision: 10, currentStep: 1, response: completeResponse(),
    })).rejects.toThrow(/outside its active window/i);
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('update teaching_assignment_attempts'))).toBe(false);
  });
});
