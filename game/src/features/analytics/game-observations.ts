export type GameMode = 'practice' | 'ranked';
export type AppScreen = 'login' | 'map' | 'practice' | 'ranked' | 'classroom' | 'analyst' | 'admin' | 'access_denied' | 'maintenance';
export interface AttemptScope { id: string; levelId: number; mode: GameMode }
export type GameObservation =
  | { type: 'screen_viewed'; screen: AppScreen }
  | { type: 'dialog_opened'; dialog: 'victory' | 'defeat' | 'shop' | 'spin' | 'guide' | 'settings' }
  | { type: 'attempt_selected' }
  | { type: 'level_started'; movesLeft: number }
  | { type: 'move_rejected'; reason: 'not_adjacent' | 'blocked' | 'no_match' }
  | { type: 'move_resolved'; score: number; delta: number; cascades: number; movesLeft: number }
  | { type: 'booster_used'; booster: string }
  | { type: 'booster_failed'; booster: string }
  | { type: 'booster_resolved'; booster: string; score: number; delta: number; movesLeft: number }
  | { type: 'board_shuffled' }
  | { type: 'level_completed'; score: number; baseScore: number; bonus: number; won: boolean }
  | { type: 'verification_started' }
  | { type: 'verification_completed'; score: number; won: boolean }
  | { type: 'verification_failed'; reason: 'rejected' | 'unavailable' }
  | { type: 'start_failed' };

export type ObservedEvent = GameObservation & { sequence: number; elapsedMs: number; source: 'client' | 'server-response'; attempt: AttemptScope | null };
export interface ObservationState {
  events: ObservedEvent[];
  count: number;
  startedAt: number | null;
  sessionStartedAt: number | null;
  currentAttempt: AttemptScope | null;
  screen: AppScreen | null;
  accepted: number;
  rejected: number;
  movePoints: number;
  cascades: number;
  score: number;
  movesLeft: number | null;
  status: 'waiting' | 'playing' | 'completed' | 'verifying' | 'verified' | 'rejected' | 'error';
  won: boolean | null;
  trend: { move: number; score: number }[];
}
export const EVENT_LIMIT = 120;
export const initialObservations: ObservationState = {
  events: [], count: 0, startedAt: null, accepted: 0, rejected: 0, movePoints: 0,
  cascades: 0, score: 0, movesLeft: null, status: 'waiting', won: null, trend: [],
  sessionStartedAt: null, currentAttempt: null, screen: null,
};

// Only explicitly typed game facts enter the local teaching stream: no request bodies or tokens.
export function observeGame(state: ObservationState, action: { event: GameObservation; now: number; attempt?: AttemptScope }): ObservationState {
  const { event, now, attempt } = action;
  const newAttempt = Boolean(attempt && attempt.id !== state.currentAttempt?.id);
  if (newAttempt && event.type !== 'attempt_selected' && event.type !== 'level_started' && event.type !== 'start_failed') return state;
  if (event.type === 'attempt_selected' && !newAttempt) return state;
  if (event.type === 'level_started' && !newAttempt && state.startedAt !== null) return state;
  if (event.type === 'screen_viewed' && event.screen === state.screen) return state;
  const next: ObservationState = {
    ...(newAttempt ? initialObservations : state),
    events: state.events, count: state.count + 1, screen: state.screen,
    sessionStartedAt: state.sessionStartedAt ?? now,
    currentAttempt: attempt ?? state.currentAttempt,
  };
  if (event.type === 'level_started') {
    next.startedAt = now;
    next.movesLeft = event.movesLeft;
    next.status = 'playing';
  } else if (event.type === 'move_resolved') {
    next.accepted++;
    next.movePoints += event.delta;
    next.cascades += event.cascades;
    next.score = event.score;
    next.movesLeft = event.movesLeft;
    next.trend = [...next.trend.slice(-29), { move: next.accepted, score: event.score }];
  } else if (event.type === 'booster_resolved') {
    next.score = event.score;
    next.movesLeft = event.movesLeft;
  } else if (event.type === 'move_rejected') next.rejected++;
  else if (event.type === 'level_completed' || event.type === 'verification_completed') {
    next.status = event.type === 'verification_completed' ? 'verified' : 'completed';
    next.score = event.score;
    next.won = event.won;
  } else if (event.type === 'verification_started') { next.status = 'verifying'; next.won = null; }
  else if (event.type === 'verification_failed') { next.status = event.reason === 'rejected' ? 'rejected' : 'error'; next.won = null; }
  else if (event.type === 'start_failed') next.status = 'error';
  else if (event.type === 'screen_viewed') next.screen = event.screen;
  const source = event.type === 'verification_completed' || event.type === 'booster_used' || (event.type === 'verification_failed' && event.reason === 'rejected') ? 'server-response' : 'client';
  const row: ObservedEvent = { ...event, source, attempt: attempt ?? null, sequence: next.count, elapsedMs: Math.max(0, now - next.sessionStartedAt!) };
  next.events = [...state.events.slice(-(EVENT_LIMIT - 1)), row];
  return next;
}

export const eventLessons: Record<GameObservation['type'], { vi: string; en: string; lesson: string; lessonEn: string }> = {
  screen_viewed: { vi: 'Đã mở màn hình', en: 'Screen viewed', lesson: 'Đây là một lần chuyển màn hình trong app, không phải lượt chơi mới hay người dùng mới.', lessonEn: 'This is an app screen transition, not a new attempt or a new user.' },
  dialog_opened: { vi: 'Đã mở cửa sổ', en: 'Dialog opened', lesson: 'Cửa sổ đã hiển thị. Mở cửa hàng không có nghĩa đã mua hàng; log không ghi nội dung tài khoản.', lessonEn: 'A dialog became visible. Opening the shop does not mean a purchase; account contents are not logged.' },
  attempt_selected: { vi: 'Đã chọn lượt chơi', en: 'Attempt selected', lesson: 'Bắt đầu một phạm vi chỉ số mới, nhưng giữ lịch sử toàn app. Bàn ranked vẫn phải được máy chủ tạo thành công.', lessonEn: 'Starts a fresh metric scope without erasing app history. A ranked board still needs a successful server start.' },
  level_started: { vi: 'Bắt đầu màn chơi', en: 'Level started', lesson: 'Đây là mốc bắt đầu một lượt chơi. Một lượt chơi không đồng nghĩa với một người dùng.', lessonEn: 'This begins one attempt. An attempt is not a unique player.' },
  move_resolved: { vi: 'Nước đi đã xử lý', en: 'Move resolved', lesson: 'delta là điểm của nước đi, bao gồm chuỗi xử lý liên tiếp. Một nước đi có thể tạo nhiều đợt ghép; không đếm mỗi đợt thành một lượt mới.', lessonEn: 'delta includes all resolution waves. One move can cause multiple waves; do not count each wave as a new move.' },
  move_rejected: { vi: 'Nước đi không hợp lệ', en: 'Move rejected', lesson: 'Không trừ lượt và không tăng điểm. Vẫn ghi nhận lần thử này để quan sát khó khăn khi thao tác, không gọi đây là lượt thất bại của cả màn.', lessonEn: 'No move is consumed and no score earned. Count the attempt to study interaction friction, not as a failed level.' },
  booster_used: { vi: 'Vật phẩm được chấp nhận', en: 'Booster accepted', lesson: 'Ghi nhận sau khi yêu cầu dùng vật phẩm thành công. Đây không phải sự kiện thanh toán hoặc doanh thu.', lessonEn: 'Recorded after the booster request succeeds. This is not a payment or revenue event.' },
  booster_failed: { vi: 'Chưa dùng được vật phẩm', en: 'Booster failed', lesson: 'Yêu cầu chưa thành công, nên không cộng vào số lần sử dụng thành công. Không đưa nội dung lỗi máy chủ hay thông tin tài khoản vào log.', lessonEn: 'The request failed; do not count a successful use. Server error details and account data stay out of this log.' },
  booster_resolved: { vi: 'Đã áp dụng vật phẩm', en: 'Booster applied', lesson: 'Điểm hoặc số lượt đã thay đổi trên bàn luyện tập. Điểm này không được đưa vào điểm trung bình mỗi nước đổi kẹo.', lessonEn: 'The practice board score or move budget changed. These points are excluded from average points per swap.' },
  board_shuffled: { vi: 'Bàn chơi được xáo lại', en: 'Board shuffled', lesson: 'Bàn không còn nước đi và được hệ thống xáo lại. Đây là thao tác hệ thống, không phải lần đổi kẹo của người chơi.', lessonEn: 'The system reshuffled a board without legal moves. This is not a player swap.' },
  level_completed: { vi: 'Kết thúc tại trình duyệt', en: 'Client outcome', lesson: 'Điểm kết thúc có thể có thưởng dư lượt hoặc điểm từ vật phẩm. Ranked vẫn cần máy chủ xác nhận. Một lượt chưa đủ để suy ra retention hay độ khó của cả game.', lessonEn: 'Final score may include bonuses or booster points. Ranked still needs server verification. One attempt cannot establish retention or overall difficulty.' },
  verification_started: { vi: 'Đang xác nhận kết quả', en: 'Verifying result', lesson: 'Máy chủ kiểm tra lại chuỗi nước đi. Trạng thái đang gửi không đồng nghĩa với đã lưu thành công.', lessonEn: 'The server replays moves. A pending submission is not a saved result.' },
  verification_completed: { vi: 'Máy chủ đã xác nhận', en: 'Server verified', lesson: 'score và won trong sự kiện này là kết quả máy chủ trả về, không phải điểm client tự khai báo.', lessonEn: 'score and won here come from the server, not the client claim.' },
  verification_failed: { vi: 'Chưa xác nhận được', en: 'Not verified', lesson: 'Không kết luận thắng hoặc đã lưu. Lỗi kết nối hay từ chối xác thực khác với thất bại do hết lượt.', lessonEn: 'Do not conclude a saved win. A network or verification failure is different from losing a level.' },
  start_failed: { vi: 'Chưa bắt đầu được', en: 'Start failed', lesson: 'Chưa có bàn ranked hợp lệ. Lỗi khởi tạo không được tính như một màn đã chơi.', lessonEn: 'No valid ranked board exists yet. A startup error is not a played level.' },
};
