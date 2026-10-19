import type { CompetitionMetaState } from '../../../shared/contracts/competition';

export function StreakBadge({ meta, language }: { meta?: CompetitionMetaState; language: 'vi' | 'en' }) {
  if (!meta) return null;
  return (
    <section className="flex items-center justify-between rounded-2xl border-2 border-[#FF9F1A] bg-[#FFF1CC] p-3 text-xs font-black text-[#855D00] shadow-sm">
      <span>🔥 {language === 'vi' ? 'Chuỗi thắng' : 'Win streak'} {meta.currentStreak}</span>
      <span aria-label={language === 'vi' ? 'Khiên' : 'Shields'}>🛡️ {meta.shields} · {meta.league}</span>
    </section>
  );
}
