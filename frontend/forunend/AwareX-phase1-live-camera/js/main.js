/* =========================================================
   AwareX - Landing page JavaScript
   Scroll reveal + general landing-page interactions only.
   Navigation logic lives in js/navigation.js
   Authentication logic lives in js/auth.js
   ========================================================= */
(function () {
  "use strict";

  /* ---------- Intersection Observer: fade-in on scroll ---------- */
  function initFadeIn() {
    var sections = document.querySelectorAll(".fade-in-section");
    if (!sections.length) return;

    if (!("IntersectionObserver" in window)) {
      sections.forEach(function (el) {
        el.classList.add("is-visible");
      });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            obs.unobserve(entry.target); // animate once
          }
        });
      },
      { root: null, rootMargin: "0px", threshold: 0.1 }
    );

    sections.forEach(function (section) {
      observer.observe(section);
    });
  }

  /* ---------- Lazy loading for below-the-fold images ---------- */
  function initLazyImages() {
    document.querySelectorAll("img").forEach(function (img, index) {
      if (index > 1 && !img.hasAttribute("loading")) {
        img.setAttribute("loading", "lazy");
        img.setAttribute("decoding", "async");
      }
    });
  }

  function init() {
    initFadeIn();
    initLazyImages();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
