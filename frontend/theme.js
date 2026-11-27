/* Nút đổi sáng/tối trên thanh trên cùng của bảng điều khiển.
 *
 * Cùng một công tắc với trang chủ (home/js/site.js): thuộc tính data-theme trên
 * <html> và key localStorage "eda-theme". Khi người dùng chưa chọn gì, giao
 * diện theo hệ điều hành (prefers-color-scheme), y như tokens.css.
 * File thường (không phải module) để chạy được cả khi app.js lỗi. */
(function () {
  "use strict";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function current() {
    var t = root.getAttribute("data-theme");
    if (t === "dark" || t === "light") return t;
    return media && media.matches ? "dark" : "light";
  }

  function sync(btn) {
    var dark = current() === "dark";
    btn.setAttribute("aria-pressed", dark ? "true" : "false");
    btn.setAttribute("aria-label", dark ? "Bật giao diện sáng" : "Bật giao diện tối");
  }

  function init() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    sync(btn);
    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("eda-theme", next); } catch (e) { /* chế độ riêng tư */ }
      sync(btn);
    });
    if (media && media.addEventListener) {
      media.addEventListener("change", function () { sync(btn); });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
