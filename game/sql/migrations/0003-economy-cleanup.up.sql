alter table economy_journal_lines
  drop constraint if exists economy_journal_lines_journal_id_fkey;

alter table economy_journal_lines
  add constraint economy_journal_lines_journal_id_fkey
  foreign key (journal_id) references economy_journals(journal_id) on delete cascade;
