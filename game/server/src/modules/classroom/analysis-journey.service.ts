import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  AnalysisAttempt,
  AnalysisEvidenceCard,
  AnalysisEvidenceCategory,
  AnalysisJourney,
  AnalysisJourneyStep,
  AnalysisResult,
  AnalysisStepResponse,
  SaveAnalysisStepRequest,
  ScenarioPack,
  TeacherAssignmentDashboard,
  TeacherLearnerProgress,
  TeachingAssignment,
  TeachingAssignmentSummary,
} from '../../../../shared/contracts/classroom/index.js';
import { DatabaseService } from '../../database/database.service.js';

interface AssignmentRow {
  [key: string]: unknown;
  assignment_id: string;
  classroom_id: string;
  classroom_name: string;
  owner_account_id: string;
  scenario_id: string;
  scenario_title: string;
  scenario_description: string;
  scenario_filters: Record<string, unknown>;
  learning_objectives: string[];
  scenario_revision: string;
  journey_definition: { estimatedMinutes?: number; steps?: AnalysisJourneyStep[] };
  rubric_definition: { steps?: Array<{ stepId: string; expectedCategories: AnalysisEvidenceCategory[] }> };
  title: string;
  opens_at: Date;
  closes_at: Date;
  attempt_id: string | null;
  attempt_status: 'draft' | 'submitted' | null;
  attempt_revision: number | null;
  attempt_current_step: number | null;
  attempt_responses: Record<string, AnalysisStepResponse> | null;
  evidence_snapshot: AnalysisEvidenceCard[] | null;
  rubric_result: AnalysisResult | null;
  started_at: Date | null;
  updated_at: Date | null;
  submitted_at: Date | null;
}

interface AttemptRow {
  [key: string]: unknown;
  attempt_id: string;
  assignment_id: string;
  account_id: string;
  status: 'draft' | 'submitted';
  current_step: number;
  revision: number;
  responses: Record<string, AnalysisStepResponse>;
  evidence_snapshot: AnalysisEvidenceCard[];
  rubric_result: AnalysisResult | null;
  started_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
}

interface AggregateRow { [key: string]: unknown; app_version?: string; level_id?: string; channel?: string; experiment_id?: string; variant?: string; metric_a?: string | null; metric_b?: string | null; metric_c?: string | null; sample_size?: string }

@Injectable()
export class AnalysisJourneyService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async assignmentsForLearner(accountId: string): Promise<TeachingAssignmentSummary[]> {
    const rows = await this.database.query<AssignmentRow>(`${ASSIGNMENT_SELECT}
      join teaching_classroom_members member on member.classroom_id = a.classroom_id and member.account_id = $1 and member.role = 'student'
      left join teaching_assignment_attempts attempt on attempt.assignment_id = a.assignment_id and attempt.account_id = $1
      order by a.closes_at desc`, [accountId]);
    return rows.map(row => this.summary(row));
  }

  async assignmentsForTeacher(viewerId: string, classroomId: string, admin: boolean): Promise<TeachingAssignmentSummary[]> {
    const ownership = await this.database.query<{ [key: string]: unknown; owner_account_id: string }>(
      'select owner_account_id from teaching_classrooms where classroom_id = $1', [classroomId],
    );
    if (!ownership[0]) throw new NotFoundException('Classroom not found');
    if (!admin && ownership[0].owner_account_id !== viewerId) throw new ForbiddenException('Teacher does not own this classroom');
    const rows = await this.database.query<AssignmentRow>(`${ASSIGNMENT_SELECT}
      left join teaching_assignment_attempts attempt on attempt.assignment_id = a.assignment_id and attempt.account_id = $2
      where a.classroom_id = $1 order by a.created_at desc`, [classroomId, viewerId]);
    return rows.map(row => this.summary(row));
  }

  async start(accountId: string, assignmentId: string): Promise<AnalysisJourney> {
    const assignment = await this.assignmentForMember(accountId, assignmentId);
    this.assertOpen(assignment);
    if (assignment.attempt_id && assignment.evidence_snapshot) return this.readJourney(assignment);
    const evidence = await this.buildEvidence(assignment.scenario_filters);
    const attemptId = randomUUID();
    await this.database.withClient(async client => {
      await client.query('begin');
      try {
        await this.assertOpenForWrite(client, assignmentId);
        await client.query(
          `insert into teaching_assignment_attempts (attempt_id, assignment_id, account_id, evidence_snapshot)
           values ($1, $2, $3, $4::jsonb) on conflict (assignment_id, account_id) do nothing`,
          [attemptId, assignmentId, accountId, JSON.stringify(evidence)],
        );
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
    });
    return this.journey(accountId, assignmentId);
  }

  async journey(accountId: string, assignmentId: string): Promise<AnalysisJourney> {
    const row = await this.assignmentForMember(accountId, assignmentId);
    if (!row.attempt_id || !row.evidence_snapshot) throw new NotFoundException('Analysis attempt has not started');
    return this.readJourney(row);
  }

  async saveStep(accountId: string, assignmentId: string, stepId: string, input: SaveAnalysisStepRequest): Promise<AnalysisJourney> {
    if (!Number.isSafeInteger(input.expectedRevision) || !Number.isSafeInteger(input.currentStep)) throw new BadRequestException('Invalid attempt revision');
    const assignment = await this.assignmentForMember(accountId, assignmentId);
    this.assertOpen(assignment);
    const steps = assignment.journey_definition.steps ?? [];
    const step = steps.find(item => item.stepId === stepId);
    if (!step) throw new NotFoundException('Analysis step not found');
    this.validateDraftResponse(input.response, assignment.evidence_snapshot ?? []);

    await this.database.withClient(async client => {
      await client.query('begin');
      try {
        await this.assertOpenForWrite(client, assignmentId);
        const attempt = await this.lockAttempt(client, accountId, assignmentId);
        if (attempt.status === 'submitted') throw new ConflictException('Submitted analysis is immutable');
        const nextResponses = { ...attempt.responses, [stepId]: normalizeResponse(input.response) };
        const nextStep = Math.max(0, Math.min(steps.length - 1, input.currentStep));
        if (attempt.revision !== input.expectedRevision) {
          const samePayload = JSON.stringify(attempt.responses[stepId]) === JSON.stringify(nextResponses[stepId]) && attempt.current_step === nextStep;
          if (!samePayload) throw new ConflictException('Analysis draft changed in another session');
          await client.query('commit');
          return;
        }
        await client.query(
          `update teaching_assignment_attempts set responses = $2::jsonb, current_step = $3,
           revision = revision + 1, updated_at = now() where attempt_id = $1`,
          [attempt.attempt_id, JSON.stringify(nextResponses), nextStep],
        );
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
    });
    return this.journey(accountId, assignmentId);
  }

  async submit(accountId: string, assignmentId: string): Promise<AnalysisJourney> {
    const assignment = await this.assignmentForMember(accountId, assignmentId);
    this.assertOpen(assignment);
    await this.database.withClient(async client => {
      await client.query('begin');
      try {
        await this.assertOpenForWrite(client, assignmentId);
        const attempt = await this.lockAttempt(client, accountId, assignmentId);
        if (attempt.status === 'submitted') { await client.query('commit'); return; }
        const steps = assignment.journey_definition.steps ?? [];
        this.validateSubmission(steps, attempt.responses, attempt.evidence_snapshot);
        const result = this.score(steps, assignment.rubric_definition, attempt.responses, attempt.evidence_snapshot);
        await client.query(
          `update teaching_assignment_attempts set status = 'submitted', rubric_result = $2::jsonb,
           current_step = $3, revision = revision + 1, submitted_at = now(), updated_at = now()
           where attempt_id = $1`,
          [attempt.attempt_id, JSON.stringify(result), Math.max(0, steps.length - 1)],
        );
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
    });
    return this.journey(accountId, assignmentId);
  }

  async result(accountId: string, assignmentId: string): Promise<AnalysisResult> {
    const journey = await this.journey(accountId, assignmentId);
    if (!journey.result) throw new NotFoundException('Analysis result is not available');
    return journey.result;
  }

  async teacherProgress(viewerId: string, classroomId: string, assignmentId: string, admin: boolean): Promise<TeacherAssignmentDashboard> {
    const assignments = await this.database.query<AssignmentRow>(`${ASSIGNMENT_SELECT}
      left join teaching_assignment_attempts attempt on attempt.assignment_id = a.assignment_id and attempt.account_id = $3
      where a.assignment_id = $1 and a.classroom_id = $2`, [assignmentId, classroomId, viewerId]);
    const assignment = assignments[0];
    if (!assignment) throw new NotFoundException('Assignment not found');
    if (!admin && assignment.owner_account_id !== viewerId) throw new ForbiddenException('Teacher does not own this classroom');
    const rows = await this.database.query<{
      [key: string]: unknown; account_id: string; display_name: string; status: 'draft' | 'submitted' | null;
      current_step: number | null; score: string | null; updated_at: Date | null; submitted_at: Date | null;
    }>(
      `select member.account_id, coalesce(profile.display_name, account.display_name, 'Học viên') display_name,
        attempt.status, attempt.current_step, attempt.rubric_result->>'score' score, attempt.updated_at, attempt.submitted_at
       from teaching_classroom_members member
       left join player_profiles profile on profile.account_id::text = member.account_id
       left join accounts account on account.account_id::text = member.account_id
       left join teaching_assignment_attempts attempt on attempt.assignment_id = $2 and attempt.account_id = member.account_id
       where member.classroom_id = $1 and member.role = 'student' order by display_name`,
      [classroomId, assignmentId],
    );
    const totalSteps = assignment.journey_definition.steps?.length ?? 0;
    const learners: TeacherLearnerProgress[] = rows.map(row => ({
      accountId: row.account_id,
      displayName: row.display_name,
      status: row.status ?? 'not_started',
      currentStep: row.current_step ?? 0,
      totalSteps,
      score: row.score === null ? undefined : Number(row.score),
      updatedAt: row.updated_at?.toISOString(),
      submittedAt: row.submitted_at?.toISOString(),
    }));
    const submitted = learners.filter(item => item.status === 'submitted');
    const scores = submitted.map(item => item.score).filter((score): score is number => score !== undefined);
    return {
      assignment: readAssignment(assignment),
      scenarioTitle: assignment.scenario_title,
      learners,
      completionRate: learners.length ? submitted.length / learners.length : 0,
      averageScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : undefined,
    };
  }

  private async assignmentForMember(accountId: string, assignmentId: string): Promise<AssignmentRow> {
    const rows = await this.database.query<AssignmentRow>(`${ASSIGNMENT_SELECT}
      join teaching_classroom_members member on member.classroom_id = a.classroom_id and member.account_id = $2 and member.role = 'student'
      left join teaching_assignment_attempts attempt on attempt.assignment_id = a.assignment_id and attempt.account_id = $2
      where a.assignment_id = $1`, [assignmentId, accountId]);
    const row = rows[0];
    if (!row) throw new NotFoundException('Assignment not found for this learner');
    return row;
  }

  private assertOpen(row: AssignmentRow): void {
    const now = Date.now();
    if (now < row.opens_at.getTime()) throw new ConflictException('Assignment has not opened');
    if (now > row.closes_at.getTime()) throw new ConflictException('Assignment is closed');
  }

  private async lockAttempt(client: PoolClient, accountId: string, assignmentId: string): Promise<AttemptRow> {
    const result = await client.query<AttemptRow>(
      'select * from teaching_assignment_attempts where assignment_id = $1 and account_id = $2 for update',
      [assignmentId, accountId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Analysis attempt has not started');
    return row;
  }

  private async assertOpenForWrite(client: PoolClient, assignmentId: string): Promise<void> {
    const result = await client.query<{ is_open: boolean }>(
      `select opens_at <= now() and closes_at >= now() is_open
       from teaching_assignments where assignment_id = $1 for update`,
      [assignmentId],
    );
    if (!result.rows[0]) throw new NotFoundException('Assignment not found');
    if (!result.rows[0].is_open) throw new ConflictException('Assignment is outside its active window');
  }

  private summary(row: AssignmentRow): TeachingAssignmentSummary {
    const now = Date.now();
    return {
      ...readAssignment(row),
      classroomName: row.classroom_name,
      scenarioTitle: row.scenario_title,
      scenarioRevision: row.scenario_revision,
      availability: now < row.opens_at.getTime() ? 'upcoming' : now > row.closes_at.getTime() ? 'closed' : 'open',
      attemptStatus: row.attempt_status ?? 'not_started',
      attemptScore: row.rubric_result?.score,
      attemptUpdatedAt: row.updated_at?.toISOString(),
    };
  }

  private readJourney(row: AssignmentRow): AnalysisJourney {
    const scenario: ScenarioPack = {
      scenarioId: row.scenario_id,
      title: row.scenario_title,
      description: row.scenario_description,
      filters: row.scenario_filters,
      learningObjectives: row.learning_objectives,
      immutableRevision: row.scenario_revision,
      estimatedMinutes: Number(row.journey_definition.estimatedMinutes ?? 60),
      journeySteps: row.journey_definition.steps ?? [],
    };
    return {
      assignment: this.summary(row),
      scenario,
      evidence: row.evidence_snapshot ?? [],
      attempt: readAttempt(row),
      result: row.rubric_result ?? undefined,
    };
  }

  private validateDraftResponse(response: AnalysisStepResponse, evidence: AnalysisEvidenceCard[]): void {
    if (!response || typeof response.narrative !== 'string' || response.narrative.length > 4_000 || !Array.isArray(response.evidenceIds) || response.evidenceIds.length > 20) {
      throw new BadRequestException('Invalid analysis response');
    }
    const validIds = new Set(evidence.map(item => item.evidenceId));
    if (response.evidenceIds.some(id => typeof id !== 'string' || !validIds.has(id))) throw new BadRequestException('Unknown evidence selection');
  }

  private validateSubmission(steps: AnalysisJourneyStep[], responses: Record<string, AnalysisStepResponse>, evidence: AnalysisEvidenceCard[]): void {
    if (steps.length !== 10) throw new ConflictException('Scenario journey is not configured');
    for (const step of steps) {
      const response = responses[step.stepId];
      if (!response) throw new BadRequestException(`Step ${step.stepId} is incomplete`);
      this.validateDraftResponse(response, evidence);
      if (response.narrative.trim().length < step.minNarrativeLength || new Set(response.evidenceIds).size < step.minEvidenceCount) {
        throw new BadRequestException(`Step ${step.stepId} is incomplete`);
      }
    }
  }

  private score(steps: AnalysisJourneyStep[], rubric: AssignmentRow['rubric_definition'], responses: Record<string, AnalysisStepResponse>, evidence: AnalysisEvidenceCard[]): AnalysisResult {
    const evidenceById = new Map(evidence.map(item => [item.evidenceId, item]));
    let completion = 0;
    let evidenceScore = 0;
    let reasoning = 0;
    for (const step of steps) {
      const response = responses[step.stepId];
      completion += 4;
      const expected = new Set(rubric.steps?.find(item => item.stepId === step.stepId)?.expectedCategories ?? step.evidenceCategories);
      const selected = response.evidenceIds.map(id => evidenceById.get(id)).filter((item): item is AnalysisEvidenceCard => Boolean(item));
      const fit = selected.filter(item => expected.has(item.category)).length / Math.max(1, step.minEvidenceCount);
      evidenceScore += Math.min(4, fit * 4);
      reasoning += response.narrative.trim().length >= step.minNarrativeLength * 1.5 ? 2 : 1;
    }
    const dimensions = [
      { dimension: 'completion' as const, score: Math.round(completion), maxScore: 40, feedback: 'Hoàn thành đủ 10 chặng phân tích.' },
      { dimension: 'evidence' as const, score: Math.round(evidenceScore), maxScore: 40, feedback: evidenceScore >= 32 ? 'Evidence phù hợp với câu hỏi.' : 'Cần chọn evidence sát hơn với từng luận điểm.' },
      { dimension: 'reasoning' as const, score: Math.round(reasoning), maxScore: 20, feedback: reasoning >= 16 ? 'Lập luận có chiều sâu và nêu rõ uncertainty.' : 'Cần giải thích chuỗi nguyên nhân và guardrail rõ hơn.' },
    ];
    const score = dimensions.reduce((sum, item) => sum + item.score, 0);
    return {
      score,
      maxScore: 100,
      dimensions,
      strengths: [completion === 40 ? 'Hoàn thành toàn bộ journey' : 'Đã bắt đầu journey', evidenceScore >= 32 ? 'Evidence selection tốt' : 'Có sử dụng evidence'],
      nextSteps: [evidenceScore < 32 ? 'Đối chiếu lại evidence theo đúng metric của từng bước.' : 'Kiểm tra thêm các phân khúc và sample size.', reasoning < 16 ? 'Nêu rõ giả thuyết thay thế và guardrail.' : 'Chuyển đề xuất thành kế hoạch experiment.'],
      submittedAt: new Date().toISOString(),
    };
  }

  private async buildEvidence(filters: Record<string, unknown>): Promise<AnalysisEvidenceCard[]> {
    const platform = typeof filters.platform === 'string' ? filters.platform : 'Android';
    const countries = Array.isArray(filters.countries) ? filters.countries.filter((item): item is string => typeof item === 'string') : ['VN', 'TH', 'PH', 'ID'];
    const levels = Array.isArray(filters.levels) ? filters.levels.map(String) : ['28', '29', '30'];
    const versions = [...new Set(['2.0.2', '2.1.0', '2.1.1', String(filters.appVersion ?? ''), String(filters.compareTo ?? '')].filter(Boolean))];
    const [activity, tutorial, retention, progression, economy, monetization, acquisition, spend, liveops, experiments] = await Promise.all([
      this.database.query<AggregateRow>(`select app_version, count(distinct user_id)::text sample_size,
        avg(nullif(sessions,'')::numeric)::text metric_a, avg(nullif(playtime_minutes,'')::numeric)::text metric_b
        from jelly_analytics.player_daily where platform = $1 and country = any($2::text[]) group by app_version`, [platform, countries]),
      this.database.query<AggregateRow>(`select app_version, rows::text sample_size, completion_rate::text metric_a
        from jelly_analytics.tutorial_step4_health where platform = $1 and region = 'SEA'`, [platform]),
      this.database.query<AggregateRow>(`select cohort.app_version_install app_version,
        count(distinct cohort.user_id)::text sample_size,
        (count(distinct case when daily.cohort_day = '1' then daily.user_id end)::numeric / nullif(count(distinct cohort.user_id),0))::text metric_a,
        (count(distinct case when daily.cohort_day = '7' then daily.user_id end)::numeric / nullif(count(distinct cohort.user_id),0))::text metric_b
        from jelly_analytics.users cohort
        left join jelly_analytics.player_daily daily on daily.user_id = cohort.user_id and daily.cohort_day in ('1','7')
        where cohort.platform = $1 and cohort.country = any($2::text[]) group by cohort.app_version_install`, [platform, countries]),
      this.database.query<AggregateRow>(`select app_version, level_id, count(*)::text sample_size,
        avg(case when result = 'complete' then 1.0 else 0.0 end)::text metric_a,
        avg(case when result <> 'complete' then 1.0 else 0.0 end)::text metric_b
        from jelly_analytics.level_attempts where platform = $1 and country = any($2::text[]) and level_id = any($3::text[])
        group by app_version, level_id`, [platform, countries, levels]),
      this.database.query<AggregateRow>(`select app_version, count(*)::text sample_size,
        avg(nullif(boosters_used,'')::numeric)::text metric_a,
        avg(nullif(extra_moves_purchased,'')::numeric)::text metric_b
        from jelly_analytics.player_daily where platform = $1 and country = any($2::text[]) group by app_version`, [platform, countries]),
      this.database.query<AggregateRow>(`select app_version, count(distinct user_id)::text sample_size,
        avg(nullif(iap_revenue,'')::numeric)::text metric_a, avg(nullif(ad_revenue,'')::numeric)::text metric_b
        from jelly_analytics.player_daily where platform = $1 and country = any($2::text[]) group by app_version`, [platform, countries]),
      this.database.query<AggregateRow>(`select app_version, channel, count(distinct user_id)::text sample_size,
        avg(nullif(max_level,'')::numeric)::text metric_a
        from jelly_analytics.player_daily where platform = $1 and country = any($2::text[]) group by app_version, channel`, [platform, countries]),
      this.database.query<AggregateRow>(`select channel, count(*)::text sample_size, sum(nullif(spend_usd,'')::numeric)::text metric_a
        from jelly_analytics.campaign_spend where target_platform = $1 and country = any($2::text[]) group by channel`, [platform, countries]),
      this.database.query<AggregateRow>(`select mechanic channel, count(*)::text sample_size from jelly_analytics.liveops_events group by mechanic`, []),
      this.database.query<AggregateRow>(`select experiment_id, variant, count(distinct user_id)::text sample_size
        from jelly_analytics.ab_assignments where platform = $1 and country = any($2::text[]) group by experiment_id, variant`, [platform, countries]),
    ]);
    const cards: AnalysisEvidenceCard[] = [card('brief.scope', 'brief', 'Phạm vi scenario', `${platform} · SEA · ${versions.join(' vs ')}`, 'text', 'Scenario', undefined, 'ready')];
    for (const version of versions) {
      const activityRow = activity.find(row => row.app_version === version);
      cards.push(card(`activity.sessions.${version}`, 'activity', `Sessions/người · ${version}`, numberOrNull(activityRow?.metric_a), 'ratio', `${platform} SEA`, count(activityRow), maturity(activityRow)));
      cards.push(card(`activity.playtime.${version}`, 'activity', `Playtime/người · ${version}`, numberOrNull(activityRow?.metric_b), 'minutes', `${platform} SEA`, count(activityRow), maturity(activityRow)));
      const tutorialRow = tutorial.find(row => row.app_version === version);
      cards.push(card(`activation.step4.${version}`, 'activation', `Step 4 completion · ${version}`, percentOrNull(tutorialRow?.metric_a), 'percent', `${platform} SEA`, count(tutorialRow), maturity(tutorialRow)));
      const retentionRow = retention.find(row => row.app_version === version);
      cards.push(card(`retention.d1.${version}`, 'retention', `D1 retention · ${version}`, percentOrNull(retentionRow?.metric_a), 'percent', `${platform} SEA`, count(retentionRow), maturity(retentionRow)));
      cards.push(card(`retention.d7.${version}`, 'retention', `D7 retention · ${version}`, percentOrNull(retentionRow?.metric_b), 'percent', `${platform} SEA`, count(retentionRow), maturity(retentionRow), version === '2.1.1' ? 'D7 có thể chưa mature trong cửa sổ dữ liệu.' : undefined));
      for (const level of levels) {
        const row = progression.find(item => item.app_version === version && item.level_id === level);
        cards.push(card(`progression.win.${version}.${level}`, 'progression', `Level ${level} win rate · ${version}`, percentOrNull(row?.metric_a), 'percent', `${platform} SEA`, count(row), maturity(row), row ? undefined : 'Không có attempt trong lát cắt này.'));
      }
      const economyRow = economy.find(row => row.app_version === version);
      cards.push(card(`economy.boosters.${version}`, 'economy', `Boosters/người-ngày · ${version}`, numberOrNull(economyRow?.metric_a), 'ratio', `${platform} SEA`, count(economyRow), maturity(economyRow)));
      cards.push(card(`economy.extra-moves.${version}`, 'economy', `Extra moves/người-ngày · ${version}`, numberOrNull(economyRow?.metric_b), 'ratio', `${platform} SEA`, count(economyRow), maturity(economyRow)));
      const monetizationRow = monetization.find(row => row.app_version === version);
      cards.push(card(`monetization.iap.${version}`, 'monetization', `IAP/người-ngày · ${version}`, numberOrNull(monetizationRow?.metric_a), 'currency', `${platform} SEA`, count(monetizationRow), maturity(monetizationRow)));
      cards.push(card(`monetization.ads.${version}`, 'monetization', `Ad revenue/người-ngày · ${version}`, numberOrNull(monetizationRow?.metric_b), 'currency', `${platform} SEA`, count(monetizationRow), maturity(monetizationRow)));
    }
    for (const row of acquisition) cards.push(card(`acquisition.quality.${row.app_version}.${row.channel}`, 'acquisition', `Avg max level · ${row.channel} · ${row.app_version}`, numberOrNull(row.metric_a), 'ratio', `${platform} SEA`, count(row), maturity(row)));
    for (const row of spend) cards.push(card(`acquisition.spend.${row.channel}`, 'acquisition', `Campaign spend · ${row.channel}`, numberOrNull(row.metric_a), 'currency', `${platform} SEA`, count(row), maturity(row)));
    for (const row of liveops) cards.push(card(`liveops.${row.channel}`, 'liveops', `LiveOps events · ${row.channel}`, count(row), 'count', 'Event catalog', count(row), maturity(row)));
    for (const row of experiments) cards.push(card(`experiment.${row.experiment_id}.${row.variant}`, 'experiment', `${row.experiment_id} · ${row.variant}`, count(row), 'count', `${platform} SEA`, count(row), maturity(row)));
    return cards;
  }
}

const ASSIGNMENT_SELECT = `select a.*, c.name classroom_name, c.owner_account_id,
  scenario.title scenario_title, scenario.description scenario_description, scenario.filters scenario_filters,
  scenario.learning_objectives, attempt.attempt_id, attempt.status attempt_status, attempt.revision attempt_revision,
  attempt.current_step attempt_current_step, attempt.responses attempt_responses, attempt.evidence_snapshot,
  attempt.rubric_result, attempt.started_at, attempt.updated_at, attempt.submitted_at
  from teaching_assignments a join teaching_classrooms c on c.classroom_id = a.classroom_id
  join teaching_scenario_packs scenario on scenario.scenario_id = a.scenario_id`;

function readAssignment(row: AssignmentRow): TeachingAssignment {
  return { assignmentId: row.assignment_id, classroomId: row.classroom_id, scenarioId: row.scenario_id, title: row.title, opensAt: row.opens_at.toISOString(), closesAt: row.closes_at.toISOString() };
}

function readAttempt(row: AssignmentRow): AnalysisAttempt {
  if (!row.attempt_id || !row.attempt_status || row.attempt_revision === null || row.attempt_current_step === null || !row.started_at || !row.updated_at) throw new NotFoundException('Analysis attempt has not started');
  return {
    attemptId: row.attempt_id,
    assignmentId: row.assignment_id,
    status: row.attempt_status,
    currentStep: row.attempt_current_step,
    revision: row.attempt_revision,
    responses: row.attempt_responses ?? {},
    startedAt: row.started_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString(),
  };
}

function normalizeResponse(response: AnalysisStepResponse): AnalysisStepResponse {
  return { narrative: response.narrative.trimStart(), evidenceIds: [...new Set(response.evidenceIds)] };
}

function numberOrNull(value: string | null | undefined): number | null { const parsed = Number(value); return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null; }
function percentOrNull(value: string | null | undefined): number | null { const parsed = numberOrNull(value); return parsed === null ? null : parsed * 100; }
function count(row: AggregateRow | undefined): number { return Number(row?.sample_size ?? 0); }
function maturity(row: AggregateRow | undefined): 'ready' | 'limited' | 'missing' { const size = count(row); return size >= 50 ? 'ready' : size > 0 ? 'limited' : 'missing'; }
function card(evidenceId: string, category: AnalysisEvidenceCategory, label: string, value: number | string | null, unit: AnalysisEvidenceCard['unit'], segment: string, sampleSize: number | undefined, dataMaturity: AnalysisEvidenceCard['maturity'], note?: string): AnalysisEvidenceCard {
  return { evidenceId, category, label, value, unit, segment, sampleSize, maturity: dataMaturity, note };
}
