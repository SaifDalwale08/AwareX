/* =========================================================
   AwareX - Navigation JavaScript
   Navbar scroll effect, mobile menu, smooth scrolling,
   active link highlighting.
   Sign In / Get Started use real links (login.html /
   register.html) - no modal overlays.
   ========================================================= */
(function () {
  "use strict";

  /* ---------- Navbar shadow on scroll ---------- */
  function initNavScroll() {
    var nav = document.getElementById("topNav");
    if (!nav) return;

    function onScroll() {
      if (window.scrollY > 10) {
        nav.classList.add("is-scrolled", "shadow-md");
        nav.classList.remove("shadow-sm");
      } else {
        nav.classList.remove("is-scrolled", "shadow-md");
        nav.classList.add("shadow-sm");
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- Mobile menu ---------- */
  function initMobileMenu() {
    var toggle = document.getElementById("navToggle");
    var menu = document.getElementById("mobileMenu");
    if (!toggle || !menu) return;

    function setOpen(open) {
      menu.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      var icon = toggle.querySelector(".material-symbols-outlined");
      if (icon) icon.textContent = open ? "close" : "menu";
    }

    toggle.addEventListener("click", function () {
      setOpen(!menu.classList.contains("is-open"));
    });

    menu.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        setOpen(false);
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth >= 1024) setOpen(false);
    });
  }

  /* ---------- Smooth scrolling for in-page anchors ---------- */
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
      anchor.addEventListener("click", function (e) {
        var href = this.getAttribute("href");
        if (!href || href === "#") return;
        var target = document.querySelector(href);
        if (!target) return; // never break the page on a missing anchor
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth" });
        if (history.replaceState) history.replaceState(null, "", href);
      });
    });
  }

  /* ---------- Active navigation link ---------- */
  function initActiveLink() {
    var links = Array.prototype.slice.call(
      document.querySelectorAll('#topNav a[href^="#"]')
    );
    if (!links.length) return;

    var targets = links
      .map(function (link) {
        var el = document.querySelector(link.getAttribute("href"));
        return el ? { link: link, el: el } : null;
      })
      .filter(Boolean);

    function onScroll() {
      var pos = window.scrollY + 140;
      var current = null;
      targets.forEach(function (t) {
        if (t.el.offsetTop <= pos) current = t;
      });
      links.forEach(function (l) {
        l.classList.remove("is-active");
      });
      if (current) current.link.classList.add("is-active");
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  function init() {
    initNavScroll();
    initMobileMenu();
    initSmoothScroll();
    initActiveLink();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
