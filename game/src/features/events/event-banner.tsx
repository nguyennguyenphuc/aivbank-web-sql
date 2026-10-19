import type { SeasonalEvent } from '../../../shared/contracts/liveops';

export function EventBanner({ event, language }: { event?: SeasonalEvent; language: 'vi' | 'en' }) {
  if (!event) return null;
  return (
    <section className="rounded-2xl border-2 border-[#71B15A] bg-[#EFFFF0] p-3 text-[#4A7A37] shadow-sm" aria-live="polite">
      <p className="text-[10px] font-black uppercase tracking-wider">🎉 {language === 'vi' ? 'Sự kiện đang diễn ra' : 'Live event'}</p>
      <h3 className="mt-1 text-sm font-black">{event.title}</h3>
    </section>
  );
}
