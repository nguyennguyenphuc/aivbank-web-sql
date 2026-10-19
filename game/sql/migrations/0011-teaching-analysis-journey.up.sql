alter table teaching_scenario_packs
  add column journey_definition jsonb not null default '{"estimatedMinutes":45,"steps":[]}'::jsonb,
  add column rubric_definition jsonb not null default '{"steps":[]}'::jsonb;

alter table teaching_assignments
  add column scenario_revision text,
  add column journey_definition jsonb,
  add column rubric_definition jsonb;

update teaching_scenario_packs
set journey_definition = $journey$
{
  "estimatedMinutes": 60,
  "steps": [
    {"stepId":"brief","title":"1. Brief & giả thuyết","prompt":"Tóm tắt vấn đề kinh doanh và nêu giả thuyết nguyên nhân chính.","guidance":"Phân biệt triệu chứng, phân khúc bị ảnh hưởng và giả thuyết có thể kiểm chứng.","minNarrativeLength":80,"minEvidenceCount":2,"evidenceCategories":["brief","activation","progression"]},
    {"stepId":"activity","title":"2. Activity & engagement","prompt":"Đánh giá thay đổi về người chơi hoạt động, số phiên và thời lượng chơi.","guidance":"So sánh phiên bản mục tiêu với baseline, chú ý sample size.","minNarrativeLength":80,"minEvidenceCount":2,"evidenceCategories":["activity"]},
    {"stepId":"activation","title":"3. Tutorial activation","prompt":"Phân tích tutorial step 4 và xác định mức độ regression hoặc recovery.","guidance":"Dùng completion rate của cùng platform/region qua các phiên bản.","minNarrativeLength":80,"minEvidenceCount":2,"evidenceCategories":["activation"]},
    {"stepId":"retention","title":"4. D1/D7 retention","prompt":"Đánh giá tác động retention và độ trưởng thành của dữ liệu.","guidance":"Không diễn giải dữ liệu thiếu như tỷ lệ 0%; ghi rõ uncertainty.","minNarrativeLength":90,"minEvidenceCount":2,"evidenceCategories":["retention"]},
    {"stepId":"progression","title":"5. Levels 28–30","prompt":"Chẩn đoán difficulty spike và level gây ma sát lớn nhất.","guidance":"Đối chiếu win rate, non-complete rate và số lượt thử theo level.","minNarrativeLength":100,"minEvidenceCount":3,"evidenceCategories":["progression"]},
    {"stepId":"economy","title":"6. Booster & extra moves","prompt":"Phân tích áp lực booster/extra move và rủi ro pay-to-progress.","guidance":"Liên kết hành vi economy với difficulty, không kết luận chỉ từ volume.","minNarrativeLength":80,"minEvidenceCount":2,"evidenceCategories":["economy"]},
    {"stepId":"monetization","title":"7. Monetization guardrails","prompt":"Đánh giá IAP và ad revenue cùng rủi ro đánh đổi trải nghiệm.","guidance":"Revenue tăng không tự động chứng minh thay đổi là tốt.","minNarrativeLength":80,"minEvidenceCount":2,"evidenceCategories":["monetization"]},
    {"stepId":"acquisition","title":"8. User acquisition","prompt":"Kiểm tra channel/campaign mix có thể gây nhiễu kết luận sản phẩm.","guidance":"So sánh volume, spend và chất lượng cohort theo channel.","minNarrativeLength":80,"minEvidenceCount":2,"evidenceCategories":["acquisition"]},
    {"stepId":"liveops","title":"9. LiveOps & confounders","prompt":"Đánh giá sự kiện LiveOps có thể ảnh hưởng các KPI quan sát được.","guidance":"Phân biệt tương quan theo thời gian với quan hệ nhân quả.","minNarrativeLength":70,"minEvidenceCount":1,"evidenceCategories":["liveops"]},
    {"stepId":"capstone","title":"10. A/B, RCA & đề xuất","prompt":"Viết kết luận RCA, đề xuất hành động và guardrail để đo thành công.","guidance":"Nêu mức tin cậy, dữ liệu còn thiếu và quyết định ship/rollback/iterate.","minNarrativeLength":160,"minEvidenceCount":3,"evidenceCategories":["experiment","activation","retention","progression"]}
  ]
}
$journey$::jsonb,
rubric_definition = $rubric$
{
  "steps": [
    {"stepId":"brief","expectedCategories":["activation","progression"]},
    {"stepId":"activity","expectedCategories":["activity"]},
    {"stepId":"activation","expectedCategories":["activation"]},
    {"stepId":"retention","expectedCategories":["retention"]},
    {"stepId":"progression","expectedCategories":["progression"]},
    {"stepId":"economy","expectedCategories":["economy"]},
    {"stepId":"monetization","expectedCategories":["monetization"]},
    {"stepId":"acquisition","expectedCategories":["acquisition"]},
    {"stepId":"liveops","expectedCategories":["liveops"]},
    {"stepId":"capstone","expectedCategories":["experiment","activation","retention","progression"]}
  ]
}
$rubric$::jsonb;

update teaching_assignments a
set scenario_revision = s.immutable_revision,
    journey_definition = s.journey_definition,
    rubric_definition = s.rubric_definition
from teaching_scenario_packs s
where s.scenario_id = a.scenario_id;

alter table teaching_assignments
  alter column scenario_revision set not null,
  alter column journey_definition set not null,
  alter column rubric_definition set not null;

create table teaching_assignment_attempts (
  attempt_id uuid primary key,
  assignment_id text not null references teaching_assignments(assignment_id) on delete cascade,
  account_id text not null,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  current_step integer not null default 0 check (current_step >= 0 and current_step <= 9),
  revision integer not null default 0 check (revision >= 0),
  responses jsonb not null default '{}'::jsonb check (jsonb_typeof(responses) = 'object'),
  evidence_snapshot jsonb not null check (jsonb_typeof(evidence_snapshot) = 'array'),
  rubric_result jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  unique (assignment_id, account_id)
);

create index teaching_assignment_attempts_account_idx
  on teaching_assignment_attempts (account_id, updated_at desc);
create index teaching_assignment_attempts_assignment_idx
  on teaching_assignment_attempts (assignment_id, status, updated_at desc);
