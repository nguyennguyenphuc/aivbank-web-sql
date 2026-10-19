import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AnalysisJourneyStep, ClassroomMembershipSummary, ClassroomSummary, ScenarioPack, TeachingAssignment } from '../../../../shared/contracts/classroom/index.js';
import { DatabaseService } from '../../database/database.service.js';
import { CompetitionService } from '../competition/competition.service.js';

interface ClassroomRow { [key: string]: unknown; classroom_id: string; owner_account_id: string; name: string; join_code: string; roster_revision: string; student_count: string }
interface ScenarioRow { [key: string]: unknown; scenario_id: string; title: string; description: string; filters: Record<string, unknown>; learning_objectives: string[]; immutable_revision: string; journey_definition: { estimatedMinutes?: number; steps?: AnalysisJourneyStep[] }; rubric_definition: Record<string, unknown> }
interface AssignmentRow { [key: string]: unknown; assignment_id: string; classroom_id: string; scenario_id: string; title: string; opens_at: Date; closes_at: Date }

@Injectable()
export class ClassroomService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CompetitionService) private readonly competition: CompetitionService,
  ) {}

  async scenarios(): Promise<ScenarioPack[]> {
    const rows = await this.database.query<ScenarioRow>('select * from teaching_scenario_packs order by scenario_id');
    return rows.map(readScenario);
  }

  async mine(accountId: string): Promise<ClassroomMembershipSummary[]> {
    const rows = await this.database.query<ClassroomRow & { membership_role: 'teacher' | 'student' }>(
      `select c.*, m.role membership_role,
        (select count(*) from teaching_classroom_members students where students.classroom_id = c.classroom_id and students.role = 'student') student_count
       from teaching_classrooms c join teaching_classroom_members m on m.classroom_id = c.classroom_id
       where m.account_id = $1 order by c.created_at desc`,
      [accountId],
    );
    return rows.map(row => ({ ...readClassroom(row), membershipRole: row.membership_role }));
  }

  async create(ownerAccountId: string, name: string): Promise<ClassroomSummary> {
    if (!name?.trim() || name.trim().length > 80) throw new BadRequestException('Classroom name is required');
    const classroomId = randomUUID();
    const joinCode = randomBytes(4).toString('hex').toUpperCase();
    const rosterRevision = `roster.${randomUUID()}`;
    await this.database.withClient(async client => {
      await client.query('begin');
      try {
        await client.query(
          'insert into teaching_classrooms (classroom_id, owner_account_id, name, join_code, roster_revision) values ($1, $2, $3, $4, $5)',
          [classroomId, ownerAccountId, name.trim(), joinCode, rosterRevision],
        );
        await client.query(
          `insert into teaching_classroom_members (classroom_id, account_id, role) values ($1, $2, 'teacher')`,
          [classroomId, ownerAccountId],
        );
        await client.query(
          'insert into competition_roster_revisions (classroom_id, roster_revision) values ($1, $2)',
          [classroomId, rosterRevision],
        );
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
    });
    return { classroomId, name: name.trim(), joinCode, rosterRevision, studentCount: 0 };
  }

  async join(accountId: string, joinCode: string): Promise<ClassroomSummary> {
    const classes = await this.database.query<ClassroomRow>(
      `select c.*, (select count(*) from teaching_classroom_members m where m.classroom_id = c.classroom_id and m.role = 'student') student_count
       from teaching_classrooms c where c.join_code = $1`, [joinCode?.trim().toUpperCase()],
    );
    const classroom = classes[0];
    if (!classroom) throw new NotFoundException('Classroom not found');
    const roster = await this.database.withClient(async client => {
      await client.query('begin');
      try {
        await client.query('select classroom_id from teaching_classrooms where classroom_id = $1 for update', [classroom.classroom_id]);
        const inserted = await client.query(
          `insert into teaching_classroom_members (classroom_id, account_id, role) values ($1, $2, 'student')
           on conflict do nothing returning account_id`,
          [classroom.classroom_id, accountId],
        );
        const current = await client.query<{ account_id: string }>(
          `select account_id from teaching_classroom_members where classroom_id = $1 and role = 'student' order by account_id`,
          [classroom.classroom_id],
        );
        if (inserted.rowCount === 0) {
          await client.query('commit');
          return { members: current.rows, revision: classroom.roster_revision };
        }
        const revision = `roster.${randomUUID()}`;
        await client.query(
          'insert into competition_roster_revisions (classroom_id, roster_revision) values ($1, $2)',
          [classroom.classroom_id, revision],
        );
        for (const member of current.rows) {
          await client.query(
            'insert into competition_rosters (classroom_id, roster_revision, player_id) values ($1, $2, $3)',
            [classroom.classroom_id, revision, member.account_id],
          );
        }
        await client.query('update teaching_classrooms set roster_revision = $2 where classroom_id = $1', [classroom.classroom_id, revision]);
        await client.query('commit');
        return { members: current.rows, revision };
      } catch (error) { await client.query('rollback'); throw error; }
    });
    return {
      classroomId: classroom.classroom_id,
      name: classroom.name,
      joinCode: classroom.join_code,
      rosterRevision: roster.revision,
      studentCount: roster.members.length,
    };
  }

  async assign(ownerAccountId: string, input: { classroomId: string; scenarioId: string; title: string; opensAt: string; closesAt: string }): Promise<TeachingAssignment> {
    await this.requireOwner(input.classroomId, ownerAccountId);
    const opensAt = Date.parse(input.opensAt);
    const closesAt = Date.parse(input.closesAt);
    if (!input.title?.trim() || input.title.trim().length > 120 || !Number.isFinite(opensAt) || !Number.isFinite(closesAt) || opensAt >= closesAt) {
      throw new BadRequestException('Invalid assignment title or window');
    }
    const scenarios = await this.database.query<ScenarioRow>('select * from teaching_scenario_packs where scenario_id = $1', [input.scenarioId]);
    const scenario = scenarios[0];
    if (!scenario) throw new NotFoundException('Scenario not found');
    const assignmentId = randomUUID();
    await this.database.query(
      `insert into teaching_assignments
        (assignment_id, classroom_id, scenario_id, title, opens_at, closes_at, created_by, scenario_revision, journey_definition, rubric_definition)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
      [assignmentId, input.classroomId, input.scenarioId, input.title.trim(), input.opensAt, input.closesAt, ownerAccountId,
        scenario.immutable_revision, JSON.stringify(scenario.journey_definition), JSON.stringify(scenario.rubric_definition)],
    );
    return { assignmentId, classroomId: input.classroomId, scenarioId: input.scenarioId, title: input.title.trim(), opensAt: input.opensAt, closesAt: input.closesAt };
  }

  async dashboard(classroomId: string, viewerId: string, admin = false): Promise<{ classroom: ClassroomSummary; assignments: TeachingAssignment[]; funnel: unknown[]; failHeatmap: unknown[]; leaderboard: unknown }> {
    if (!admin) await this.requireOwner(classroomId, viewerId);
    const classes = await this.database.query<ClassroomRow>(
      `select c.*, (select count(*) from teaching_classroom_members m where m.classroom_id = c.classroom_id and m.role = 'student') student_count
       from teaching_classrooms c where c.classroom_id = $1`, [classroomId],
    );
    const row = classes[0];
    if (!row) throw new NotFoundException('Classroom not found');
    const assignments = await this.database.query<AssignmentRow>('select * from teaching_assignments where classroom_id = $1 order by opens_at desc', [classroomId]);
    const analytics = await Promise.all([
      this.database.query('select * from jelly_analytics.tutorial_step4_health order by region, platform, app_version'),
      this.database.query('select * from jelly_analytics.level_28_30_health where attempts >= 50 order by region, platform, app_version'),
    ]);
    return {
      classroom: readClassroom(row),
      assignments: assignments.map(item => ({ assignmentId: item.assignment_id, classroomId: item.classroom_id, scenarioId: item.scenario_id, title: item.title, opensAt: item.opens_at.toISOString(), closesAt: item.closes_at.toISOString() })),
      funnel: analytics[0],
      failHeatmap: analytics[1],
      leaderboard: await this.competition.topForAuthorizedStaff({ kind: 'classroom', classroomId, rosterRevision: row.roster_revision }, 20),
    };
  }

  private async requireOwner(classroomId: string, accountId: string): Promise<void> {
    const rows = await this.database.query('select 1 from teaching_classrooms where classroom_id = $1 and owner_account_id = $2', [classroomId, accountId]);
    if (!rows.length) throw new ForbiddenException('Teacher does not own this classroom');
  }
}

function readClassroom(row: ClassroomRow): ClassroomSummary {
  return { classroomId: row.classroom_id, name: row.name, joinCode: row.join_code, rosterRevision: row.roster_revision, studentCount: Number(row.student_count) };
}

function readScenario(row: ScenarioRow): ScenarioPack {
  return {
    scenarioId: row.scenario_id,
    title: row.title,
    description: row.description,
    filters: row.filters,
    learningObjectives: row.learning_objectives,
    immutableRevision: row.immutable_revision,
    estimatedMinutes: Number(row.journey_definition?.estimatedMinutes ?? 60),
    journeySteps: row.journey_definition?.steps ?? [],
  };
}
