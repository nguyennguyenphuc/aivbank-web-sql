import type {
  AnalysisJourney,
  AnalysisResult,
  ClassroomMembershipSummary,
  ClassroomSummary,
  SaveAnalysisStepRequest,
  ScenarioPack,
  TeacherAssignmentDashboard,
  TeachingAssignment,
  TeachingAssignmentSummary,
} from '../../../shared/contracts/classroom';
import { apiFetch } from '../auth/api-client';

export const classroomApi = {
  scenarios: () => apiFetch<ScenarioPack[]>('/api/v1/classrooms/scenarios'),
  mine: () => apiFetch<ClassroomMembershipSummary[]>('/api/v1/classrooms/mine'),
  assignments: () => apiFetch<TeachingAssignmentSummary[]>('/api/v1/classrooms/assignments/mine'),
  teacherAssignments: (classroomId: string) => apiFetch<TeachingAssignmentSummary[]>(`/api/v1/classrooms/${classroomId}/assignments`),
  join: (joinCode: string) => apiFetch<ClassroomSummary>('/api/v1/classrooms/join', { method: 'POST', body: JSON.stringify({ joinCode }) }),
  create: (name: string) => apiFetch<ClassroomSummary>('/api/v1/classrooms', { method: 'POST', body: JSON.stringify({ name }) }),
  assign: (classroomId: string, body: { scenarioId: string; title: string; opensAt: string; closesAt: string }) =>
    apiFetch<TeachingAssignment>(`/api/v1/classrooms/${classroomId}/assignments`, { method: 'POST', body: JSON.stringify(body) }),
  start: (assignmentId: string) => apiFetch<AnalysisJourney>(`/api/v1/classrooms/assignments/${assignmentId}/start`, { method: 'POST' }),
  journey: (assignmentId: string) => apiFetch<AnalysisJourney>(`/api/v1/classrooms/assignments/${assignmentId}/journey`),
  saveStep: (assignmentId: string, stepId: string, body: SaveAnalysisStepRequest) =>
    apiFetch<AnalysisJourney>(`/api/v1/classrooms/assignments/${assignmentId}/steps/${stepId}`, { method: 'POST', body: JSON.stringify(body) }),
  submit: (assignmentId: string) => apiFetch<AnalysisJourney>(`/api/v1/classrooms/assignments/${assignmentId}/submit`, { method: 'POST' }),
  result: (assignmentId: string) => apiFetch<AnalysisResult>(`/api/v1/classrooms/assignments/${assignmentId}/result`),
  progress: (classroomId: string, assignmentId: string) => apiFetch<TeacherAssignmentDashboard>(`/api/v1/classrooms/${classroomId}/assignments/${assignmentId}/progress`),
};
