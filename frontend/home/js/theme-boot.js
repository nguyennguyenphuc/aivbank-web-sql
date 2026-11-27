/* Chạy đồng bộ trong <head> (trước khi vẽ trang) để không nháy theme.
   Dùng chung cho trang chủ (index.html) và bảng điều khiển (app.html):
   cùng key localStorage "eda-theme", nên chọn sáng/tối ở trang nào cũng giữ ở trang kia.
   Tách ra file riêng vì CSP là script-src 'self' (không cho script inline). */
(function () {
  var t;
  try { t = localStorage.getItem("eda-theme"); } catch (e) { /* chế độ riêng tư */ }
  if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  document.documentElement.classList.add("js");
})();
