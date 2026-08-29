/* =========================================================
   AwareX - Authentication JavaScript (demo mode)
   Validation, password visibility, strength meter, loading
   states, success states, and localStorage demo auth flow.
   ========================================================= */
(function () {
  "use strict";

  var DEFAULT_DASHBOARD_URL = "dashboard.html";
  var USERS_KEY = "awarexUsers";
  var SESSION_KEY = "awarexUser";
  var RESET_KEY = "awarexResetRequest";

  function getRedirectUrl() {
    try {
      var params = new URLSearchParams(window.location.search || "");
      var redirect = params.get("redirect");
      if (redirect && /^[-./\w?=&%]+$/.test(redirect)) {
        return redirect;
      }
    } catch (e) {
      // Fall back to the default dashboard route.
    }
    return DEFAULT_DASHBOARD_URL;
  }

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((value || "").trim());
  }

  function setAlert(id, message, visible) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-visible", !!visible);
  }

  function clearAlert(id) {
    setAlert(id, "", false);
  }

  function setFieldError(input, message) {
    if (!input) return;
    input.classList.add("is-invalid");
    var box = document.querySelector('[data-error-for="' + input.id + '"]');
    if (box) {
      box.textContent = message || "";
      box.classList.add("is-visible");
    }
  }

  function clearFieldError(input) {
    if (!input) return;
    input.classList.remove("is-invalid");
    var box = document.querySelector('[data-error-for="' + input.id + '"]');
    if (box) {
      box.textContent = "";
      box.classList.remove("is-visible");
    }
  }

  function clearFormState(form) {
    if (!form) return;
    form.querySelectorAll(".auth-input").forEach(function (input) {
      clearFieldError(input);
      input.disabled = false;
    });
    form.querySelectorAll(".auth-error").forEach(function (box) {
      box.textContent = "";
      box.classList.remove("is-visible");
    });
    form.querySelectorAll(".auth-btn").forEach(function (button) {
      button.classList.remove("is-loading");
      button.disabled = false;
      if (button.dataset.defaultLabel) {
        button.innerHTML = button.dataset.defaultLabel;
      }
    });
    clearAlert("authError");
    clearAlert("authSuccess");
  }

  function setBusy(form, busy, button) {
    if (!button) return;
    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = button.innerHTML;
    }
    button.classList.toggle("is-loading", busy);
    button.disabled = busy;
    if (busy) {
      button.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">progress_activity</span><span class="auth-loading-copy-text">' + button.dataset.loadingLabel + "</span>";
    } else {
      button.innerHTML = button.dataset.defaultLabel;
    }
    if (form) {
      form.querySelectorAll(".auth-input, .auth-social-button, .auth-toggle-pw").forEach(function (control) {
        control.disabled = busy && control !== button;
      });
    }
  }

  function toggleView(hiddenElement, visibleElement) {
    if (hiddenElement) hiddenElement.hidden = true;
    if (visibleElement) visibleElement.hidden = false;
  }

  function setButtonLabel(button, label, loadingLabel) {
    if (!button) return;
    button.dataset.defaultLabel = label;
    button.dataset.loadingLabel = loadingLabel;
    button.innerHTML = label;
  }

  function initPasswordToggles() {
    document.querySelectorAll("[data-toggle-password]").forEach(function (button) {
      button.addEventListener("click", function () {
        var target = document.getElementById(button.getAttribute("data-toggle-password"));
        if (!target) return;
        var isShown = target.type === "text";
        target.type = isShown ? "password" : "text";
        button.setAttribute("aria-label", isShown ? "Show password" : "Hide password");
        button.setAttribute("aria-pressed", isShown ? "false" : "true");
        var icon = button.querySelector(".material-symbols-outlined");
        if (icon) icon.textContent = isShown ? "visibility" : "visibility_off";
      });
    });
  }

  function scorePassword(value) {
    var score = 0;
    if ((value || "").length >= 8) score += 1;
    if (/[A-Z]/.test(value || "")) score += 1;
    if (/\d/.test(value || "")) score += 1;
    return score;
  }

  function updateStrength(passwordInput) {
    if (!passwordInput) return;
    var field = passwordInput.closest(".auth-field");
    var card = field ? field.querySelector("[data-password-strength]") : null;
    if (!card) return;

    var score = scorePassword(passwordInput.value);
    var state = score <= 1 ? "weak" : score === 2 ? "medium" : "strong";
    var label = state.charAt(0).toUpperCase() + state.slice(1);
    var labelNode = card.querySelector("[data-strength-label]");
    var requirements = card.querySelectorAll("[data-strength-rule]");

    card.classList.remove("is-weak", "is-medium", "is-strong");
    card.classList.add("is-" + state);

    if (labelNode) labelNode.textContent = label;

    requirements.forEach(function (rule) {
      var required = rule.getAttribute("data-strength-rule");
      var met = false;
      if (required === "length") met = (passwordInput.value || "").length >= 8;
      if (required === "upper") met = /[A-Z]/.test(passwordInput.value || "");
      if (required === "number") met = /\d/.test(passwordInput.value || "");
      rule.classList.toggle("is-met", met);
    });
  }

  function initLiveClearing(form) {
    form.querySelectorAll(".auth-input").forEach(function (input) {
      input.addEventListener("input", function () {
        clearFieldError(input);
        clearAlert("authError");
      });
    });
  }

  function initLogin() {
    var form = document.getElementById("loginForm");
    if (!form) return;

    var email = document.getElementById("login-email");
    var password = document.getElementById("login-password");
    var remember = document.getElementById("login-remember");
    var submitButton = document.getElementById("loginSubmit");
    var formView = document.querySelector('[data-auth-form-view="login"]');
    var successView = document.getElementById("loginSuccessView");
    var dashboardUrl = getRedirectUrl();

    setButtonLabel(submitButton, "Sign In to AwareX", "Signing in...");
    initLiveClearing(form);

    var rememberedEmail = localStorage.getItem("awarexRememberedEmail");
    if (rememberedEmail && email) {
      email.value = rememberedEmail;
      if (remember) remember.checked = true;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearFormState(form);

      var isValid = true;
      var trimmedEmail = email.value.trim();

      if (!trimmedEmail) {
        setFieldError(email, "Work email is required.");
        isValid = false;
      } else if (!isEmail(trimmedEmail)) {
        setFieldError(email, "Please enter a valid work email.");
        isValid = false;
      }

      if (!password.value) {
        setFieldError(password, "Password is required.");
        isValid = false;
      }

      if (!isValid) {
        setAlert("authError", "Please review the highlighted fields.", true);
        return;
      }

      setBusy(form, true, submitButton);

      window.setTimeout(function () {
        var users = read(USERS_KEY, []);
        var matchedUser = users.filter(function (user) {
          return user.email.toLowerCase() === trimmedEmail.toLowerCase();
        })[0];

        if (matchedUser && matchedUser.password !== password.value) {
          setBusy(form, false, submitButton);
          setFieldError(password, "Password is incorrect.");
          setAlert("authError", "Please review the highlighted fields.", true);
          return;
        }

        var activeUser = matchedUser || {
          name: trimmedEmail.split("@")[0],
          email: trimmedEmail,
          company: ""
        };

        write(SESSION_KEY, {
          name: activeUser.name,
          email: activeUser.email,
          company: activeUser.company || "",
          signedInAt: new Date().toISOString()
        });

        if (remember && remember.checked) {
          localStorage.setItem("awarexRememberedEmail", activeUser.email);
        } else {
          localStorage.removeItem("awarexRememberedEmail");
        }

        window.location.replace(dashboardUrl);
        return;

        clearAlert("authError");
        setAlert("authSuccess", "Sign in successful.", true);
        toggleView(formView, successView);
        setBusy(form, false, submitButton);
      }, 650);
    });
  }

  function initRegister() {
    var form = document.getElementById("registerForm");
    if (!form) return;

    var firstName = document.getElementById("reg-first");
    var lastName = document.getElementById("reg-last");
    var email = document.getElementById("reg-email");
    var phone = document.getElementById("reg-phone");
    var company = document.getElementById("reg-company");
    var title = document.getElementById("reg-title");
    var password = document.getElementById("reg-password");
    var confirmPassword = document.getElementById("reg-confirm");
    var terms = document.getElementById("reg-terms");
    var submitButton = document.getElementById("registerSubmit");
    var formView = document.querySelector('[data-auth-form-view="register"]');
    var successView = document.getElementById("registerSuccessView");

    setButtonLabel(submitButton, "Create AwareX Account", "Creating account...");
    initLiveClearing(form);

    [password, confirmPassword].forEach(function (input) {
      input.addEventListener("input", function () {
        updateStrength(password);
      });
    });
    updateStrength(password);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearFormState(form);

      var isValid = true;

      if (!firstName.value.trim()) {
        setFieldError(firstName, "First name is required.");
        isValid = false;
      }

      if (!lastName.value.trim()) {
        setFieldError(lastName, "Last name is required.");
        isValid = false;
      }

      if (!email.value.trim()) {
        setFieldError(email, "Work email is required.");
        isValid = false;
      } else if (!isEmail(email.value)) {
        setFieldError(email, "Please enter a valid work email.");
        isValid = false;
      }

      if (!phone.value.trim()) {
        setFieldError(phone, "Phone number is required.");
        isValid = false;
      }

      if (!company.value.trim()) {
        setFieldError(company, "Company or organization is required.");
        isValid = false;
      }

      if (!title.value.trim()) {
        setFieldError(title, "Job title is required.");
        isValid = false;
      }

      if (!password.value) {
        setFieldError(password, "Password is required.");
        isValid = false;
      } else if (password.value.length < 8) {
        setFieldError(password, "Use at least 8 characters.");
        isValid = false;
      } else if (!/[A-Z]/.test(password.value)) {
        setFieldError(password, "Include one uppercase letter.");
        isValid = false;
      } else if (!/\d/.test(password.value)) {
        setFieldError(password, "Include one number.");
        isValid = false;
      }

      if (!confirmPassword.value) {
        setFieldError(confirmPassword, "Please confirm your password.");
        isValid = false;
      } else if (confirmPassword.value !== password.value) {
        setFieldError(confirmPassword, "Passwords do not match.");
        isValid = false;
      }

      if (!terms.checked) {
        setFieldError(terms, "You must agree to the AwareX terms.");
        isValid = false;
      }

      updateStrength(password);

      if (!isValid) {
        setAlert("authError", "Please review the highlighted fields.", true);
        return;
      }

      setBusy(form, true, submitButton);

      window.setTimeout(function () {
        var users = read(USERS_KEY, []);
        var normalizedEmail = email.value.trim().toLowerCase();
        var exists = users.some(function (user) {
          return user.email.toLowerCase() === normalizedEmail;
        });

        if (exists) {
          setBusy(form, false, submitButton);
          setFieldError(email, "An account with this work email already exists.");
          setAlert("authError", "Please review the highlighted fields.", true);
          return;
        }

        var fullName = firstName.value.trim() + " " + lastName.value.trim();
        users.push({
          name: fullName,
          firstName: firstName.value.trim(),
          lastName: lastName.value.trim(),
          email: email.value.trim(),
          phone: phone.value.trim(),
          company: company.value.trim(),
          title: title.value.trim(),
          password: password.value,
          createdAt: new Date().toISOString()
        });
        write(USERS_KEY, users);
        write(SESSION_KEY, {
          name: fullName,
          email: email.value.trim(),
          company: company.value.trim(),
          signedInAt: new Date().toISOString()
        });

        localStorage.setItem("awarexRememberedEmail", email.value.trim());
        setAlert("authSuccess", "Welcome to AwareX.", true);
        toggleView(formView, successView);
        setBusy(form, false, submitButton);
      }, 700);
    });
  }

  function initForgot() {
    var form = document.getElementById("forgotForm");
    if (!form) return;

    var email = document.getElementById("forgot-email");
    var submitButton = document.getElementById("forgotSubmit");
    var formView = document.querySelector('[data-auth-form-view="forgot"]');
    var successView = document.getElementById("forgotSuccessView");
    var retryButton = document.getElementById("forgotRetry");

    setButtonLabel(submitButton, "Send Reset Link", "Sending reset link...");
    initLiveClearing(form);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearFormState(form);

      var trimmedEmail = email.value.trim();
      var isValid = true;

      if (!trimmedEmail) {
        setFieldError(email, "Work email is required.");
        isValid = false;
      } else if (!isEmail(trimmedEmail)) {
        setFieldError(email, "Please enter a valid work email.");
        isValid = false;
      }

      if (!isValid) {
        setAlert("authError", "Please review the highlighted fields.", true);
        return;
      }

      setBusy(form, true, submitButton);

      window.setTimeout(function () {
        write(RESET_KEY, {
          email: trimmedEmail,
          requestedAt: new Date().toISOString()
        });

        setAlert("authSuccess", "Check your inbox.", true);
        toggleView(formView, successView);
        setBusy(form, false, submitButton);
      }, 650);
    });

    if (retryButton) {
      retryButton.addEventListener("click", function () {
        toggleView(successView, formView);
        clearFormState(form);
        email.focus();
      });
    }
  }

  function init() {
    initPasswordToggles();
    initLogin();
    initRegister();
    initForgot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
