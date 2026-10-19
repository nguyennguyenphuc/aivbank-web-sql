import type { LeaderboardPage } from '../../../shared/contracts/competition';

export function LeaderboardPanel({ page, language }: { page?: LeaderboardPage; language: 'vi' | 'en' }) {
  return (
    <section aria-label={language === 'vi' ? 'Bảng xếp hạng' : 'Leaderboard'} className="rounded-2xl border-2 border-[#FF9F1A] bg-white p-3 shadow-sm">
      <h3 className="text-xs font-black uppercase tracking-wide text-[#855D00]">🏆 {language === 'vi' ? 'Xếp hạng toàn cầu' : 'Global leaders'}</h3>
      <ol className="mt-2 space-y-1 text-xs font-bold text-[#4A3B2C]">
        {(page?.entries ?? []).map(entry => (
          <li key={entry.playerId} className="flex justify-between gap-3 rounded-lg bg-[#FFF9E6] px-2 py-1">
            <span className="truncate">#{entry.rank} {entry.displayName}</span>
            <span>{entry.score.toLocaleString()}</span>
          </li>
        ))}
        {!page?.entries.length && <li className="text-[#A67C00]">{language === 'vi' ? 'Chưa có thứ hạng' : 'No ranks yet'}</li>}
      </ol>
    </section>
  );
}
