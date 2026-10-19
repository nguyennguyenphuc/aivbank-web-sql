import type { PlayerQuestState } from '../../../shared/contracts/liveops';

export function QuestPanel({ quest, language, onClaim }: { quest?: PlayerQuestState; language: 'vi' | 'en'; onClaim?: (questId: string) => Promise<void> }) {
  if (!quest) return null;
  const percent = Math.min(100, Math.round((quest.progress / quest.target) * 100));
  return (
    <section className="rounded-2xl border-2 border-[#5EADFF] bg-white p-3 text-[#315F8A] shadow-sm">
      <div className="flex items-center justify-between text-xs font-black">
        <span>🎯 {language === 'vi' ? 'Nhiệm vụ' : 'Quest'}</span>
        <span>{quest.progress}/{quest.target}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#DDEEFF]" role="progressbar" aria-valuenow={quest.progress} aria-valuemin={0} aria-valuemax={quest.target}>
        <div className="h-full bg-[#5EADFF] transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      {quest.claimable && <button onClick={() => void onClaim?.(quest.questId)} className="mt-2 w-full rounded-lg bg-[#71B15A] px-2 py-1 text-[10px] font-black text-white">✨ {language === 'vi' ? 'Nhận thưởng' : 'Claim reward'}</button>}
      {quest.claimed && <p className="mt-1 text-[10px] font-black text-[#4A7A37]">✅ {language === 'vi' ? 'Đã nhận' : 'Claimed'}</p>}
    </section>
  );
}
