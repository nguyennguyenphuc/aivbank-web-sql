(function () {
  "use strict";
  var D = window.EDA_DATA || { modules: [], optional: [], domain: { columns: [], rows: [], legend: [] }, projects: [] };
  var C = window.EDA_CONTENT;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var areaBy = {}; C.areas.forEach(function (a) { areaBy[a.key] = a; });
  var dataBy = {}; D.modules.forEach(function (m) { dataBy[m.code] = m; });
  var KIND = { seminar: "Seminar lĩnh vực (tự chọn)", lesson: "Bài học", exercise: "Giải bài tập", softskill: "Kỹ năng", project: "Dự án", exam: "Thi", final: "Final Exam" };
  var KVAR = { seminar: "--k-seminar", lesson: "--k-lesson", exercise: "--k-exercise", softskill: "--k-softskill", project: "--k-project", exam: "--k-exam", final: "--k-exam" };
  var fmtDate = function (iso) { if (!iso) return "chờ cập nhật"; var p = iso.split("-"); return p[2] + "/" + p[1] + "/" + p[0]; };
  var ARROW = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6M5.5 2.5 8 5 5.5 7.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------- Stats ---------- */
  var nSessions = D.modules.reduce(function (s, m) { return s + m.sessions.length + m.finalExam.length; }, 0);
  if (nSessions) {
    $("#statSessions").textContent = nSessions;
    $("#statHours").textContent = (Math.floor(nSessions * 2.5 / 5) * 5) + "+";
  }

  /* ---------- Skill strip ---------- */
  var B = 'stroke="var(--brand)"', FB = 'fill="var(--brand)"';
  var MONO = 'font-family="IBM Plex Mono,monospace"';
  var ICONS = {
    // Pivot: vùng tô chạy dọc hàng và ngang cột
    pivot: '<rect x="24" y="22" width="112" height="76" rx="4"/><path d="M24 40h112M24 58h112M24 76h112M56 22v76M88 22v76M112 22v76"/>' +
      '<rect class="pv-row" x="24" y="40" width="112" height="18" fill="var(--brand)" fill-opacity=".2" stroke="none"/><rect class="pv-col" x="56" y="22" width="32" height="76" fill="var(--brand)" fill-opacity=".14" stroke="none"/>' +
      '<rect class="pv-cell" x="56" y="40" width="32" height="18" fill="var(--brand)" stroke="none"/>',
    // Power Query: dòng dữ liệu bẩn được lọc, đi sang bảng sạch
    query: '<path d="M18 30h44M18 46h44M18 62h44M18 78h44M18 94h44"/><path d="M98 38h44M98 54h44M98 70h44M98 86h44"/>' +
      '<path d="M68 62h22" ' + B + '/><path class="pq-arrow" d="m84 56 6 6-6 6" ' + B + '/>' +
      '<circle class="pq-dot" style="--d:0s" cx="26" cy="30" r="3.5" ' + FB + ' stroke="none"/><circle class="pq-dot pq-bad" style="--d:.9s" cx="26" cy="46" r="3.5" fill="#e11d48" stroke="none"/>' +
      '<circle class="pq-dot" style="--d:1.8s" cx="26" cy="62" r="3.5" ' + FB + ' stroke="none"/><circle class="pq-dot" style="--d:2.7s" cx="26" cy="78" r="3.5" ' + FB + ' stroke="none"/>',
    // DAX: công thức gõ dần, kết quả bật ra
    dax: '<text x="22" y="52" font-family="Instrument Serif,serif" font-style="italic" font-size="34" fill="currentColor" stroke="none">ƒx</text>' +
      '<path class="dx-l" style="--d:0s" pathLength="1" d="M66 36h70"/><path class="dx-l" style="--d:.7s" pathLength="1" d="M66 50h48"/><path class="dx-l" style="--d:1.4s" pathLength="1" d="M66 64h60"/>' +
      '<g class="dx-r"><rect x="22" y="80" width="114" height="24" rx="5" fill="var(--brand)" fill-opacity=".14" ' + B + '/><text x="32" y="96" ' + MONO + ' font-size="11" fill="var(--brand)" stroke="none">= 12,4 tỷ ↑ 8%</text></g>',
    // Star schema: bảng fact nhịp, đường nối chạy
    star: '<rect class="st-f" x="62" y="44" width="36" height="32" rx="4" ' + B + ' stroke-width="2"/><text x="69" y="64" ' + MONO + ' font-size="9" fill="var(--brand)" stroke="none">FACT</text>' +
      '<rect x="18" y="16" width="34" height="22" rx="3"/><rect x="108" y="16" width="34" height="22" rx="3"/><rect x="18" y="84" width="34" height="22" rx="3"/><rect x="108" y="84" width="34" height="22" rx="3"/>' +
      '<path class="st-l" d="M52 32 62 46M108 32 98 46M52 90l10-14M108 90 98 76" stroke-dasharray="3 3"/>',
    // SQL: từng dòng truy vấn hiện ra, con trỏ nhấp nháy
    sql: '<text x="22" y="36" ' + MONO + ' font-size="12" fill="var(--brand)" stroke="none">SELECT</text>' +
      '<path class="sq-l" style="--d:0s" pathLength="1" d="M76 32h56"/><path class="sq-l" style="--d:.6s" pathLength="1" d="M34 50h74"/><path class="sq-l" style="--d:1.2s" pathLength="1" d="M22 68h40"/><path class="sq-l" style="--d:1.6s" pathLength="1" d="M70 68h44"/><path class="sq-l" style="--d:2.2s" pathLength="1" d="M34 86h54"/>' +
      '<rect class="sq-cur" x="94" y="80" width="7" height="12" ' + FB + ' stroke="none"/>',
    // Window function: khung partition trượt xuống, mũi tên lũy kế
    window: '<path d="M30 24h100M30 38h100M30 52h100M30 66h100M30 80h100M30 94h100"/>' +
      '<rect class="wf-win" x="24" y="18" width="112" height="34" rx="5" ' + B + ' stroke-width="2" fill="var(--brand)" fill-opacity=".1"/>' +
      '<path class="wf-run" pathLength="1" d="M144 24V96" ' + B + ' stroke-width="2"/>',
    // Agentic AI: mắt chớp, câu trả lời gõ dần
    agent: '<rect x="22" y="40" width="48" height="40" rx="10"/><g class="ag-eye"><circle cx="38" cy="60" r="4" ' + FB + ' stroke="none"/><circle cx="54" cy="60" r="4" ' + FB + ' stroke="none"/></g><path d="M46 40V30"/><circle class="ag-ant" cx="46" cy="27" r="3" ' + FB + ' stroke="none"/>' +
      '<path d="M84 28h52a6 6 0 0 1 6 6v34a6 6 0 0 1-6 6h-34l-10 10V74h-8a6 6 0 0 1-6-6V34a6 6 0 0 1 6-6Z" ' + B + '/>' +
      '<path class="ag-l" style="--d:.3s" pathLength="1" d="M92 42h40"/><path class="ag-l" style="--d:1s" pathLength="1" d="M92 52h30"/><path class="ag-l" style="--d:1.7s" pathLength="1" d="M92 62h36"/><path d="M24 96h44"/>',
    // A/B testing: hai cột mọc lên, nhãn p-value bật ra
    ab: '<path d="M22 100h116"/><rect class="ab-bar" style="--d:0s" x="40" y="52" width="28" height="48" rx="3"/><rect class="ab-bar" style="--d:.3s" x="92" y="34" width="28" height="66" rx="3" ' + B + ' ' + FB + ' fill-opacity=".2"/>' +
      '<path class="ab-err" d="M54 42v20M48 42h12M48 62h12M106 24v20M100 24h12M100 44h12"/>' +
      '<text x="50" y="114" ' + MONO + ' font-size="10" fill="currentColor" stroke="none">A</text><text x="102" y="114" ' + MONO + ' font-size="10" fill="currentColor" stroke="none">B</text>' +
      '<g class="ab-p"><rect x="86" y="6" width="56" height="16" rx="8" fill="var(--brand)" stroke="none"/><text x="93" y="18" ' + MONO + ' font-size="9.5" fill="#fff" stroke="none">p&lt;0.05</text></g>',
    // Snowflake: bông tuyết xoay chậm
    flake: '<g class="sf-rot"><g transform="translate(80 60)"><path d="M0-42V42M-36-21 36 21M-36 21 36-21"/><path d="M-8-34 0-26 8-34M-8 34 0 26 8 34M-33-12-22-14-26-25M33 12 22 14 26 25M-33 12-22 14-26 25M33-12 22-14 26-25" ' + B + '/></g></g>',
    // DBT pipeline: gói dữ liệu chạy qua ba khối
    pipe: '<rect x="12" y="44" width="30" height="30" rx="5"/><rect class="pp-mid" x="65" y="44" width="30" height="30" rx="5" ' + B + '/><rect x="118" y="44" width="30" height="30" rx="5"/><path d="M42 59h23M95 59h23"/>' +
      '<text x="17" y="92" ' + MONO + ' font-size="9" fill="currentColor" stroke="none">RAW</text><text x="69" y="92" ' + MONO + ' font-size="9" fill="currentColor" stroke="none">DBT</text><text x="119" y="92" ' + MONO + ' font-size="9" fill="currentColor" stroke="none">GOLD</text>' +
      '<rect class="pp-pk" style="--d:0s" x="22" y="54" width="10" height="10" rx="2" ' + FB + ' stroke="none"/><rect class="pp-pk" style="--d:1.2s" x="22" y="54" width="10" height="10" rx="2" ' + FB + ' stroke="none"/><rect class="pp-pk" style="--d:2.4s" x="22" y="54" width="10" height="10" rx="2" ' + FB + ' stroke="none"/>',
    // K-Means: tâm cụm dịch dần về giữa cụm
    kmeans: '<g fill="currentColor" stroke="none"><circle cx="38" cy="40" r="3"/><circle cx="48" cy="32" r="3"/><circle cx="30" cy="30" r="3"/><circle cx="44" cy="48" r="3"/><circle cx="110" cy="34" r="3"/><circle cx="120" cy="44" r="3"/><circle cx="104" cy="46" r="3"/><circle cx="72" cy="86" r="3"/><circle cx="84" cy="94" r="3"/><circle cx="64" cy="96" r="3"/><circle cx="80" cy="80" r="3"/></g>' +
      '<g ' + B + ' stroke-width="2.4"><path class="km-c km-c0" d="M34 34l10 10M44 34 34 44"/><path class="km-c km-c1" d="M108 34l10 10M118 34l-10 10"/><path class="km-c km-c2" d="M68 84l10 10M78 84 68 94"/></g>' +
      '<g class="km-ring" stroke-dasharray="3 4"><circle cx="39" cy="39" r="18"/><circle cx="113" cy="39" r="16"/><circle cx="74" cy="89" r="17"/></g>',
    // Random forest: đường quyết định chạy từ gốc xuống lá
    tree: '<rect x="66" y="12" width="28" height="18" rx="4" ' + B + '/><rect x="30" y="50" width="28" height="18" rx="4"/><rect x="102" y="50" width="28" height="18" rx="4"/><rect x="14" y="90" width="24" height="16" rx="4"/><rect x="50" y="90" width="24" height="16" rx="4"/><rect class="tr-leaf" x="104" y="90" width="24" height="16" rx="4"/>' +
      '<path d="M80 30 44 50M80 30l36 20M44 68 26 90M44 68l18 22M116 68v22"/>' +
      '<path class="tr-path" pathLength="1" d="M80 30l36 20M116 68v22" ' + B + ' stroke-width="3"/>'
  };
  $("#skillTrack").innerHTML = C.skills.map(function (s, i) {
    return '<li class="card"><div class="card__head"><span>' + String(i + 1).padStart(2, "0") + '</span><span>EDA-' + s.m + '</span></div>' +
      '<svg viewBox="0 0 160 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[s.icon] + '</svg>' +
      '<h3 class="card__name">' + esc(s.name) + '</h3></li>';
  }).join("");

  /* ---------- Domain tiles ---------- */
  var TILES = [
    ["Bán hàng", "Sales, Retail (M1)", '<path class="tl-draw" pathLength="1" d="M10 80 40 60l20 10 30-30 30 14 30-24" stroke-width="2.5"/><path class="tl-arr" d="M138 30h12v12" stroke-width="2.5"/>'],
    ["Tài chính", "Finance, Banking (M3)", '<g stroke-width="2"><g class="tl-bob" style="--d:0s"><path d="M30 30v50"/><rect x="24" y="44" width="12" height="22" fill="currentColor" fill-opacity=".25"/></g><g class="tl-bob" style="--d:.5s"><path d="M60 40v40"/><rect x="54" y="50" width="12" height="18" fill="currentColor" fill-opacity=".25"/></g><g class="tl-bob" style="--d:1s"><path d="M90 22v54"/><rect x="84" y="30" width="12" height="30" fill="currentColor" fill-opacity=".25"/></g><g class="tl-bob" style="--d:1.5s"><path d="M120 34v36"/><rect x="114" y="44" width="12" height="16" fill="currentColor" fill-opacity=".25"/></g></g>'],
    ["Marketing", "Digital, Omnichannel (M4)", '<path d="M30 14h100l-30 32v28l-40 14V46Z" stroke-width="2"/><path d="M50 30h60" stroke-width="2"/><circle class="tl-drop" style="--d:0s;--dx:18px" cx="62" cy="20" r="3" fill="currentColor"/><circle class="tl-drop" style="--d:.7s" cx="80" cy="20" r="3" fill="currentColor"/><circle class="tl-drop" style="--d:1.4s;--dx:-18px" cx="98" cy="20" r="3" fill="currentColor"/>'],
    ["Game và sản phẩm số", "Product, Retention (M4)", '<rect x="40" y="26" width="80" height="48" rx="22" stroke-width="2"/><path d="M60 42v16M52 50h16" stroke-width="2"/><circle class="tl-blink" style="--d:0s" cx="96" cy="46" r="4" fill="currentColor"/><circle class="tl-blink" style="--d:.6s" cx="106" cy="56" r="4" fill="currentColor"/>'],
    ["Chuỗi cung ứng", "Supply Chain (M5)", '<g stroke-width="2"><path d="M8 74h144"/><path d="M8 80h144" stroke-dasharray="4 6" class="tl-belt"/></g><g class="tl-conv" style="--d:0s"><rect x="0" y="50" width="26" height="22" stroke-width="2"/><path d="M0 58h26" stroke-width="1.5"/></g><g class="tl-conv" style="--d:-2s"><rect x="0" y="50" width="26" height="22" stroke-width="2"/><path d="M0 58h26" stroke-width="1.5"/></g><g class="tl-conv" style="--d:-4s"><rect x="0" y="50" width="26" height="22" stroke-width="2"/><path d="M0 58h26" stroke-width="1.5"/></g>'],
    ["Vận hành và Nhân sự", "Operations, HR (M2, M6)", '<g class="tl-spin"><circle cx="80" cy="50" r="22" stroke-width="2"/><path d="M80 18v10M80 72v10M48 50h10M102 50h10M57 27l7 7M96 66l7 7M57 73l7-7M96 34l7-7" stroke-width="2"/></g><circle cx="80" cy="50" r="7" fill="currentColor"/>']
  ];
  $("#domainTiles").innerHTML = TILES.map(function (t) {
    return '<li><div class="tile"><svg viewBox="0 0 160 100" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + t[2] + '</svg></div><span>' + t[0] + '<small>' + t[1] + '</small></span></li>';
  }).join("");

  /* ---------- Stages + road list ---------- */
  $("#stages").innerHTML = C.stages.map(function (s) { return '<li><span>' + s.n + '</span>' + esc(s.name) + ' <em>' + s.mods + '</em></li>'; }).join("");
  var roadItems = C.modules.map(function (m, i) {
    return '<details class="mod"' + (i === 0 ? " open" : "") + '><summary><span class="mod__n">' + m.n + '</span><span class="badge">' + m.code + '</span>' +
      '<span class="mod__t">' + esc(m.title) + '<small>' + esc(m.tool) + (m.dprojects ? '. Dự án: ' + esc(m.dprojects) : '. Lĩnh vực: ' + esc(m.domain)) + '</small></span><span class="mod__x" aria-hidden="true"></span></summary>' +
      '<div class="mod__b"><p><span>Nội dung chính</span>' + esc(m.main) + '</p><p><span>Nội dung bổ trợ</span>' + esc(m.extra) + '</p></div></details>';
  });
  var o = C.optional;
  roadItems.push('<details class="mod"><summary><span class="mod__n">' + o.n + '</span><span class="badge badge--opt">' + o.code + '</span><span class="mod__t">' + esc(o.title) + '<small>PL-300 và AWS Cloud Practitioner</small></span><span class="mod__x" aria-hidden="true"></span></summary>' +
    '<div class="mod__b"><p><span>Nội dung chính</span>' + esc(o.main) + '</p><p><span>Nội dung bổ trợ</span>' + esc(o.extra) + '</p></div></details>');
  $("#roadList").innerHTML = roadItems.join("") +
    '<p class="road__after"><span>Sau khoá học</span>Người học hoàn thành bài thi cuối khoá gồm hai phần (SQL và Power BI, phân tích nâng cao) và có 9 dự án thực hành, cùng dự án mentorship nếu tham gia. Người học có thể học tiếp module luyện thi chứng chỉ Microsoft PL-300 và AWS Cloud Practitioner.</p>';

  /* ---------- Module detail ---------- */
  var chip = function (c) { var a = areaBy[c[0]]; return '<li class="rchip" data-a="' + c[0] + '"><abbr title="' + esc(a.name) + '">' + a.code + '</abbr>' + esc(c[1]) + '</li>'; };
  var schedRow = function (s, cls) {
    return '<tr' + (cls ? ' class="' + cls + '"' : "") + '><td>' + String(s.no).padStart(2, "0") + '</td><td>' + esc(s.day || "") + '</td><td>' + fmtDate(s.date) + '</td><td><span class="kd kd--' + s.kind + '" title="' + KIND[s.kind] + '"></span>' + esc(s.kind === "exercise" ? "Giải bài tập" : s.task) + (s.kind === "seminar" ? '<em class="opt-tag">tự chọn</em>' : "") + '</td></tr>';
  };
  var rm = C.modules.map(function (m) {
    var d = dataBy[m.code] || { sessions: [], finalExam: [] };
    var areas = {}; m.theory.concat(m.practice).forEach(function (c) { areas[c[0]] = 1; });
    var first = d.sessions[0], last = d.finalExam.length ? d.finalExam[d.finalExam.length - 1] : d.sessions.filter(function (s) { return s.date; }).slice(-1)[0];
    var range = first && last ? fmtDate(first.date).slice(0, 5) + " đến " + fmtDate(last.date) : "";
    var rows = d.sessions.map(function (s) { return schedRow(s); }).join("") + d.finalExam.map(function (s) { return schedRow(s, "is-final"); }).join("");
    var projs = m.projects.map(function (k) { var p = C.projects[k]; return '<a href="#p-' + k + '">' + esc(p.title) + '</a>'; }).join("");
    return '<li class="rmod" id="' + m.code.toLowerCase() + '" data-as="' + Object.keys(areas).join(" ") + '">' +
      '<div class="rmod__n"><span class="badge">' + m.code + '</span><b>' + m.n + '</b><small>' + (d.sessions.length + d.finalExam.length) + ' buổi</small></div>' +
      '<div class="rmod__b"><h3>' + esc(m.title) + '</h3><p class="rmod__en">' + esc(m.en) + '</p>' +
      '<div class="rmod__tags"><span class="tag">' + (m.dprojects ? (m.dprojects.split(", ").length + ' dự án: ' + esc(m.dprojects)) : 'Lĩnh vực: ' + esc(m.domain)) + '</span><span class="tag tag--tool">' + esc(m.tool) + '</span></div>' +
      '<p class="rmod__main"><span>Nội dung chính</span>' + esc(m.main) + '</p><p class="rmod__extra"><span>Nội dung bổ trợ</span>' + esc(m.extra) + '</p></div>' +
      '<div class="rmod__c"><p class="rmod__h"><span class="up">Lý thuyết</span></p><ul class="rchips">' + m.theory.map(chip).join("") + '</ul>' +
      '<p class="rmod__h"><span class="dn">Thực hành và lĩnh vực</span></p><ul class="rchips rchips--b">' + m.practice.map(chip).join("") + '</ul>' +
      (projs ? '<div class="rmod__proj"><p class="rmod__h">Dự án mentorship cùng lĩnh vực</p>' + projs + '</div>' : "") + '</div>' +
      '<details class="sched"><summary>Lịch học chi tiết <em>' + range + '</em></summary><div class="sched__wrap"><table><thead><tr><th>Buổi</th><th>Thứ</th><th>Ngày</th><th>Nội dung</th></tr></thead><tbody>' + rows + '</tbody></table></div></details></li>';
  });
  var optTracks = (D.optional || []).map(function (t) {
    var title = t.title.replace(/\s*-\s*Sẽ xếp lịch cụ thể sau\s*$/i, "");
    return '<div class="opt__c"><h4>' + esc(title) + '</h4><ol>' + t.sessions.map(function (s) { return '<li>' + esc(s.task.replace(/^Buổi \d+:\s*/, "")) + '</li>'; }).join("") + '</ol></div>';
  }).join("");
  rm.push('<li class="rmod" id="m8" data-as="bi"><div class="rmod__n"><span class="badge badge--opt">M8</span><b>08</b><small>Tự chọn</small></div>' +
    '<div class="rmod__b"><h3>' + esc(o.title) + '</h3><p class="rmod__en">' + esc(o.en) + '</p><p class="rmod__main"><span>Nội dung chính</span>' + esc(o.main) + '</p><p class="rmod__extra"><span>Nội dung bổ trợ</span>' + esc(o.extra) + '</p></div>' +
    '<div class="rmod__c"><p class="rmod__h"><span class="up">Chứng chỉ</span></p><ul class="rchips"><li class="rchip" data-a="bi"><abbr title="Power BI và công cụ BI">BI</abbr>Microsoft PL-300</li><li class="rchip" data-a="cloud"><abbr title="Điện toán đám mây">CLOUD</abbr>AWS Cloud Practitioner</li></ul></div>' +
    '<div class="opt">' + optTracks + '</div></li>');
  $("#rmods").innerHTML = rm.join("");

  // area filter
  var counts = {}; C.modules.forEach(function (m) { m.theory.concat(m.practice).forEach(function (c) { counts[c[0]] = (counts[c[0]] || 0) + 1; }); });
  var total = Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0);
  $("#areaFilter").innerHTML = '<button type="button" data-af="all" aria-pressed="true"><span class="rf__n">' + total + '</span>Tất cả học phần</button>' +
    C.areas.map(function (a) { return '<button type="button" data-af="' + a.key + '" aria-pressed="false"><span class="rf__n">' + String(counts[a.key] || 0).padStart(2, "0") + '</span>' + esc(a.name) + '</button>'; }).join("");
  var applyArea = function (key) {
    $$("[data-af]").forEach(function (b) { if (b.closest("#areaFilter")) b.setAttribute("aria-pressed", String(b.dataset.af === key)); });
    var mods = [];
    $$(".rmod").forEach(function (li) {
      var on = key === "all" || (" " + li.dataset.as + " ").indexOf(" " + key + " ") > -1;
      li.classList.toggle("off", !on);
      if (on && key !== "all") mods.push(li.id.toUpperCase());
      $$(".rchip", li).forEach(function (c) { c.classList.toggle("hit", key !== "all" && c.dataset.a === key); c.classList.toggle("off", key !== "all" && c.dataset.a !== key); });
    });
    var note = $("#areaNote");
    if (key === "all") note.innerHTML = "";
    else note.innerHTML = "<b>" + esc(areaBy[key].code) + ": " + mods.join(", ") + "</b>" + esc(areaBy[key].note);
  };
  $$("[data-af]").forEach(function (b) { b.addEventListener("click", function () { applyArea(b.dataset.af); }); });

  /* ---------- Drawing helpers ---------- */
  var T = function (x, y, s, o) {
    o = o || {};
    return '<text x="' + x + '" y="' + y + '"' + (o.anchor ? ' text-anchor="' + o.anchor + '"' : "") + ' font-family="' + (o.mono ? "IBM Plex Mono,monospace" : "Plus Jakarta Sans,sans-serif") + '" font-size="' + (o.size || 12) + '"' +
      (o.weight ? ' font-weight="' + o.weight + '"' : "") + ' fill="' + (o.fill || "currentColor") + '"' + (o.ls ? ' letter-spacing="' + o.ls + '"' : "") + '>' + esc(s) + '</text>';
  };

  var wrap = function (s, max) {
    var out = [], cur = "";
    s.split(" ").forEach(function (w) { if (cur && (cur + " " + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; });
    if (cur) out.push(cur);
    return out;
  };

  /* ---------- EDA-ENG-001: one module cycle ---------- */
  (function () {
    var m = dataBy.M1; if (!m) return;
    var lanes = [["seminar", "Seminar"], ["lesson", "Học"], ["exercise", "Bài tập"], ["softskill", "Kỹ năng"], ["project", "Dự án"], ["exam", "Thi"]];
    var L = 120, W = 1200, top = 46, lh = 44, n = m.sessions.length, cw = (W - L - 10) / n;
    var s = '<svg viewBox="0 0 ' + W + ' ' + (top + lanes.length * lh + 34) + '" fill="none" role="img" aria-label="Sơ đồ chu kỳ 13 buổi của một module">';
    lanes.forEach(function (ln, i) {
      var y = top + i * lh;
      s += '<path d="M0 ' + y + 'H' + W + '" stroke="currentColor" stroke-opacity=".25"/>';
      s += T(0, y + 27, ln[1].toUpperCase(), { size: 11.5, weight: 600, ls: ".04em", fill: "var(--ink-2)" });
    });
    s += '<path d="M0 ' + (top + lanes.length * lh) + 'H' + W + '" stroke="currentColor" stroke-opacity=".25"/>';
    var pts = [];
    m.sessions.forEach(function (x, i) {
      var cx = L + i * cw + cw / 2, li = Math.max(0, lanes.findIndex(function (l) { return l[0] === x.kind; })), cy = top + li * lh + lh / 2;
      pts.push([cx, cy]);
      s += '<path d="M' + cx + ' ' + top + 'V' + (top + lanes.length * lh) + '" stroke="currentColor" stroke-opacity=".08" stroke-dasharray="2 4"/>';
      s += T(cx, top - 24, x.day, { anchor: "middle", mono: 1, size: 11, fill: "var(--muted)" });
      s += T(cx, top - 10, x.date ? x.date.slice(8) + "/" + x.date.slice(5, 7) : "", { anchor: "middle", mono: 1, size: 10, fill: "var(--faint)" });
    });
    var route = "M" + pts.map(function (p) { return p[0] + " " + p[1]; }).join(" L");
    s += '<path class="draw-line" pathLength="1" d="' + route + '" stroke="var(--ink-2)" stroke-width="1.4"/>';
    m.sessions.forEach(function (x, i) {
      var p = pts[i];
      s += '<g class="cy-cell" style="--d:' + (0.25 + i * 0.16).toFixed(2) + 's"><title>' + esc("Buổi " + x.no + ": " + x.task) + '</title><rect x="' + (p[0] - cw / 2 + 5) + '" y="' + (p[1] - 13) + '" width="' + (cw - 10) + '" height="26" rx="6" fill="var(' + KVAR[x.kind] + ')"/>' +
        T(p[0], p[1] + 4.5, String(x.no).padStart(2, "0"), { anchor: "middle", mono: 1, size: 11, fill: x.kind === "exam" ? "var(--bg)" : "#fff" }) + '</g>';
    });
    var wk = [[0, 1, "Mở đầu"], [1, 4, "Tuần 1"], [4, 7, "Tuần 2"], [7, 10, "Tuần 3"], [10, 13, "Tuần 4, kết thúc"]];
    var yb = top + lanes.length * lh + 22;
    wk.forEach(function (w) {
      var x1 = L + w[0] * cw + 6, x2 = L + w[1] * cw - 6;
      s += '<path d="M' + x1 + ' ' + (yb - 8) + 'V' + (yb - 4) + 'H' + x2 + 'V' + (yb - 8) + '" stroke="currentColor" stroke-opacity=".5"/>' + T((x1 + x2) / 2, yb + 10, w[2].toUpperCase(), { anchor: "middle", size: 11, weight: 600, ls: ".04em", fill: "var(--muted)" });
    });
    s += '<g class="run"><circle r="9" fill="var(--brand)" fill-opacity=".22"/><circle r="4.5" fill="var(--ink)"/><animateMotion dur="9s" repeatCount="indefinite" calcMode="linear" path="' + route + '"/></g>';
    $("#cycleDraw").innerHTML = s + "</svg>";
  })();

  /* ---------- EDA-ENG-002: sơ đồ tiến trình đào tạo (degree map) ---------- */
  (function () {
    var W = 1200, L = 110, R = 20, H = 270;
    var t0 = Date.parse("2026-09-01"), t1 = Date.parse("2027-07-12");
    var X = function (iso) { return L + (Date.parse(iso) - t0) / (t1 - t0) * (W - L - R); };
    var LANES = [["Excel và BI", "var(--ln0)"], ["SQL và dữ liệu", "var(--ln1)"], ["AI và học máy", "var(--ln2)"]];
    // Các module học nối tiếp nhau trên một hàng; màu ô theo nhóm kiến thức
    var yMain = 110, laneY = [yMain, yMain, yMain], bh = 60, yOpt = 206;
    var span = {};
    C.modules.forEach(function (m) {
      var d = dataBy[m.code]; if (!d) return;
      var ds = d.sessions.map(function (x) { return x.date; }).filter(Boolean);
      span[m.code] = { a: ds[0], b: ds[ds.length - 1], fe: d.finalExam.map(function (x) { return x.date; }) };
    });
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" fill="none" role="img" aria-label="Sơ đồ tiến trình đào tạo: 7 module học nối tiếp nhau theo thời gian">';
    s += '<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--ink-2)"/></marker></defs>';
    // trục tháng
    var months = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07"];
    months.forEach(function (mo, i) {
      var x = X(mo + "-01"), lab = "T" + (+mo.slice(5)) + (i === 0 || mo.slice(5) === "01" ? "/" + mo.slice(0, 4) : "");
      s += '<path d="M' + x + ' 46V' + (H - 20) + '" stroke="currentColor" stroke-opacity=".12"/>';
      s += T(x + 6, 36, lab, { size: 11.5, weight: 600, fill: "var(--muted)" });
    });
    // hàng bắt buộc và hàng tự chọn
    s += '<rect x="0" y="' + (yMain - 44) + '" width="' + W + '" height="88" fill="currentColor" fill-opacity=".035"/>';
    s += T(8, yMain + 4, "Bắt buộc", { size: 12.5, weight: 600, fill: "var(--ink-2)" });
    s += T(8, yOpt + 4, "Tự chọn", { size: 12.5, weight: 600, fill: "var(--ink-2)" });
    // mũi tên học trước
    var box = {};
    C.modules.forEach(function (m) { var sp = span[m.code]; if (!sp) return; box[m.code] = { x1: X(sp.a), x2: X(sp.b) + 6, y: yMain, lane: 0 }; });
    C.modules.forEach(function (m) {
      (m.pre || []).forEach(function (p) {
        var a = box[p], b = box[m.code]; if (!a || !b) return;
        var d, between = C.modules.some(function (o) { var c = box[o.code]; return c && o.code !== p && o.code !== m.code && c.lane === a.lane && c.x1 > a.x2 && c.x2 < b.x1; });
        if (a.lane === b.lane && between) {
          var yt = a.y - bh / 2, mx = (a.x1 + a.x2) / 2, nx = (b.x1 + b.x2) / 2;
          d = "M" + mx + " " + yt + "C" + mx + " " + (yt - 34) + " " + nx + " " + (yt - 34) + " " + nx + " " + (yt - 2);
        } else if (a.lane === b.lane) {
          d = "M" + a.x2 + " " + a.y + "H" + (b.x1 - 2);
        } else {
          var cx = (a.x2 + b.x1) / 2;
          d = "M" + a.x2 + " " + a.y + "C" + (cx + 10) + " " + a.y + " " + (cx - 10) + " " + b.y + " " + (b.x1 - 2) + " " + b.y;
        }
        s += '<path class="flow" d="' + d + '" stroke="var(--ink-2)" stroke-width="1.4" stroke-dasharray="4 4" marker-end="url(#arw)"/>';
      });
    });
    // ô module
    C.modules.forEach(function (m, i) {
      var b = box[m.code]; if (!b) return;
      var w = b.x2 - b.x1, lines = m.short.split("|");
      s += '<g class="dm-box" style="--d:' + (i * 0.12).toFixed(2) + 's"><title>' + esc(m.code + ": " + m.title + ", " + fmtDate(span[m.code].a) + " đến " + fmtDate(span[m.code].b)) + '</title>' +
        '<rect x="' + b.x1 + '" y="' + (b.y - bh / 2) + '" width="' + w + '" height="' + bh + '" rx="8" fill="' + LANES[m.lane][1] + '"/>' +
        T(b.x1 + 9, b.y - 9, m.code, { mono: 1, size: 11.5, fill: "#fff" }) +
        lines.slice(0, 2).map(function (ln, k) { return T(b.x1 + 9, b.y + 7 + k * 14, ln, { size: 11.5, weight: 600, fill: "#fff" }); }).join("") + '</g>';
    });
    // thi cuối khoá
    var fe = span.M7 ? span.M7.fe : [];
    fe.forEach(function (d) {
      var x = X(d), y = laneY[2];
      s += '<path d="M' + x + ' ' + (y - 11) + 'L' + (x + 11) + ' ' + y + 'L' + x + ' ' + (y + 11) + 'L' + (x - 11) + ' ' + y + 'Z" fill="var(--ink)"/>';
    });
    if (fe.length) s += T(X(fe[fe.length - 1]) + 16, laneY[2] + 4, "Thi cuối khoá", { size: 12, weight: 600, fill: "var(--ink)" });
    // tự chọn: mentorship và luyện thi chứng chỉ
    if (span.M1 && fe.length) {
      var mx1 = X(span.M1.b) + 10, mx2 = X(fe[0]) - 14;
      s += '<rect x="' + mx1 + '" y="' + (yOpt - 17) + '" width="' + (mx2 - mx1) + '" height="34" rx="17" fill="var(--brand-tint)" stroke="var(--brand)" stroke-width="1.4" stroke-dasharray="6 5"/>' +
        T(mx1 + 16, yOpt + 4.5, "Dự án mentorship tự chọn, tối Thứ 2, theo kế hoạch từng dự án", { size: 12, weight: 600, fill: "var(--brand-deep)" });
      var cx1 = X(fe[fe.length - 1]) + 14, cx2 = W - R;
      s += '<rect x="' + cx1 + '" y="' + (yOpt - 17) + '" width="' + (cx2 - cx1) + '" height="34" rx="8" fill="none" stroke="var(--ink-2)" stroke-width="1.4" stroke-dasharray="6 5"/>' +
        T(cx1 + 10, yOpt + 4.5, "M8 Luyện thi chứng chỉ", { size: 11.5, weight: 600, fill: "var(--ink-2)" });
    }
    // hôm nay
    var now = Date.now();
    if (now > t0 && now < t1) {
      var tx = L + (now - t0) / (t1 - t0) * (W - L - R);
      s += '<path d="M' + tx + ' 50V' + (H - 24) + '" stroke="var(--k-project)" stroke-width="1.5" stroke-dasharray="3 4"/>' + T(tx, H - 8, "Hôm nay", { anchor: "middle", size: 11.5, weight: 600, fill: "var(--k-project)" });
    }
    $("#mapDraw").innerHTML = s + "</svg>";
  })();

  /* ---------- Ma trận module và chuẩn đầu ra ---------- */
  (function () {
    var P = C.plos, LV = { I: "Giới thiệu", R: "Củng cố", M: "Thành thạo", A: "Đánh giá tổng kết" };
    var head = '<tr><th scope="col" class="cm__corner">Module</th>' + P.map(function (p) {
      return '<th scope="col"><abbr title="' + esc(p.text) + '">' + p.code + '</abbr><span>' + esc(p.short) + '</span></th>';
    }).join("") + '</tr>';
    var body = C.cmap.map(function (r) {
      return '<tr' + (r.opt ? ' class="cm__opt"' : "") + '><th scope="row"><b>' + esc(r.row) + '</b>' + esc(r.label) + '</th>' + r.v.map(function (v, i) {
        var codes = v ? v.split(" ") : [];
        return '<td' + (codes.length ? ' title="' + esc(r.label + ", " + P[i].code + ": " + codes.map(function (c) { return LV[c]; }).join(", ")) + '"' : "") + '>' +
          codes.map(function (c) { return '<span class="lv lv--' + c + '">' + c + '</span>'; }).join("") + '</td>';
      }).join("") + '</tr>';
    }).join("");
    $("#cmap").innerHTML = '<table><caption>Ma trận module và chuẩn đầu ra</caption><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
    $("#ploList").innerHTML = P.map(function (p) { return '<li><b>' + p.code + '</b>' + esc(p.text) + '</li>'; }).join("");
  })();

  /* ---------- Projects ---------- */
  $("#domainProjects").innerHTML = (D.projects || []).map(function (p) { return '<li><b>' + esc(p.module) + '</b>' + esc(p.name) + '</li>'; }).join("");
  var groupName = {}; C.mentorGroups.forEach(function (g) { groupName[g.key] = g.name; });
  var pkeys = Object.keys(C.projects).sort(function (a, b) {
    var ga = C.mentorGroups.findIndex(function (g) { return g.key === C.projects[a].g; }), gb = C.mentorGroups.findIndex(function (g) { return g.key === C.projects[b].g; });
    return ga - gb || C.projects[a].from.localeCompare(C.projects[b].from);
  });
  $("#projGrid").innerHTML = pkeys.map(function (k) {
    var p = C.projects[k];
    return '<article class="pc" id="p-' + k + '" data-g="' + p.g + '"><div class="pc__head"><b>' + esc(groupName[p.g]) + '</b><span>' + esc(p.domain) + '</span></div><h3>' + esc(p.title) + '</h3><p>' + esc(p.desc) + '</p>' +
      '<p class="pc__from">Học trước: ' + p.from + '</p><ul>' + p.tools.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join("") + '</ul></article>';
  }).join("");
  var counts2 = {}; pkeys.forEach(function (k) { counts2[C.projects[k].g] = (counts2[C.projects[k].g] || 0) + 1; });
  $("#projFilter").innerHTML = '<button type="button" data-pg="all" aria-pressed="true">Tất cả <span>' + pkeys.length + '</span></button>' +
    C.mentorGroups.filter(function (g) { return counts2[g.key]; }).map(function (g) { return '<button type="button" data-pg="' + g.key + '" aria-pressed="false">' + esc(g.name) + ' <span>' + counts2[g.key] + '</span></button>'; }).join("");
  $$("#projFilter button").forEach(function (b) {
    b.addEventListener("click", function () {
      var c = b.dataset.pg;
      $$("#projFilter button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      $$(".pc").forEach(function (pc) { pc.hidden = !(c === "all" || pc.dataset.g === c); });
    });
  });
  $$('.rmod__proj a').forEach(function (a) {
    a.addEventListener("click", function () { $$("#projFilter button")[0].click(); });
  });

  /* ---------- Team ---------- */
  $("#teamTrack").innerHTML = C.team.map(function (t) {
    return '<li class="tm"><span class="tm__ph"><picture><source type="image/webp" srcset="home/img/team/' + t.slug + '-320.webp"><img src="home/img/team/' + t.slug + '-320.jpg" alt="' + esc(t.name) + '" width="240" height="300" loading="lazy" decoding="async"></picture></span><b>' + esc(t.name) + '</b><small>' + esc(t.deg) + '</small></li>';
  }).join("");
  var tv = $("#teamView");
  $$(".team__nav button").forEach(function (b) { b.addEventListener("click", function () { tv.scrollBy({ left: Number(b.dataset.dir) * tv.clientWidth * 0.8, behavior: "smooth" }); }); });
  var deco = ""; for (var i = 0; i < 14; i++) { var hh = 60 + ((i * 53) % 240); deco += '<rect x="' + (12 + i * 27) + '" y="' + (380 - hh) + '" width="16" height="' + hh + '" rx="3"/>'; }
  $("#decoBars").innerHTML = deco + '<path d="M10 300 C100 260 160 200 230 150 S340 60 390 30" stroke-width="2"/>';

  /* ---------- Strip progress bar ---------- */
  var sv = $("#stripView"), sb = $("#stripBar");
  var upd = function () { var max = sv.scrollWidth - sv.clientWidth; var w = Math.max(.15, sv.clientWidth / sv.scrollWidth); sb.style.width = (w * 100) + "%"; sb.style.left = (max > 0 ? sv.scrollLeft / max * (1 - w) * 100 : 0) + "%"; };
  sv.addEventListener("scroll", upd, { passive: true }); window.addEventListener("resize", upd); upd();

  /* ---------- Theme ---------- */
  var root = document.documentElement;
  var isDark = function () { var t = root.getAttribute("data-theme"); return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches; };
  $("#themeBtn").addEventListener("click", function () {
    var next = isDark() ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("eda-theme", next); } catch (e) { /* bỏ qua */ }
  });

  /* ---------- Menu ---------- */
  var menu = $("#menu"), burger = $("#burger");
  var setMenu = function (open) { menu.hidden = !open; burger.setAttribute("aria-expanded", String(open)); document.body.style.overflow = open ? "hidden" : ""; };
  burger.addEventListener("click", function () { setMenu(true); });
  $("#menuClose").addEventListener("click", function () { setMenu(false); });
  menu.addEventListener("click", function (e) { if (e.target === menu || e.target.closest("a")) setMenu(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !menu.hidden) setMenu(false); });

  /* ---------- Nav hide on scroll ---------- */
  var nav = $("#nav"), lastY = window.scrollY;
  window.addEventListener("scroll", function () { var y = window.scrollY; nav.classList.toggle("is-away", y > lastY && y > 400); lastY = y; }, { passive: true });

  /* ---------- Motion ---------- */
  // Giống learning: hình minh hoạ vẫn chạy khi máy bật giảm chuyển động; người xem tạm dừng bằng nút ở hero.
  var reduce = false;
  var hasIO = "IntersectionObserver" in window;
  var setSvgPlay = function (scope, on) {
    $$("svg", scope).forEach(function (svg) {
      if (!svg.pauseAnimations) return;
      if (on && !reduce) svg.unpauseAnimations(); else svg.pauseAnimations();
    });
  };

  // Tiêu đề trồi từng từ (giống learning): bọc mỗi từ trong span.w
  var splitWords = function (el) {
    var i = 0, walk = function (node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3) {
          var parts = n.textContent.split(/( +)/), frag = document.createDocumentFragment();
          parts.forEach(function (part) {
            if (!part) return;
            if (/^ +$/.test(part)) { frag.appendChild(document.createTextNode(" ")); return; }
            var sp = document.createElement("span"); sp.className = "w"; sp.style.setProperty("--i", i++); sp.textContent = part; frag.appendChild(sp);
          });
          node.replaceChild(frag, n);
        } else if (n.nodeType === 1 && n.tagName !== "IMG" && !n.classList.contains("logo-chip")) walk(n);
      });
    };
    walk(el); el.classList.add("words");
  };
  $$(".hero h1, .h2, .sys__head h2").forEach(splitWords);

  // Số đếm lên
  var countUp = function (el) {
    if (el.getAttribute("data-done")) return;
    var raw = el.dataset.to || el.textContent, m = String(raw).match(/^(\D*)([\d.,]+)(.*)$/);
    if (!m) return;
    var to = parseFloat(m[2].replace(",", ".")), dec = el.dataset.dec ? +el.dataset.dec : (m[2].indexOf(".") > -1 ? 1 : 0);
    var pre = el.dataset.to ? "" : m[1], suf = el.dataset.suf !== undefined ? el.dataset.suf : m[3];
    el.setAttribute("data-done", "1");
    if (reduce) { el.textContent = pre + to.toFixed(dec).replace(".", ",") + suf; return; }
    var t0 = null, dur = 1400;
    var step = function (ts) {
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur), v = to * (1 - Math.pow(1 - k, 3));
      el.textContent = pre + v.toFixed(dec).replace(".", ",") + suf;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // Hero: các cảnh chuyển chậm, có nút chọn cảnh và tạm dừng
  (function () {
    var hero = $(".hero"), scenes = $$(".scene", hero), dots = $("#heroDots"), cap = $("#heroCap"), pauseBtn = $("#heroPause");
    if (!scenes.length) return;
    var cur = 0, timer = null, paused = reduce, visible = true;
    dots.innerHTML = scenes.map(function (sc, i) { return '<button type="button" aria-label="Cảnh ' + (i + 1) + ': ' + esc(sc.dataset.name) + '"' + (i === 0 ? ' aria-current="true"' : "") + '><i></i></button>'; }).join("");
    var restartCounts = function (sc) { $$("[data-to]", sc).forEach(function (t) { t.removeAttribute("data-done"); t.textContent = "0"; countUp(t); }); };
    var schedule = function () {
      clearTimeout(timer);
      dots.style.setProperty("--hold", (scenes[cur].dataset.hold || 10000) + "ms");
      dots.classList.remove("run"); void dots.offsetWidth;
      if (paused || !visible) return;
      dots.classList.add("run");
      timer = setTimeout(function () { show(cur + 1); }, +scenes[cur].dataset.hold || 10000);
    };
    var show = function (i) {
      scenes[cur].classList.remove("is-on");
      cur = (i + scenes.length) % scenes.length;
      var sc = scenes[cur];
      void sc.offsetWidth;
      sc.classList.add("is-on");
      $$("button", dots).forEach(function (b, k) { if (k === cur) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); });
      cap.textContent = "Cảnh " + (cur + 1) + "/" + scenes.length + ": " + sc.dataset.name;
      var svg = $("svg", sc); if (svg && svg.setCurrentTime) svg.setCurrentTime(0);
      restartCounts(sc);
      schedule();
    };
    var setPaused = function (p) {
      paused = p;
      hero.classList.toggle("is-paused", p);
      pauseBtn.setAttribute("aria-pressed", String(p));
      pauseBtn.setAttribute("aria-label", p ? "Chạy tiếp hoạt cảnh" : "Tạm dừng hoạt cảnh");
      setSvgPlay(hero, !p && visible);
      schedule();
    };
    $$("button", dots).forEach(function (b, i) { b.addEventListener("click", function () { show(i); }); });
    pauseBtn.addEventListener("click", function () { setPaused(!paused); });
    if (hasIO) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; setSvgPlay(hero, visible && !paused); schedule(); }).observe(hero);
    document.addEventListener("visibilitychange", function () { visible = !document.hidden; schedule(); });
    setPaused(paused);
    restartCounts(scenes[0]);
  })();

  // Hình nét chỉ chạy khi đang trên màn hình (class .an)
  var anim = $$(".card, .tile, .sys__panel, .rwk");
  if (hasIO) {
    var ioA = new IntersectionObserver(function (es) {
      es.forEach(function (e) { e.target.classList.toggle("an", e.isIntersecting); setSvgPlay(e.target, e.isIntersecting); });
    }, { rootMargin: "60px" });
    anim.forEach(function (el) { setSvgPlay(el, false); ioA.observe(el); });
  } else anim.forEach(function (el) { el.classList.add("an"); });

  // Kéo chuột để cuộn ngang dải thẻ và đội ngũ
  [sv, tv].forEach(function (view) {
    var down = false, x0 = 0, s0 = 0, moved = false;
    view.addEventListener("pointerdown", function (e) { if (e.pointerType !== "mouse") return; down = true; moved = false; x0 = e.clientX; s0 = view.scrollLeft; view.classList.add("is-drag"); });
    window.addEventListener("pointermove", function (e) { if (!down) return; var dx = e.clientX - x0; if (Math.abs(dx) > 4) moved = true; view.scrollLeft = s0 - dx; });
    window.addEventListener("pointerup", function () { if (!down) return; down = false; view.classList.remove("is-drag"); });
    view.addEventListener("click", function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);
    view.addEventListener("dragstart", function (e) { e.preventDefault(); });
  });

  /* ---------- Reveal ---------- */
  var rv = $$(".rv, .sys__panel, .h2, .road__stats, .pgrid, .pillars__grid, .rmods");
  var onIn = function (el) {
    el.classList.add("in");
    $$(".road__stats dt", el).forEach(countUp);
  };
  if (hasIO) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { onIn(e.target); io.unobserve(e.target); } }); }, { rootMargin: "0px 0px -8% 0px" });
    rv.forEach(function (el) { io.observe(el); });
  } else rv.forEach(onIn);
  $$(".hero__stats dt").forEach(function (dt) { setTimeout(function () { countUp(dt); }, 500); });
})();
