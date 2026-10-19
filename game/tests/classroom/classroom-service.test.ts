import { describe, expect, it, vi } from 'vitest';
import { ClassroomService } from '../../server/src/modules/classroom/classroom.service.js';

describe('classroom service', () => {
  it('rejects invalid classroom names before writing state', async () => {
    const database = { query: vi.fn(), withClient: vi.fn() };
    const competition = { registerRoster: vi.fn() };
    const service = new ClassroomService(database as never, competition as never);
    await expect(service.create('teacher-1', '   ')).rejects.toThrow(/name is required/i);
    expect(database.withClient).not.toHaveBeenCalled();
  });

  it('exposes immutable regression and hotfix scenario packs', async () => {
    const database = { query: vi.fn(async () => [{
      scenario_id: 'android-sea-v2.1.0-regression', title: 'Regression', description: 'RCA',
      filters: { appVersion: '2.1.0' }, learning_objectives: ['funnel analysis'], immutable_revision: 'scenario.v1',
      journey_definition: { estimatedMinutes: 75, steps: [{ stepId: 'brief' }] },
    }]) };
    const service = new ClassroomService(database as never, { registerRoster: vi.fn() } as never);
    await expect(service.scenarios()).resolves.toEqual([expect.objectContaining({
      scenarioId: 'android-sea-v2.1.0-regression', immutableRevision: 'scenario.v1', estimatedMinutes: 75,
      journeySteps: [expect.objectContaining({ stepId: 'brief' })],
    })]);
  });

  it('rejects invalid assignment windows before reading or writing a scenario', async () => {
    const database = { query: vi.fn(async () => [{}]), withClient: vi.fn() };
    const service = new ClassroomService(database as never, {} as never);

    await expect(service.assign('teacher-1', {
      classroomId: 'class-1', scenarioId: 'scenario-1', title: 'Journey',
      opensAt: '2026-08-30T00:00:00.000Z', closesAt: '2026-08-29T00:00:00.000Z',
    })).rejects.toThrow(/invalid assignment/i);
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('snapshots the immutable scenario journey when assigning it', async () => {
    const journey = { estimatedMinutes: 90, steps: [{ stepId: 'brief', title: 'Brief' }] };
    const rubric = { steps: [{ stepId: 'brief', expectedCategories: ['brief'] }] };
    const database = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith('select 1')) return [{}];
      if (sql.startsWith('select * from teaching_scenario_packs')) return [{
        scenario_id: 'scenario-1', immutable_revision: 'scenario.v2', journey_definition: journey, rubric_definition: rubric,
      }];
      return [];
    }) };
    const service = new ClassroomService(database as never, {} as never);

    await service.assign('teacher-1', {
      classroomId: 'class-1', scenarioId: 'scenario-1', title: ' Journey ',
      opensAt: '2026-08-28T00:00:00.000Z', closesAt: '2026-09-04T00:00:00.000Z',
    });

    expect(database.query).toHaveBeenLastCalledWith(expect.stringContaining('journey_definition, rubric_definition'), expect.arrayContaining([
      'scenario.v2', JSON.stringify(journey), JSON.stringify(rubric),
    ]));
  });

  it('keeps the current roster revision when an existing student retries join', async () => {
    const executed: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes('insert into teaching_classroom_members')) return { rowCount: 0, rows: [] };
        if (sql.includes("role = 'student'")) return { rowCount: 1, rows: [{ account_id: 'student-1' }] };
        return { rowCount: 0, rows: [] };
      }),
    };
    const database = {
      query: vi.fn(async () => [{
        classroom_id: 'class-1', owner_account_id: 'teacher-1', name: 'Data Class', join_code: 'JOIN1234',
        roster_revision: 'roster.current', student_count: '1',
      }]),
      withClient: vi.fn(async (operation: (value: typeof client) => Promise<unknown>) => operation(client)),
    };
    const service = new ClassroomService(database as never, {} as never);

    await expect(service.join('student-1', 'join1234')).resolves.toMatchObject({
      rosterRevision: 'roster.current', studentCount: 1,
    });
    expect(executed.some(sql => sql.includes('competition_roster_revisions'))).toBe(false);
    expect(executed.some(sql => sql.includes('update teaching_classrooms'))).toBe(false);
  });
});
