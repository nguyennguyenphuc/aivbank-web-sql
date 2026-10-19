export type AnalysisEvidenceCategory =
  | 'brief'
  | 'activity'
  | 'activation'
  | 'retention'
  | 'progression'
  | 'economy'
  | 'monetization'
  | 'acquisition'
  | 'liveops'
  | 'experiment';

export type AnalysisEvidenceMaturity = 'ready' | 'limited' | 'missing';
export type AnalysisAttemptStatus = 'not_started' | 'draft' | 'submitted';
export type AssignmentAvailability = 'upcoming' | 'open' | 'closed';

export interface AnalysisJourneyStep {
  stepId: string;
  title: string;
  prompt: string;
  guidance: string;
  minNarrativeLength: number;
  minEvidenceCount: number;
  evidenceCategories: AnalysisEvidenceCategory[];
}

export interface AnalysisEvidenceCard {
  evidenceId: string;
  category: AnalysisEvidenceCategory;
  label: string;
  value: number | string | null;
  unit: 'count' | 'percent' | 'currency' | 'minutes' | 'ratio' | 'text';
  segment: string;
  sampleSize?: number;
  maturity: AnalysisEvidenceMaturity;
  note?: string;
}

export interface AnalysisStepResponse {
  narrative: string;
  evidenceIds: string[];
}

export interface AnalysisAttempt {
  attemptId: string;
  assignmentId: string;
  status: Exclude<AnalysisAttemptStatus, 'not_started'>;
  currentStep: number;
  revision: number;
  responses: Record<string, AnalysisStepResponse>;
  startedAt: string;
  updatedAt: string;
  submittedAt?: string;
}

export interface AnalysisRubricDimension {
  dimension: 'completion' | 'evidence' | 'reasoning';
  score: number;
  maxScore: number;
  feedback: string;
}

export interface AnalysisResult {
  score: number;
  maxScore: 100;
  dimensions: AnalysisRubricDimension[];
  strengths: string[];
  nextSteps: string[];
  submittedAt: string;
}

export interface ScenarioPack {
  scenarioId: string;
  title: string;
  description: string;
  filters: Record<string, unknown>;
  learningObjectives: string[];
  immutableRevision: string;
  estimatedMinutes: number;
  journeySteps: AnalysisJourneyStep[];
}

export interface ClassroomSummary {
  classroomId: string;
  name: string;
  joinCode: string;
  rosterRevision: string;
  studentCount: number;
}

export interface TeachingAssignment {
  assignmentId: string;
  classroomId: string;
  scenarioId: string;
  title: string;
  opensAt: string;
  closesAt: string;
}

export interface ClassroomMembershipSummary extends ClassroomSummary {
  membershipRole: 'teacher' | 'student';
}

export interface TeachingAssignmentSummary extends TeachingAssignment {
  classroomName: string;
  scenarioTitle: string;
  scenarioRevision: string;
  availability: AssignmentAvailability;
  attemptStatus: AnalysisAttemptStatus;
  attemptScore?: number;
  attemptUpdatedAt?: string;
}

export interface AnalysisJourney {
  assignment: TeachingAssignmentSummary;
  scenario: ScenarioPack;
  evidence: AnalysisEvidenceCard[];
  attempt: AnalysisAttempt;
  result?: AnalysisResult;
}

export interface SaveAnalysisStepRequest {
  expectedRevision: number;
  currentStep: number;
  response: AnalysisStepResponse;
}

export interface TeacherLearnerProgress {
  accountId: string;
  displayName: string;
  status: AnalysisAttemptStatus;
  currentStep: number;
  totalSteps: number;
  score?: number;
  updatedAt?: string;
  submittedAt?: string;
}

export interface TeacherAssignmentDashboard {
  assignment: TeachingAssignment;
  scenarioTitle: string;
  learners: TeacherLearnerProgress[];
  completionRate: number;
  averageScore?: number;
}
