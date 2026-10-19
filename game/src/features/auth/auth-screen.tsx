import { FormEvent, useState } from 'react';
import { EMBEDDED_IN_AIVB, useAuth } from './auth-context';

export function AuthScreen() {
  const { login, continueAsGuest, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await login(email, password); } finally { setBusy(false); }
  };
  if (EMBEDDED_IN_AIVB) {
    // Trong AIV Bank chỉ có một cách vào: phiên AIV Bank. Không cho chơi khách
    // hay đăng nhập email, để mọi lượt chơi đều gắn với user đã đồng bộ.
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top,#FFF4B8,#FFD6E8_48%,#CFEAFF)] p-5 flex items-center justify-center">
        <section className="w-full max-w-md rounded-[2rem] border-4 border-white bg-white/90 p-6 shadow-2xl text-center" aria-labelledby="welcome-title">
          <div className="text-6xl" aria-hidden>🍬</div>
          <h1 id="welcome-title" className="mt-2 font-heading text-3xl font-black text-[#855D00]">Vương Quốc Kẹo Ngọt</h1>
          <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm font-bold text-[#6B5A45]">{error ?? 'Hãy đăng nhập AIV Bank rồi mở lại tab Trò chơi.'}</p>
          <button onClick={() => window.location.reload()} className="mt-5 w-full rounded-2xl bg-[#FF9F1A] px-4 py-3 font-black text-white shadow-[0_5px_0_#C76800]">Thử lại</button>
        </section>
      </main>
    );
  }
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#FFF4B8,#FFD6E8_48%,#CFEAFF)] p-5 flex items-center justify-center">
      <section className="w-full max-w-md rounded-[2rem] border-4 border-white bg-white/90 p-6 shadow-2xl" aria-labelledby="welcome-title">
        <div className="text-center text-6xl" aria-hidden>🍬</div>
        <h1 id="welcome-title" className="mt-2 text-center font-heading text-3xl font-black text-[#855D00]">Jelly Trail Academy</h1>
        <p className="mt-2 text-center font-bold text-[#6B5A45]">Match-3 H5 · học qua dữ liệu · chơi dài hạn</p>
        <button disabled={busy} onClick={() => { setBusy(true); continueAsGuest('Học viên').finally(() => setBusy(false)); }} className="mt-6 w-full rounded-2xl bg-[#FF9F1A] px-4 py-3 font-black text-white shadow-[0_5px_0_#C76800] disabled:opacity-50">Chơi ngay với tư cách khách</button>
        <div className="my-5 flex items-center gap-3 text-xs font-black text-slate-400"><span className="h-px flex-1 bg-slate-200" />HOẶC<span className="h-px flex-1 bg-slate-200" /></div>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm font-black text-slate-700">Email<input value={email} onChange={event => setEmail(event.target.value)} type="email" required className="mt-1 w-full rounded-xl border-2 border-amber-200 px-3 py-2" /></label>
          <label className="block text-sm font-black text-slate-700">Mật khẩu<input value={password} onChange={event => setPassword(event.target.value)} type="password" required className="mt-1 w-full rounded-xl border-2 border-amber-200 px-3 py-2" /></label>
          <button disabled={busy} className="w-full rounded-2xl bg-[#5EADFF] px-4 py-3 font-black text-white shadow-[0_5px_0_#2878C7] disabled:opacity-50">Đăng nhập lớp học</button>
        </form>
        {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
      </section>
    </main>
  );
}
