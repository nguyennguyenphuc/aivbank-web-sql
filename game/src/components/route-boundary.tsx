import { Component, Suspense } from 'react';
import type { ReactNode } from 'react';

export class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  declare props: Readonly<{ children: ReactNode }>;
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <section role="alert" className="mx-auto my-12 max-w-md rounded-3xl bg-white p-6 text-center text-slate-800 shadow">
      <h1 className="text-xl font-bold">Chưa mở được màn hình</h1>
      <p className="my-3">Kiểm tra kết nối rồi tải lại. Event log vẫn có thể mở để xem lại phiên này.</p>
      <button onClick={() => window.location.reload()} className="min-h-11 rounded-xl bg-teal-800 px-5 py-3 font-bold text-white">Tải lại</button>
    </section>;
    return <Suspense fallback={<div role="status" className="p-12 text-center font-bold text-slate-700">Đang mở màn hình…</div>}>{this.props.children}</Suspense>;
  }
}
