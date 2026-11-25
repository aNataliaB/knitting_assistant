const DEFAULT_THEME = "wild-rose";
const ALLOWED_THEMES = ["wild-rose", "mint-pistachio", "ocean-blue", "honey-amber"];

const PROJECT_STATUS_LABELS = {
  in_progress: "W trakcie",
  paused: "Odłożony",
  completed: "Ukończony"
};

const YARN_STATUS_LABELS = {
  in_stash: "W zapasie",
  in_use: "W robótce",
  used_up: "Zużyta"
};

let currentUser = null;
let projects = [];
let yarns = [];
let activeProjectId = null;
let authMode = "login";
let notesSaveTimeout = null;
let shapingSaveTimeout = null;
let historyBatchTimeout = null;
let historyBatchStartRows = null;
let lastRowUndoSnapshot = null;
let wakeLockSentinel = null;
let lastGaugeSummary = "";
let lastLengthCalcRows = 0;
let lastStripesSummary = "";
let pendingYarnPhotoData = "";
let editingYarnId = null;
let editingProjectId = null;
let pendingProjectPhotoData = "";
let focusModeActive = false;
let notifiedReminderIds = new Set();

function applyTheme(themeName) {
  const validTheme = ALLOWED_THEMES.includes(themeName) ? themeName : DEFAULT_THEME;
  document.documentElement.setAttribute("data-theme", validTheme);
  localStorage.setItem("knittingTheme", validTheme);

  document.querySelectorAll(".theme-option").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.themeValue === validTheme);
  });
}

function selectTheme(themeName) {
  applyTheme(themeName);
}

document.addEventListener("DOMContentLoaded", async () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => { });
  }
  const savedTheme = localStorage.getItem("knittingTheme") || DEFAULT_THEME;
  applyTheme(savedTheme);
  updateNotificationButtonUI();
  await checkSession();
});

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  if (response.status === 401 && !url.includes("/change-password") && !url.includes("/account")) {
    currentUser = null;
    projects = [];
    yarns = [];
    activeProjectId = null;
    renderAuthView();
    throw new Error("Sesja wygasła. Zaloguj się ponownie.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Wystąpił błąd serwera.");
  }
  return data;
}

// === ESTETYCZNE POWIADOMIENIA (TOASTY) I MODAL POTWIERDZENIA ===

function showToast(message, type = "info", duration = 3600) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const icons = {
    success: "✓",
    error: "!",
    warning: "⚠",
    info: "ℹ"
  };

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", "status");

  const iconEl = document.createElement("span");
  iconEl.className = "toast-icon";
  iconEl.textContent = icons[type] || icons.info;

  const textEl = document.createElement("span");
  textEl.className = "toast-text";
  textEl.textContent = message;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "Zamknij powiadomienie");
  closeBtn.textContent = "✕";

  const removeToast = () => {
    if (toast.classList.contains("toast-leave")) return;
    toast.classList.add("toast-leave");
    setTimeout(() => toast.remove(), 220);
  };

  closeBtn.addEventListener("click", removeToast);

  toast.append(iconEl, textEl, closeBtn);
  container.appendChild(toast);

  if (duration > 0) {
    toast.style.setProperty("--toast-duration", `${duration}ms`);
    setTimeout(removeToast, duration);
  }
}

function showConfirm(message, options = {}) {
  const {
    title = "Potwierdź działanie",
    confirmText = "Potwierdź",
    cancelText = "Anuluj",
    danger = false
  } = options;

  return new Promise(resolve => {
    const modal = document.getElementById("confirmModal");
    const titleEl = document.getElementById("confirmTitle");
    const msgEl = document.getElementById("confirmMessage");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");

    if (!modal || !okBtn || !cancelBtn) {
      resolve(window.confirm(message));
      return;
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = danger ? "btn-danger" : "btn-primary";
    modal.style.display = "flex";

    const cleanup = result => {
      modal.style.display = "none";
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onEsc);
      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = e => {
      if (e.target === modal) cleanup(false);
    };
    const onEsc = e => {
      if (e.key === "Escape") cleanup(false);
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onEsc);
  });
}

// === AUTORYZACJA ===

async function checkSession() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    const data = await res.json();
    currentUser = data.user || null;
  } catch {
    currentUser = null;
  }

  if (currentUser) {
    await showAuthenticatedApp();
  } else {
    renderAuthView();
  }
}

function switchAuthMode(mode) {
  authMode = mode;
  document.getElementById("tabLogin").classList.toggle("active", mode === "login");
  document.getElementById("tabRegister").classList.toggle("active", mode === "register");
  document.getElementById("authConfirmWrap").style.display = mode === "register" ? "block" : "none";
  document.getElementById("authPasswordConfirm").required = mode === "register";
  document.getElementById("authPassword").autocomplete = mode === "login" ? "current-password" : "new-password";
  document.getElementById("authSubmitBtn").textContent = mode === "login" ? "Zaloguj się" : "Utwórz konto";
  hideAuthError();
}

function showAuthError(message) {
  const el = document.getElementById("authError");
  el.textContent = message;
  el.style.display = "block";
}

function hideAuthError() {
  const el = document.getElementById("authError");
  el.textContent = "";
  el.style.display = "none";
}

function renderAuthView() {
  document.getElementById("authSection").style.display = "block";
  document.getElementById("appSection").style.display = "none";
  document.getElementById("userGreeting").style.display = "none";
  document.getElementById("topSettingsBtn").style.display = "none";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  hideAuthError();

  const username = document.getElementById("authUsername").value.trim();
  const password = document.getElementById("authPassword").value;
  const confirm = document.getElementById("authPasswordConfirm").value;

  if (authMode === "register" && password !== confirm) {
    showAuthError("Hasła nie są identyczne.");
    return;
  }

  const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";

  try {
    const data = await apiRequest(endpoint, {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    currentUser = data.user;
    document.getElementById("authForm").reset();
    await showAuthenticatedApp();
  } catch (err) {
    showAuthError(err.message);
  }
}

async function logout() {
  if (!(await showConfirm("Czy na pewno chcesz się wylogować?", { title: "Wylogowanie", confirmText: "Wyloguj" }))) {
    return;
  }
  clearTimeout(notesSaveTimeout);
  clearTimeout(shapingSaveTimeout);
  clearTimeout(historyBatchTimeout);
  await releaseWakeLock();
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  currentUser = null;
  projects = [];
  yarns = [];
  activeProjectId = null;

  const firstTabBtn = document.querySelector(".tabs .tab-btn");
  if (firstTabBtn) {
    openTab("counter", firstTabBtn);
  }
  renderAuthView();
}

async function handleChangePassword(event) {
  event.preventDefault();
  const currentPassword = document.getElementById("oldPasswordInput").value;
  const newPassword = document.getElementById("newPasswordInput").value;
  const confirmPassword = document.getElementById("confirmNewPasswordInput").value;

  if (newPassword !== confirmPassword) {
    showToast("Nowe hasła nie są identyczne.", "warning");
    return;
  }

  try {
    await apiRequest("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
    });
    document.getElementById("oldPasswordInput").value = "";
    document.getElementById("newPasswordInput").value = "";
    document.getElementById("confirmNewPasswordInput").value = "";
    showToast("Hasło zostało pomyślnie zmienione.", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function handleDeleteAccount() {
  const password = prompt("Aby trwale usunąć konto i wszystkie dane, wpisz swoje hasło:");
  if (!password) return;
  const confirmed = await showConfirm(
    "Tej operacji nie można cofnąć. Czy na pewno usunąć konto wraz ze wszystkimi projektami i włóczkami?",
    { title: "Trwałe usunięcie konta", confirmText: "Usuń konto", danger: true }
  );
  if (!confirmed) return;

  try {
    await apiRequest("/api/auth/account", {
      method: "DELETE",
      body: JSON.stringify({ password })
    });
    currentUser = null;
    projects = [];
    yarns = [];
    activeProjectId = null;
    renderAuthView();
    showToast("Konto zostało usunięte.", "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function showAuthenticatedApp() {
  document.getElementById("authSection").style.display = "none";
  document.getElementById("appSection").style.display = "block";
  document.getElementById("userGreeting").style.display = "inline-flex";
  document.getElementById("topSettingsBtn").style.display = "inline-flex";
  document.getElementById("headerUsername").textContent = currentUser.username;
  document.getElementById("settingsUsername").textContent = currentUser.username;

  const firstTabBtn = document.querySelector(".tabs .tab-btn");
  if (firstTabBtn) {
    openTab("counter", firstTabBtn);
  }

  await loadYarnsFromServer();
  await loadProjectsFromServer();
  await Promise.all([loadStats(), loadReminders()]);
}

function openTab(tabName, clickedBtn) {
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("topSettingsBtn").classList.remove("active");

  document.getElementById(tabName).classList.add("active");
  if (clickedBtn) {
    clickedBtn.classList.add("active");
  }
}

function goToCounterTab() {
  const btn = document.querySelector(".tabs .tab-btn[onclick*='counter']");
  openTab("counter", btn);
}

// --- TRYB SKUPIENIA I LIGHTBOX ---

function toggleFocusMode() {
  focusModeActive = !focusModeActive;
  document.body.classList.toggle("focus-mode", focusModeActive);
  const btn = document.getElementById("focusModeBtn");
  if (btn) {
    btn.classList.toggle("active", focusModeActive);
    btn.textContent = focusModeActive ? "🎯 Wyjdź ze skupienia" : "🎯 Tryb skupienia";
  }
}

function openLightbox(src, caption = "") {
  if (!src) return;
  const box = document.getElementById("imageLightbox");
  document.getElementById("lightboxImage").src = src;
  document.getElementById("lightboxCaption").textContent = caption;
  box.style.display = "flex";
}

function closeLightbox(event) {
  if (event && event.target && event.target.id !== "imageLightbox") return;
  document.getElementById("imageLightbox").style.display = "none";
  document.getElementById("lightboxImage").src = "";
}

// --- PROJEKTY I OSTRZEŻENIA O WŁÓCZCE ---

function populateProjectYarnSelect() {
  const select = document.getElementById("projectYarnSelect");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">— Wpisz ręcznie poniżej —</option>';
  yarns.forEach(y => {
    const opt = document.createElement("option");
    opt.value = y.id;
    opt.textContent = `${y.name}${y.color_lot ? ` (${y.color_lot})` : ""} — ${y.skeins} mot.`;
    select.appendChild(opt);
  });
  select.value = current;
  checkProjectYarnAvailability();
}

function checkProjectYarnAvailability() {
  const warningEl = document.getElementById("projectYarnStockWarning");
  if (!warningEl) return;

  const yarnId = Number(document.getElementById("projectYarnSelect")?.value || 0);
  const needed = parseFloat(document.getElementById("projectYarnSkeinsUsed")?.value) || 0;
  if (!yarnId) {
    warningEl.style.display = "none";
    return;
  }

  const yarn = yarns.find(y => y.id === yarnId);
  if (!yarn) {
    warningEl.style.display = "none";
    return;
  }

  const available = Number(yarn.skeins) || 0;
  if (available <= 0) {
    warningEl.textContent = `⚠️ Włóczka „${yarn.name}” ma 0 motków w zapasie!`;
    warningEl.classList.add("alert-warning-yarn");
    warningEl.style.display = "block";
  } else if (needed > available) {
    const missing = Math.round((needed - available) * 10) / 10;
    warningEl.textContent = `⚠️ Brakuje ${missing} mot. włóczki „${yarn.name}” (w zapasie: ${available} mot., potrzeba: ${needed} mot.).`;
    warningEl.classList.add("alert-warning-yarn");
    warningEl.style.display = "block";
  } else if (needed > 0) {
    warningEl.textContent = `✅ Wystarczający zapas „${yarn.name}”: masz ${available} mot. (planowane zużycie: ${needed} mot.).`;
    warningEl.classList.remove("alert-warning-yarn");
    warningEl.style.display = "block";
  } else {
    warningEl.style.display = "none";
  }
}

function onProjectYarnSelect() {
  const yarnId = Number(document.getElementById("projectYarnSelect").value);
  checkProjectYarnAvailability();
  if (!yarnId) return;
  const yarn = yarns.find(y => y.id === yarnId);
  if (!yarn) return;
  const detailsInput = document.getElementById("projectYarnDetails");
  if (!detailsInput.value.trim()) {
    detailsInput.value = [yarn.name, yarn.brand, yarn.color_lot, yarn.fiber].filter(Boolean).join(" · ");
  }
}

function updateCounterYarnAlert(project) {
  const alertEl = document.getElementById("counterYarnAlert");
  if (!alertEl) return;

  if (!project || !project.yarn_id) {
    alertEl.style.display = "none";
    return;
  }

  const yarn = yarns.find(y => y.id === project.yarn_id);
  if (!yarn) {
    alertEl.style.display = "none";
    return;
  }

  const available = Number(yarn.skeins) || 0;
  const planned = Number(project.yarn_skeins_used) || 0;

  if (available <= 0) {
    alertEl.textContent = `⚠️ Uwaga: przypisana włóczka „${yarn.name}” została wyczerpana (0 motków w zapasach).`;
    alertEl.classList.add("alert-warning-yarn");
    alertEl.style.display = "block";
  } else if (planned > 0 && available < planned) {
    const missing = Math.round((planned - available) * 10) / 10;
    alertEl.textContent = `⚠️ Brakująca włóczka: w zapasie jest ${available} mot. „${yarn.name}”, a projekt zakłada ${planned} mot. (brakuje ${missing} mot.).`;
    alertEl.classList.add("alert-warning-yarn");
    alertEl.style.display = "block";
  } else {
    alertEl.style.display = "none";
  }
}

async function loadProjectsFromServer() {
  const data = await apiRequest("/api/projects");
  projects = data.projects || [];

  if (projects.length > 0) {
    const stillExists = projects.some(p => p.id === activeProjectId);
    activeProjectId = stillExists ? activeProjectId : projects[0].id;
  } else {
    activeProjectId = null;
  }

  renderProjectList();
  renderActiveProject();
  if (activeProjectId) {
    await Promise.all([loadProjectHistory(), loadProjectChecklist(), loadSubcounters(), loadTimerState()]);
  }
}

async function saveProjectForm(event) {
  event.preventDefault();
  const get = id => document.getElementById(id)?.value?.trim() || "";
  const file = document.getElementById("projectPhoto")?.files?.[0];
  if (file) {
    try {
      pendingProjectPhotoData = await compressImageToDataUrl(file, 960, 0.8);
    } catch {
      return showToast("Nie udało się przetworzyć zdjęcia projektu.", "warning");
    }
  }

  const yarnIdVal = Number(document.getElementById("projectYarnSelect")?.value || 0) || null;
  const skeinsUsedVal = parseFloat(document.getElementById("projectYarnSkeinsUsed")?.value) || 0;
  const targetRowsVal = parseInt(document.getElementById("projectTargetRows")?.value, 10) || 0;
  const deductFromStash = Boolean(document.getElementById("projectDeductYarn")?.checked);

  const payload = {
    name: get("projectName"),
    category: get("projectCategory"),
    tools: get("needleSize"),
    difficulty: get("projectDifficulty"),
    start_date: get("projectStartDate"),
    target_date: get("projectTargetDate"),
    status: get("projectStatusInput"),
    size_label: get("projectSize"),
    target_rows: targetRowsVal,
    source_url: get("projectSourceUrl"),
    yarn_id: yarnIdVal,
    yarn_skeins_used: skeinsUsedVal,
    deduct_from_stash: deductFromStash,
    yarn_details: get("projectYarnDetails"),
    gauge: get("projectGauge"),
    dimensions: get("projectDimensions"),
    notes: get("projectFormNotes"),
    shaping_rule: get("shapingRuleInput"),
    photo_data: pendingProjectPhotoData
  };
  if (!payload.name) return showToast("Podaj nazwę projektu.", "warning");

  try {
    let data;
    const wasEditing = Boolean(editingProjectId);
    if (editingProjectId) {
      data = await apiRequest(`/api/projects/${editingProjectId}`, { method: "PATCH", body: JSON.stringify(payload) });
      const index = projects.findIndex(p => p.id === editingProjectId);
      if (index >= 0) projects[index] = data.project;
      activeProjectId = editingProjectId;
    } else {
      data = await apiRequest("/api/projects", { method: "POST", body: JSON.stringify(payload) });
      projects.unshift(data.project);
      activeProjectId = data.project.id;
    }
    resetProjectForm();
    if (deductFromStash) {
      await loadYarnsFromServer();
    }
    renderProjectList();
    renderActiveProject();
    await Promise.all([loadProjectHistory(), loadProjectChecklist(), loadSubcounters(), loadTimerState()]);
    document.getElementById("projectDetailsCard").open = true;
    showToast(wasEditing ? "Projekt został zaktualizowany." : "Projekt został dodany.", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function duplicateCurrentProject() {
  if (!activeProjectId) return showToast("Najpierw wybierz projekt.", "warning");
  try {
    const data = await apiRequest(`/api/projects/${activeProjectId}/duplicate`, { method: "POST" });
    projects.unshift(data.project);
    activeProjectId = data.project.id;
    renderProjectList();
    renderActiveProject();
    await Promise.all([loadProjectHistory(), loadProjectChecklist(), loadSubcounters(), loadTimerState()]);
    showToast(`Utworzono kopię szablonu: ${data.project.name}`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function resetProjectForm() {
  const form = document.getElementById("projectForm");
  form?.reset();
  editingProjectId = null;
  pendingProjectPhotoData = "";
  document.getElementById("projectFormHeading").textContent = "Dodaj nowy projekt";
  document.getElementById("projectSubmitBtn").textContent = "＋ Dodaj projekt";
  document.getElementById("cancelProjectEdit").hidden = true;
  const warningEl = document.getElementById("projectYarnStockWarning");
  if (warningEl) warningEl.style.display = "none";
}

function editCurrentProject() {
  const p = projects.find(item => item.id === activeProjectId);
  if (!p) return showToast("Najpierw wybierz projekt.", "warning");
  editingProjectId = p.id;
  const fields = {
    projectName: "name",
    projectCategory: "category",
    needleSize: "tools",
    projectDifficulty: "difficulty",
    projectStartDate: "start_date",
    projectTargetDate: "target_date",
    projectStatusInput: "status",
    projectSize: "size_label",
    projectTargetRows: "target_rows",
    projectSourceUrl: "source_url",
    projectYarnSelect: "yarn_id",
    projectYarnSkeinsUsed: "yarn_skeins_used",
    projectYarnDetails: "yarn_details",
    projectGauge: "gauge",
    projectDimensions: "dimensions",
    projectFormNotes: "notes",
    shapingRuleInput: "shaping_rule"
  };
  Object.entries(fields).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.value = p[key] ?? "";
  });
  document.getElementById("projectDeductYarn").checked = false;
  pendingProjectPhotoData = p.photo_data || "";
  document.getElementById("projectFormHeading").textContent = `Edytujesz: ${p.name}`;
  document.getElementById("projectSubmitBtn").textContent = "Zapisz zmiany";
  document.getElementById("cancelProjectEdit").hidden = false;
  checkProjectYarnAvailability();
  document.querySelector("#projects .collapsible-card").open = true;
  document.getElementById("projects").scrollIntoView({ behavior: "smooth" });
}

function selectProject(id) {
  if (!id || !projects.some(p => p.id === id)) return;
  clearTimeout(notesSaveTimeout);
  clearTimeout(shapingSaveTimeout);
  clearTimeout(historyBatchTimeout);
  historyBatchStartRows = null;
  lastRowUndoSnapshot = null;
  activeProjectId = id;
  renderProjectList();
  renderActiveProject();
  loadProjectHistory();
  loadProjectChecklist();
  loadSubcounters();
  loadTimerState();
}

function updateRowProgressUI(project) {
  const wrap = document.getElementById("rowProgressWrap");
  if (!wrap) return;
  const goal = Number(project.target_rows) || 0;
  if (goal <= 0) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";
  const pct = Math.min(100, Math.round((project.rows / goal) * 100));
  document.getElementById("rowProgressText").textContent = `Postęp: ${project.rows} / ${goal} rz. (${pct}%)`;
  document.getElementById("rowProgressBar").style.width = `${pct}%`;

  const etaEl = document.getElementById("rowEtaText");
  const remaining = Math.max(0, goal - project.rows);
  if (remaining === 0) {
    etaEl.textContent = "🎉 Cel osiągnięty!";
  } else if (project.rows > 0 && timerSeconds >= 60) {
    const secPerRow = timerSeconds / project.rows;
    const estSeconds = Math.round(remaining * secPerRow);
    const estH = Math.floor(estSeconds / 3600);
    const estM = Math.round((estSeconds % 3600) / 60);
    etaEl.textContent = `Szacowany czas: ~${estH > 0 ? `${estH} h ` : ""}${estM} min`;
  } else {
    etaEl.textContent = `Pozostało: ${remaining} rz.`;
  }
}

function updateShapingBanner(project) {
  const alertEl = document.getElementById("shapingAlert");
  if (!alertEl) return;
  const rule = (project.shaping_rule || "").trim();
  if (!rule) {
    alertEl.style.display = "none";
    return;
  }

  const match = rule.match(/co\s+(\d+)/i);
  const interval = match ? parseInt(match[1], 10) : null;

  if (interval && interval > 0 && project.rows > 0 && project.rows % interval === 0) {
    alertEl.textContent = `🔔 Rząd ${project.rows} (wielokrotność ${interval}): ${rule}`;
    alertEl.style.display = "block";
  } else if (interval && interval > 0) {
    const nextRow = (Math.floor(project.rows / interval) + 1) * interval;
    alertEl.textContent = `📌 Reguła: ${rule} (następna zmiana w rzędzie ${nextRow})`;
    alertEl.style.display = "block";
  } else {
    alertEl.textContent = `📌 Reguła: ${rule}`;
    alertEl.style.display = "block";
  }
}

function renderActiveProject() {
  const card = document.getElementById("activeProjectCard");
  const project = projects.find(p => p.id === activeProjectId);

  if (!project) {
    card.style.display = "none";
    return;
  }

  card.style.display = "block";
  card.open = true;
  document.getElementById("currentProjectSummaryTitle").textContent = `Aktywny: ${project.name}`;
  document.getElementById("currentProjectTitle").textContent = project.name;
  document.getElementById("currentProjectTools").textContent = `Narzędzia: ${project.tools}`;
  document.getElementById("projectStatusSelect").value = project.status || "in_progress";
  document.getElementById("rowCount").textContent = project.rows;
  document.getElementById("secondaryRowCount").textContent = project.secondary_rows || 0;
  document.getElementById("stitchCount").textContent = project.stitches || 0;
  document.getElementById("repeatCount").textContent = project.repeats;

  updateCounterYarnAlert(project);
  updateRowProgressUI(project);
  renderChartTracker(project);

  const shaping = document.getElementById("counterShapingRule");
  if (shaping) shaping.value = project.shaping_rule || "";
  const notes = document.getElementById("projectNotes");
  if (notes) notes.value = project.notes || "";

  // Szybki podgląd notatek i wzoru w Pracowni
  const quickNotes = document.getElementById("counterQuickNotes");
  if (quickNotes) quickNotes.value = project.notes || "";
  const quickStatus = document.getElementById("counterQuickNotesStatus");
  if (quickStatus) quickStatus.textContent = "Zsynchronizowano z projektem";

  const quickMeta = document.getElementById("counterPatternMeta");
  if (quickMeta) {
    const metaInfo = [
      project.category ? `Kategoria: ${project.category}` : "",
      project.size_label ? `Rozmiar: ${project.size_label}` : "",
      project.gauge ? `Próbka: ${project.gauge}` : "",
      project.yarn_details ? `Włóczka: ${project.yarn_details}` : ""
    ].filter(Boolean);
    quickMeta.textContent = metaInfo.join(" · ");
    quickMeta.style.display = metaInfo.length ? "block" : "none";
  }

  const patternLink = document.getElementById("counterPatternLink");
  if (patternLink) {
    if (project.source_url) {
      patternLink.href = project.source_url;
      patternLink.style.display = "inline-block";
    } else {
      patternLink.style.display = "none";
    }
  }

  const detail = document.getElementById("projectDetailsSummary");
  if (detail) {
    detail.innerHTML = "";
    const linkedYarn = project.yarn_id ? yarns.find(y => y.id === project.yarn_id) : null;
    const yarnText = linkedYarn
      ? `${linkedYarn.name}${project.yarn_skeins_used ? ` (${project.yarn_skeins_used} mot.)` : ""}`
      : project.yarn_details;

    const lines = [
      ["Status", PROJECT_STATUS_LABELS[project.status] || project.status],
      ["Kategoria", project.category],
      ["Cel rzędów", project.target_rows > 0 ? `${project.rows} / ${project.target_rows}` : ""],
      ["Rozpoczęcie", project.start_date],
      ["Termin", project.target_date],
      ["Narzędzia", project.tools],
      ["Trudność", project.difficulty],
      ["Rozmiar", project.size_label],
      ["Włóczka", yarnText],
      ["Próbka", project.gauge],
      ["Wymiary", project.dimensions]
    ].filter(x => x[1]);

    lines.forEach(([label, value]) => {
      const row = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = label + ": ";
      row.append(strong, document.createTextNode(value));
      detail.appendChild(row);
    });

    if (project.source_url) {
      const a = document.createElement("a");
      a.href = project.source_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Otwórz link do wzoru ↗";
      detail.appendChild(a);
    }

    if (project.photo_data) {
      const img = document.createElement("img");
      img.src = project.photo_data;
      img.alt = "Zdjęcie projektu";
      img.className = "project-photo-preview";
      img.title = "Kliknij, aby powiększyć";
      img.onclick = () => openLightbox(project.photo_data, project.name);
      detail.appendChild(img);
    }
  }

  const saveStatus = document.getElementById("saveStatus");
  if (saveStatus) saveStatus.textContent = "Zapisano w bazie";
  updateShapingBanner(project);
}

function renderProjectList() {
  const list = document.getElementById("projectList");
  if (!list) return;
  list.innerHTML = "";
  const search = (document.getElementById("projectSearch")?.value || "").toLocaleLowerCase("pl-PL").trim();
  const filter = document.getElementById("projectFilter")?.value || "all";
  const filtered = projects.filter(p => {
    const haystack = [p.name, p.category, p.yarn_details, p.tools, p.notes].join(" ").toLocaleLowerCase("pl-PL");
    return (!search || haystack.includes(search)) && (filter === "all" || p.status === filter);
  });
  if (!filtered.length) {
    const li = document.createElement("li");
    li.textContent = projects.length ? "Brak projektów pasujących do wyszukiwania." : "Brak zapisanych projektów. Dodaj pierwszy powyżej!";
    li.style.cursor = "default";
    list.appendChild(li);
  }
  filtered.forEach(project => {
    const li = document.createElement("li");
    li.className = project.id === activeProjectId ? "selected" : "";
    const main = document.createElement("div");
    main.className = "project-list-main";
    const name = document.createElement("strong");
    name.textContent = project.name;
    const meta = document.createElement("small");
    const rowLabel = project.target_rows > 0 ? `Rząd ${project.rows}/${project.target_rows}` : `Rząd ${project.rows}`;
    meta.textContent = [PROJECT_STATUS_LABELS[project.status] || "", project.category, rowLabel].filter(Boolean).join(" · ");
    main.append(name, meta);
    li.appendChild(main);
    if (project.id === activeProjectId) li.setAttribute("aria-current", "true");
    li.addEventListener("click", () => selectProject(project.id));
    list.appendChild(li);
  });

  const select = document.getElementById("counterProjectSelect");
  if (select) {
    const selected = String(activeProjectId || "");
    select.innerHTML = "";
    if (!projects.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "Najpierw dodaj projekt";
      select.appendChild(o);
    }
    projects.forEach(p => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      select.appendChild(o);
    });
    select.value = selected;
  }
}

async function patchProject(projectId, payload) {
  const data = await apiRequest(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  const idx = projects.findIndex(p => p.id === projectId);
  if (idx !== -1) {
    projects[idx] = data.project;
  }
  renderProjectList();
  return data.project;
}

async function changeProjectStatus() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;
  const status = document.getElementById("projectStatusSelect").value;
  const statusInput = document.getElementById("projectStatusInput");
  if (statusInput) statusInput.value = status;
  try {
    await patchProject(project.id, { status });
    showToast(`Status zmieniony na: ${PROJECT_STATUS_LABELS[status] || status}`, "success", 2200);
  } catch (err) {
    showToast(err.message, "error");
  }
}

function scheduleGroupedHistoryLog(projectId, previousRows, currentRows) {
  if (historyBatchStartRows === null) {
    historyBatchStartRows = previousRows;
  }
  clearTimeout(historyBatchTimeout);
  historyBatchTimeout = setTimeout(() => {
    const startR = historyBatchStartRows;
    historyBatchStartRows = null;
    if (startR === null || currentRows <= startR) return;
    const diff = currentRows - startR;
    const note = diff === 1
      ? `Przerobiono rząd ${currentRows}.`
      : `Przerobiono ${diff} rz. (od ${startR} do ${currentRows}).`;
    apiRequest(`/api/projects/${projectId}/history`, {
      method: "POST",
      body: JSON.stringify({ note })
    }).then(loadProjectHistory).catch(() => { });
  }, 3000);
}

async function changeRow(amount) {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;

  const prevRows = project.rows;
  lastRowUndoSnapshot = { projectId: project.id, rows: prevRows };
  const nextRows = Math.max(0, prevRows + amount);
  document.getElementById("rowCount").textContent = nextRows;

  const patchData = { rows: nextRows };
  if (project.chart_data && document.getElementById("chartSyncWithMain")?.checked) {
    const total = Math.max(1, project.chart_total_rows || 20);
    const nextChartRow = ((project.chart_current_row - 1 + amount) % total + total) % total + 1;
    patchData.chart_current_row = nextChartRow;
  }

  try {
    const updated = await patchProject(project.id, patchData);
    if (amount > 0) {
      scheduleGroupedHistoryLog(project.id, prevRows, updated.rows);
    }
    document.getElementById("rowCount").textContent = updated.rows;
    updateRowProgressUI(updated);
    updateShapingBanner(updated);
    renderChartTracker(updated);
  } catch (err) {
    showToast(err.message, "error");
    await loadProjectsFromServer();
  }
}

async function jumpToRow() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;

  const input = document.getElementById("jumpRowInput");
  const targetRow = parseInt(input?.value, 10);
  if (isNaN(targetRow) || targetRow < 0) {
    showToast("Podaj poprawny numer rzędu (0 lub więcej).", "warning");
    return;
  }

  const prevRows = project.rows;
  if (targetRow === prevRows) {
    input.value = "";
    return;
  }

  if (targetRow < prevRows) {
    const ok = await showConfirm(
      `Cofnąć licznik z rzędu ${prevRows} na rząd ${targetRow} (np. po pruciu)?`,
      { title: "Cofnięcie rzędów", confirmText: "Ustaw rząd", danger: true }
    );
    if (!ok) return;
  }

  lastRowUndoSnapshot = { projectId: project.id, rows: prevRows };
  const patchData = { rows: targetRow };

  if (project.chart_data && document.getElementById("chartSyncWithMain")?.checked) {
    const total = Math.max(1, project.chart_total_rows || 20);
    patchData.chart_current_row = targetRow > 0 ? ((targetRow - 1) % total) + 1 : 1;
  }

  try {
    const updated = await patchProject(project.id, patchData);
    document.getElementById("rowCount").textContent = updated.rows;
    input.value = "";
    updateRowProgressUI(updated);
    updateShapingBanner(updated);
    renderChartTracker(updated);
    await apiRequest(`/api/projects/${project.id}/history`, {
      method: "POST",
      body: JSON.stringify({ note: `Przeskok z rzędu ${prevRows} na ${updated.rows}.` })
    }).then(loadProjectHistory).catch(() => { });
    showToast(`Ustawiono rząd ${updated.rows}.`, "success", 2400);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function undoLastRowStep() {
  if (!lastRowUndoSnapshot || lastRowUndoSnapshot.projectId !== activeProjectId) {
    showToast("Brak ostatniej zmiany rzędów do cofnięcia.", "info");
    return;
  }
  const restoreRows = lastRowUndoSnapshot.rows;
  lastRowUndoSnapshot = null;
  clearTimeout(historyBatchTimeout);
  historyBatchStartRows = null;
  try {
    const updated = await patchProject(activeProjectId, { rows: restoreRows });
    document.getElementById("rowCount").textContent = updated.rows;
    updateRowProgressUI(updated);
    updateShapingBanner(updated);
    showToast(`Przywrócono rząd ${updated.rows}.`, "info", 2200);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function resetRow() {
  const confirmed = await showConfirm(
    "Czy na pewno chcesz wyzerować główny licznik rzędów?",
    { title: "Wyzeruj licznik", confirmText: "Wyzeruj", danger: true }
  );
  if (!confirmed) return;

  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;

  lastRowUndoSnapshot = { projectId: project.id, rows: project.rows };
  try {
    const updated = await patchProject(project.id, { rows: 0 });
    document.getElementById("rowCount").textContent = 0;
    updateRowProgressUI(updated);
    updateShapingBanner(updated);
    showToast("Licznik rzędów został wyzerowany.", "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function changeSecondaryRow(amount) {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;
  const nextVal = Math.max(0, (project.secondary_rows || 0) + amount);
  document.getElementById("secondaryRowCount").textContent = nextVal;
  try {
    const updated = await patchProject(project.id, { secondary_rows: nextVal });
    document.getElementById("secondaryRowCount").textContent = updated.secondary_rows;
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function resetSecondaryRow() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project || !(project.secondary_rows > 0)) return;
  if (!(await showConfirm("Wyzerować licznik pomocniczy?", { confirmText: "Wyzeruj", danger: true }))) return;
  try {
    await patchProject(project.id, { secondary_rows: 0 });
    document.getElementById("secondaryRowCount").textContent = 0;
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function changeStitch(amount) {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;

  const nextStitches = Math.max(0, (project.stitches || 0) + amount);
  document.getElementById("stitchCount").textContent = nextStitches;

  try {
    const updated = await patchProject(project.id, { stitches: nextStitches });
    document.getElementById("stitchCount").textContent = updated.stitches;
  } catch (err) {
    showToast(err.message, "error");
    await loadProjectsFromServer();
  }
}

async function resetStitch() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project || !(project.stitches > 0)) return;
  if (!(await showConfirm("Wyzerować licznik oczek?", { confirmText: "Wyzeruj", danger: true }))) return;

  try {
    await patchProject(project.id, { stitches: 0 });
    document.getElementById("stitchCount").textContent = 0;
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function changeRepeat(amount) {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;

  const nextRepeats = Math.max(0, project.repeats + amount);
  document.getElementById("repeatCount").textContent = nextRepeats;

  try {
    const updated = await patchProject(project.id, { repeats: nextRepeats });
    document.getElementById("repeatCount").textContent = updated.repeats;
  } catch (err) {
    showToast(err.message, "error");
    await loadProjectsFromServer();
  }
}

async function resetRepeat() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project || !(project.repeats > 0)) return;
  if (!(await showConfirm("Wyzerować licznik powtórzeń wzoru?", { confirmText: "Wyzeruj", danger: true }))) return;

  try {
    await patchProject(project.id, { repeats: 0 });
    document.getElementById("repeatCount").textContent = 0;
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- WIELE MINI-LICZNIKÓW W PROJEKCIE ---

async function loadSubcounters() {
  const box = document.getElementById("subcountersList");
  if (!box || !activeProjectId) return;
  try {
    const data = await apiRequest(`/api/projects/${activeProjectId}/subcounters`);
    box.innerHTML = "";
    (data.subcounters || []).forEach(sc => {
      const card = document.createElement("div");
      card.className = "sub-counter-box";

      const left = document.createElement("span");
      left.innerHTML = `${escapeHtml(sc.name)}: <strong>${sc.value}</strong>`;

      const right = document.createElement("div");
      const btnMinus = document.createElement("button");
      btnMinus.type = "button";
      btnMinus.className = "btn-small";
      btnMinus.textContent = "−";
      btnMinus.onclick = () => updateSubcounterValue(sc.id, Math.max(0, sc.value - 1));

      const btnPlus = document.createElement("button");
      btnPlus.type = "button";
      btnPlus.className = "btn-small";
      btnPlus.textContent = "+1";
      btnPlus.onclick = () => updateSubcounterValue(sc.id, sc.value + 1);

      const btnZero = document.createElement("button");
      btnZero.type = "button";
      btnZero.className = "btn-small";
      btnZero.textContent = "0";
      btnZero.onclick = async () => {
        if (sc.value > 0 && !(await showConfirm(`Wyzerować licznik „${sc.name}”?`, { confirmText: "Wyzeruj", danger: true }))) return;
        updateSubcounterValue(sc.id, 0);
      };

      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "btn-danger";
      btnDel.textContent = "✕";
      btnDel.title = "Usuń mini-licznik";
      btnDel.onclick = async () => {
        if (!(await showConfirm(`Usunąć mini-licznik „${sc.name}”?`, { confirmText: "Usuń", danger: true }))) return;
        await apiRequest(`/api/projects/${activeProjectId}/subcounters/${sc.id}`, { method: "DELETE" });
        await loadSubcounters();
      };

      right.append(btnMinus, btnPlus, btnZero, btnDel);
      card.append(left, right);
      box.appendChild(card);
    });
  } catch (err) {
    console.warn(err);
  }
}

async function addSubcounter() {
  if (!activeProjectId) return;
  const input = document.getElementById("newSubcounterName");
  const name = input.value.trim();
  if (!name) return showToast("Wpisz nazwę mini-licznika.", "warning");
  try {
    await apiRequest(`/api/projects/${activeProjectId}/subcounters`, {
      method: "POST",
      body: JSON.stringify({ name })
    });
    input.value = "";
    await loadSubcounters();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function updateSubcounterValue(subId, value) {
  if (!activeProjectId) return;
  try {
    await apiRequest(`/api/projects/${activeProjectId}/subcounters/${subId}`, {
      method: "PATCH",
      body: JSON.stringify({ value })
    });
    await loadSubcounters();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- INTERAKTYWNY SCHEMAT Z LINIJKĄ ---

function renderChartTracker(project) {
  const box = document.getElementById("chartTrackerBox");
  const removeBtn = document.getElementById("removeChartBtn");
  if (!box || !removeBtn) return;

  if (!project.chart_data) {
    box.style.display = "none";
    removeBtn.style.display = "none";
    return;
  }

  box.style.display = "block";
  removeBtn.style.display = "inline-flex";
  document.getElementById("chartImageEl").src = project.chart_data;

  const total = Math.max(1, project.chart_total_rows || 20);
  const current = Math.min(total, Math.max(1, project.chart_current_row || 1));
  document.getElementById("chartTotalRowsInput").value = total;
  document.getElementById("chartCurrentRowInput").value = current;

  const bottomPct = ((current - 0.5) / total) * 100;
  const ruler = document.getElementById("chartRulerLine");
  ruler.style.bottom = `${Math.min(98, Math.max(2, bottomPct))}%`;
  document.getElementById("chartRulerBadge").textContent = `Rząd ${current} / ${total}`;
}

async function handleChartUpload(event) {
  const file = event.target.files?.[0];
  if (!file || !activeProjectId) return;
  try {
    const compressed = await compressImageToDataUrl(file, 1024, 0.82);
    const updated = await patchProject(activeProjectId, { chart_data: compressed, chart_current_row: 1 });
    renderChartTracker(updated);
    showToast("Schemat został dodany do projektu.", "success");
  } catch {
    showToast("Nie udało się wgrać schematu.", "error");
  } finally {
    event.target.value = "";
  }
}

async function removeProjectChart() {
  if (!activeProjectId) return;
  const ok = await showConfirm("Usunąć obraz schematu z tego projektu?", {
    title: "Usuwanie schematu",
    confirmText: "Usuń schemat",
    danger: true
  });
  if (!ok) return;
  const updated = await patchProject(activeProjectId, { chart_data: "" });
  renderChartTracker(updated);
  showToast("Schemat został usunięty.", "info");
}

async function updateChartSettings() {
  if (!activeProjectId) return;
  const total = Math.max(1, parseInt(document.getElementById("chartTotalRowsInput").value, 10) || 20);
  const current = Math.min(total, Math.max(1, parseInt(document.getElementById("chartCurrentRowInput").value, 10) || 1));
  const updated = await patchProject(activeProjectId, { chart_total_rows: total, chart_current_row: current });
  renderChartTracker(updated);
}

async function stepChartRow(delta) {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project || !project.chart_data) return;
  const total = Math.max(1, project.chart_total_rows || 20);
  const next = ((project.chart_current_row - 1 + delta) % total + total) % total + 1;
  const updated = await patchProject(project.id, { chart_current_row: next });
  renderChartTracker(updated);
}

function onShapingInput() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;

  const ruleValue = document.getElementById("counterShapingRule").value;
  const formRule = document.getElementById("shapingRuleInput");
  if (formRule) formRule.value = ruleValue;
  project.shaping_rule = ruleValue;
  updateShapingBanner(project);

  clearTimeout(shapingSaveTimeout);
  shapingSaveTimeout = setTimeout(async () => {
    try {
      await patchProject(project.id, { shaping_rule: ruleValue });
    } catch {
      // ciche ponowienie
    }
  }, 400);
}

function scheduleNotesAutoSave(project, notesValue) {
  const statusEl = document.getElementById("saveStatus");
  const quickStatusEl = document.getElementById("counterQuickNotesStatus");
  if (statusEl) statusEl.textContent = "Zapisywanie...";
  if (quickStatusEl) quickStatusEl.textContent = "Zapisywanie...";

  project.notes = notesValue;

  clearTimeout(notesSaveTimeout);
  notesSaveTimeout = setTimeout(async () => {
    try {
      await patchProject(project.id, { notes: notesValue });
      if (statusEl) statusEl.textContent = "Zapisano w bazie";
      if (quickStatusEl) quickStatusEl.textContent = "Zapisano w bazie";
    } catch {
      if (statusEl) statusEl.textContent = "Błąd zapisu";
      if (quickStatusEl) quickStatusEl.textContent = "Błąd zapisu";
    }
  }, 400);
}

function onNotesInput() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;
  const notesValue = document.getElementById("projectNotes").value;
  const quickNotesEl = document.getElementById("counterQuickNotes");
  if (quickNotesEl) quickNotesEl.value = notesValue;
  scheduleNotesAutoSave(project, notesValue);
}

function onCounterQuickNotesInput() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;
  const notesValue = document.getElementById("counterQuickNotes").value;
  const mainNotesEl = document.getElementById("projectNotes");
  if (mainNotesEl) mainNotesEl.value = notesValue;
  scheduleNotesAutoSave(project, notesValue);
}

async function deleteCurrentProject() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;

  const confirmed = await showConfirm(
    `Czy na pewno chcesz trwale usunąć projekt „${project.name}” wraz z historią i listą kontrolną?`,
    { title: "Usuwanie projektu", confirmText: "Usuń projekt", danger: true }
  );
  if (!confirmed) return;

  try {
    await apiRequest(`/api/projects/${project.id}`, { method: "DELETE" });
    projects = projects.filter(p => p.id !== project.id);
    activeProjectId = projects.length > 0 ? projects[0].id : null;
    renderProjectList();
    renderActiveProject();
    if (activeProjectId) {
      await Promise.all([loadProjectHistory(), loadProjectChecklist(), loadSubcounters(), loadTimerState()]);
    }
    showToast("Projekt został usunięty.", "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- CHECKLISTA PROJEKTU ---

async function loadProjectChecklist() {
  const list = document.getElementById("projectChecklistList");
  if (!list || !activeProjectId) return;
  try {
    const data = await apiRequest(`/api/projects/${activeProjectId}/checklist`);
    list.innerHTML = "";
    if (!data.items.length) {
      list.innerHTML = "<li>Brak etapów na liście kontrolnej. Dodaj pierwszy powyżej!</li>";
      return;
    }
    data.items.forEach(item => {
      const li = document.createElement("li");
      li.className = "reminder-item";

      const label = document.createElement("label");
      label.className = "checkbox-inline";
      if (item.is_done) label.classList.add("is-done");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = Boolean(item.is_done);
      cb.onchange = async () => {
        await apiRequest(`/api/projects/${activeProjectId}/checklist/${item.id}`, {
          method: "PATCH",
          body: JSON.stringify({ is_done: cb.checked })
        });
        await loadProjectChecklist();
      };

      const span = document.createElement("span");
      span.textContent = item.title;
      label.append(cb, span);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn-danger";
      del.textContent = "🗑️";
      del.title = "Usuń etap";
      del.onclick = async () => {
        if (!(await showConfirm(`Usunąć etap „${item.title}”?`, { confirmText: "Usuń", danger: true }))) return;
        await apiRequest(`/api/projects/${activeProjectId}/checklist/${item.id}`, { method: "DELETE" });
        await loadProjectChecklist();
      };

      li.append(label, del);
      list.appendChild(li);
    });
  } catch (err) {
    console.warn(err);
  }
}

async function addChecklistItem() {
  if (!activeProjectId) return showToast("Najpierw wybierz projekt.", "warning");
  const input = document.getElementById("checklistNewTitle");
  const title = input.value.trim();
  if (!title) return showToast("Wpisz nazwę etapu.", "warning");
  try {
    await apiRequest(`/api/projects/${activeProjectId}/checklist`, {
      method: "POST",
      body: JSON.stringify({ title })
    });
    input.value = "";
    await loadProjectChecklist();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- BLOKADA WYGASZANIA EKRANU (WAKE LOCK) ---

async function toggleWakeLock() {
  const btn = document.getElementById("wakeLockBtn");
  if (!("wakeLock" in navigator)) {
    showToast("Twoja przeglądarka nie obsługuje blokady wygaszania ekranu.", "warning");
    return;
  }

  if (wakeLockSentinel) {
    await releaseWakeLock();
    return;
  }

  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    btn.classList.add("active");
    btn.textContent = "☀️ Ekran zablokowany";
    wakeLockSentinel.addEventListener("release", () => {
      wakeLockSentinel = null;
      btn.classList.remove("active");
      btn.textContent = "☀️ Ekran";
    });
  } catch {
    showToast("Nie udało się zablokować wygaszania ekranu.", "error");
  }
}

async function releaseWakeLock() {
  if (wakeLockSentinel) {
    await wakeLockSentinel.release();
    wakeLockSentinel = null;
  }
  const btn = document.getElementById("wakeLockBtn");
  if (btn) {
    btn.classList.remove("active");
    btn.textContent = "☀️ Ekran";
  }
}

// --- NARZĘDZIA I KALKULATORY ---

function calculateGauge() {
  const swWidth = parseFloat(document.getElementById("swatchWidthCm").value);
  const swStitches = parseFloat(document.getElementById("swatchStitches").value);
  const swHeight = parseFloat(document.getElementById("swatchHeightCm").value);
  const swRows = parseFloat(document.getElementById("swatchRows").value);

  const targetWidth = parseFloat(document.getElementById("targetWidthCm").value);
  const targetHeight = parseFloat(document.getElementById("targetHeightCm").value);

  if (!swWidth || !swStitches || !targetWidth) {
    showToast("Wypełnij przynajmniej dane dotyczące szerokości próbki, liczby oczek i docelowej szerokości.", "warning");
    return;
  }

  const stitchesPerCm = swStitches / swWidth;
  const neededStitches = Math.round(stitchesPerCm * targetWidth);

  let neededRows = 0;
  if (swHeight && swRows && targetHeight) {
    const rowsPerCm = swRows / swHeight;
    neededRows = Math.round(rowsPerCm * targetHeight);
  }

  document.getElementById("resStitches").textContent = neededStitches;
  document.getElementById("resRows").textContent = neededRows > 0 ? neededRows : "brak danych";
  document.getElementById("calcResult").style.display = "block";

  lastGaugeSummary = `Próbka (${targetWidth}x${targetHeight || "?"} cm): nabierz ${neededStitches} o.` +
    (neededRows > 0 ? `, przerób ${neededRows} rz.` : "");
}

async function appendGaugeToNotes() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) {
    showToast("Najpierw wybierz lub utwórz projekt w zakładce Projekty.", "warning");
    return;
  }
  if (!lastGaugeSummary) return;

  const updatedNotes = project.notes
    ? `${project.notes}\n${lastGaugeSummary}`
    : lastGaugeSummary;

  try {
    const updated = await patchProject(project.id, { notes: updatedNotes });
    document.getElementById("projectNotes").value = updated.notes;
    const quickNotes = document.getElementById("counterQuickNotes");
    if (quickNotes) quickNotes.value = updated.notes;
    showToast("Dopisano wynik próbki do notatek projektu!", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function calculateShaping() {
  const current = parseInt(document.getElementById("currentStitchesInput").value, 10);
  const target = parseInt(document.getElementById("targetStitchesInput").value, 10);
  const resultBox = document.getElementById("shapingResult");

  if (!current || !target || current < 2 || target < 1) {
    showToast("Podaj poprawne liczby oczek (większe od zera).", "warning");
    return;
  }

  const diff = target - current;
  if (diff === 0) {
    resultBox.innerHTML = "<p>Liczba oczek jest już docelowa – nie musisz nic dodawać ani odejmować.</p>";
    resultBox.style.display = "block";
    return;
  }

  const changes = Math.abs(diff);
  const isIncrease = diff > 0;

  if (!isIncrease && changes > Math.floor(current / 2)) {
    resultBox.innerHTML = `<p>Nie można odjąć ${changes} oczek w jednym rzędzie z ${current} oczek (maksymalnie ${Math.floor(current / 2)}).</p>`;
    resultBox.style.display = "block";
    return;
  }

  const step = current / changes;
  const everyN = Math.floor(step);
  const actionLabel = isIncrease ? "dodaj 1 oczko (narzut / M1)" : "przerób 2 oczka razem (k2tog)";

  resultBox.innerHTML = `
    <p><strong>${isIncrease ? "Dodawanie" : "Odejmowanie"}:</strong> ${changes} oczek (${current} → ${target} o.)</p>
    <p>Wskazówka: <strong>${actionLabel}</strong> średnio co <strong>${everyN}</strong> oczek.</p>
  `;
  resultBox.style.display = "block";
}

function calculateYarnNeeded() {
  const swatchArea = parseFloat(document.getElementById("swatchAreaCm2").value);
  const swatchWeight = parseFloat(document.getElementById("swatchWeightG").value);
  const projectArea = parseFloat(document.getElementById("projectAreaCm2").value);
  const skeinWeight = parseFloat(document.getElementById("skeinWeightG").value);
  const skeinLength = parseFloat(document.getElementById("skeinLengthM").value);
  const bufferPct = parseFloat(document.getElementById("yarnBufferPct").value) || 0;
  const resultBox = document.getElementById("yarnCalcResult");

  if (!swatchArea || !swatchWeight || !projectArea || !skeinWeight) {
    showToast("Wypełnij powierzchnię próbki, wagę próbki, powierzchnię robótki i wagę motka.", "warning");
    return;
  }

  const rawGrams = (projectArea / swatchArea) * swatchWeight;
  const totalGrams = Math.ceil(rawGrams * (1 + bufferPct / 100));
  const skeinsNeeded = Math.ceil(totalGrams / skeinWeight);
  const totalMeters = skeinLength ? Math.round((totalGrams / skeinWeight) * skeinLength) : null;

  resultBox.innerHTML = `
    <p>Szacowana waga włóczki (z zapasem ${bufferPct}%): <strong>${totalGrams} g</strong></p>
    <p>Liczba motków po ${skeinWeight} g: <strong>${skeinsNeeded} szt.</strong></p>
    ${totalMeters ? `<p>Szacowany metraż całkowity: <strong>~${totalMeters} m</strong></p>` : ""}
  `;
  resultBox.style.display = "block";
}

function calculateLengthProgress() {
  const swHeight = parseFloat(document.getElementById("lenSwatchHeightCm").value);
  const swRows = parseFloat(document.getElementById("lenSwatchRows").value);
  const targetCm = parseFloat(document.getElementById("lenTargetCm").value);
  const manualRows = parseInt(document.getElementById("lenCurrentRows").value, 10);
  const resultBox = document.getElementById("lengthProgressResult");

  if (!swHeight || !swRows || !targetCm) {
    showToast("Podaj wysokość próbki, liczbę rzędów w próbce oraz docelową długość elementu.", "warning");
    return;
  }

  const rowsPerCm = swRows / swHeight;
  const neededRows = Math.round(rowsPerCm * targetCm);
  lastLengthCalcRows = neededRows;
  const activeProject = projects.find(p => p.id === activeProjectId);
  const currentRows = !isNaN(manualRows) ? manualRows : (activeProject ? activeProject.rows : 0);
  const currentCm = (currentRows / rowsPerCm).toFixed(1);
  const remainingRows = Math.max(0, neededRows - currentRows);

  resultBox.innerHTML = `
    <p>Gęstość pionowa: <strong>${rowsPerCm.toFixed(2)} rzędów / cm</strong></p>
    <p>Dla <strong>${targetCm} cm</strong> potrzebujesz: <strong>${neededRows} rzędów</strong></p>
    <p>Przy <strong>${currentRows} rz.</strong> masz ok. <strong>${currentCm} cm</strong> (pozostało: <strong>${remainingRows} rz.</strong>).</p>
    <button type="button" onclick="applyGoalRowsToProject()" class="btn-outline-action">
      🎯 Ustaw ${neededRows} rz. jako cel aktywnego projektu
    </button>
  `;
  resultBox.style.display = "block";
}

async function applyGoalRowsToProject() {
  if (!activeProjectId || !lastLengthCalcRows) {
    showToast("Najpierw wybierz projekt.", "warning");
    return;
  }
  try {
    const updated = await patchProject(activeProjectId, { target_rows: lastLengthCalcRows });
    renderActiveProject();
    showToast(`Ustawiono cel: ${updated.target_rows} rzędów.`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- GENERATOR PASKÓW (Z WAGAMI, SYMETRIĄ I SCHEMATEM ROZKŁADU) ---

function getReadableTextColor(hexColor) {
  const clean = (hexColor || "").replace("#", "");
  if (clean.length !== 6) return "#1e293b";
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.55 ? "#1e293b" : "#ffffff";
}

function pickWeightedColorIndex(colors, excludeIndex) {
  const candidates = colors
    .map((c, idx) => ({ idx, weight: Math.max(1, c.weight || 1) }))
    .filter(item => colors.length <= 1 || item.idx !== excludeIndex);

  const totalWeight = candidates.reduce((acc, item) => acc + item.weight, 0);
  let r = Math.random() * totalWeight;
  for (const item of candidates) {
    r -= item.weight;
    if (r <= 0) return item.idx;
  }
  return candidates[candidates.length - 1].idx;
}

function generateStripes() {
  const totalRows = Math.max(4, Math.min(500, parseInt(document.getElementById("stripeTotalRows").value, 10) || 48));
  const mode = document.getElementById("stripeMode").value;
  const widthsRaw = document.getElementById("stripeWidths").value;
  const widths = widthsRaw
    .split(",")
    .map(x => parseInt(x.trim(), 10))
    .filter(n => !isNaN(n) && n > 0);

  if (!widths.length) {
    showToast("Podaj przynajmniej jedną szerokość pasa w rzędach (np. 2, 4, 6).", "warning");
    return;
  }

  const colors = [
    {
      label: "Kolor A",
      hex: document.getElementById("stripeColor1").value,
      weight: Math.max(1, parseInt(document.getElementById("stripeWeight1")?.value, 10) || 1)
    },
    {
      label: "Kolor B",
      hex: document.getElementById("stripeColor2").value,
      weight: Math.max(1, parseInt(document.getElementById("stripeWeight2")?.value, 10) || 1)
    }
  ];
  if (document.getElementById("stripeUseColor3").checked) {
    colors.push({
      label: "Kolor C",
      hex: document.getElementById("stripeColor3").value,
      weight: Math.max(1, parseInt(document.getElementById("stripeWeight3")?.value, 10) || 1)
    });
  }

  const rawBands = [];

  if (mode === "symmetric") {
    // Budujemy symetryczną sekwencję lustrzaną (np. A, B, C, B, A) powtarzaną na cały odcinek
    const forwardColorIndices = colors.map((_, i) => i);
    const mirrorColorIndices = colors.length > 2
      ? [...forwardColorIndices, ...forwardColorIndices.slice(1, -1).reverse()]
      : forwardColorIndices;

    const mirrorWidths = widths.length > 2
      ? [...widths, ...widths.slice(1, -1).reverse()]
      : widths;

    let remaining = totalRows;
    let step = 0;
    while (remaining > 0) {
      const cIdx = mirrorColorIndices[step % mirrorColorIndices.length];
      const w = mirrorWidths[step % mirrorWidths.length];
      const rowsCount = Math.min(remaining, w);
      rawBands.push({ color: colors[cIdx], rows: rowsCount });
      remaining -= rowsCount;
      step++;
    }
  } else {
    let remaining = totalRows;
    let stepIndex = 0;
    let prevColorIdx = -1;

    while (remaining > 0) {
      let colorIdx = stepIndex % colors.length;
      if (mode === "weighted" && colors.length > 1) {
        colorIdx = pickWeightedColorIndex(colors, prevColorIdx);
      } else if (mode === "random" && colors.length > 1) {
        do {
          colorIdx = Math.floor(Math.random() * colors.length);
        } while (colorIdx === prevColorIdx);
      }
      prevColorIdx = colorIdx;

      const chosenWidth = (mode === "random" || mode === "weighted")
        ? widths[Math.floor(Math.random() * widths.length)]
        : widths[stepIndex % widths.length];

      const rowsCount = Math.min(remaining, chosenWidth);
      rawBands.push({ color: colors[colorIdx], rows: rowsCount });
      remaining -= rowsCount;
      stepIndex++;
    }
  }

  let currentRowStart = 1;
  const stripes = rawBands.map(b => {
    const rowEnd = currentRowStart + b.rows - 1;
    const entry = {
      color: b.color,
      rows: b.rows,
      fromRow: currentRowStart,
      toRow: rowEnd
    };
    currentRowStart = rowEnd + 1;
    return entry;
  });

  const preview = document.getElementById("stripePreviewBar");
  const legend = document.getElementById("stripeLegend");
  const diagram = document.getElementById("stripeGridDiagram");
  preview.innerHTML = "";
  legend.innerHTML = "";
  diagram.innerHTML = "";

  const totalsByColor = new Map();
  stripes.forEach(st => {
    const prev = totalsByColor.get(st.color.label) || { ...st.color, rows: 0 };
    prev.rows += st.rows;
    totalsByColor.set(st.color.label, prev);
  });

  totalsByColor.forEach(item => {
    const legItem = document.createElement("span");
    legItem.className = "stripe-legend-item";
    const sw = document.createElement("span");
    sw.className = "stripe-swatch";
    sw.style.background = item.hex;
    const pct = Math.round((item.rows / totalRows) * 100);
    const lbl = document.createElement("span");
    lbl.textContent = `${item.label}: ${item.rows} rz. (${pct}%)`;
    legItem.append(sw, lbl);
    legend.appendChild(legItem);
  });

  stripes.forEach(st => {
    const seg = document.createElement("div");
    seg.style.flex = String(st.rows);
    seg.style.background = st.color.hex;
    seg.title = `${st.color.label}: ${st.rows} rz. (rz. ${st.fromRow}–${st.toRow})`;
    preview.appendChild(seg);

    const band = document.createElement("div");
    band.className = "stripe-band-row";
    band.style.background = st.color.hex;
    band.style.color = getReadableTextColor(st.color.hex);

    const left = document.createElement("span");
    left.textContent = `${st.color.label} · ${st.rows} rz.`;

    const right = document.createElement("span");
    right.className = "stripe-band-rows";
    right.textContent = st.fromRow === st.toRow ? `rz. ${st.fromRow}` : `rz. ${st.fromRow}–${st.toRow}`;

    band.append(left, right);
    diagram.prepend(band);
  });

  const seqText = stripes.map(s => `${s.color.label} (${s.rows} rz.)`).join(" → ");
  lastStripesSummary = `Układ pasków (${totalRows} rz.): ${seqText}`;
  document.getElementById("stripeSummaryText").textContent = lastStripesSummary;
  document.getElementById("stripeResultBox").style.display = "block";
}

async function appendStripesToNotes() {
  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return showToast("Najpierw wybierz projekt.", "warning");
  if (!lastStripesSummary) return;

  const updatedNotes = project.notes ? `${project.notes}\n${lastStripesSummary}` : lastStripesSummary;
  const updated = await patchProject(project.id, { notes: updatedNotes });
  document.getElementById("projectNotes").value = updated.notes;
  const quickNotes = document.getElementById("counterQuickNotes");
  if (quickNotes) quickNotes.value = updated.notes;
  showToast("Schemat pasków dopisano do notatek projektu.", "success");
}

// --- ZDJĘCIE I KATALOG WŁÓCZEK (STASH) ---

function compressImageToDataUrl(file, maxSize = 640, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleYarnPhotoChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    pendingYarnPhotoData = await compressImageToDataUrl(file);
    document.getElementById("yarnPhotoPreview").src = pendingYarnPhotoData;
    document.getElementById("yarnPhotoPreviewWrap").style.display = "flex";
  } catch {
    showToast("Nie udało się przetworzyć wybranego zdjęcia.", "error");
    clearYarnPhoto();
  }
}

function clearYarnPhoto() {
  pendingYarnPhotoData = "";
  const input = document.getElementById("yarnPhotoInput");
  if (input) input.value = "";
  document.getElementById("yarnPhotoPreview").src = "";
  document.getElementById("yarnPhotoPreviewWrap").style.display = "none";
}

async function loadYarnsFromServer() {
  const data = await apiRequest("/api/yarns");
  yarns = data.yarns || [];
  populateProjectYarnSelect();
  renderYarnList();
  const activeProj = projects.find(p => p.id === activeProjectId);
  if (activeProj) updateCounterYarnAlert(activeProj);
}

function editYarn(yarnId) {
  const yarn = yarns.find(y => y.id === yarnId);
  if (!yarn) return;
  editingYarnId = yarn.id;
  document.getElementById("yarnName").value = yarn.name || "";
  document.getElementById("yarnColorLot").value = yarn.color_lot || "";
  document.getElementById("yarnWeightG").value = yarn.weight_g ?? 50;
  document.getElementById("yarnLengthM").value = yarn.length_m ?? 105;
  document.getElementById("yarnSkeins").value = yarn.skeins ?? 1;
  document.getElementById("yarnStatus").value = yarn.status || "in_stash";
  document.getElementById("yarnBrand").value = yarn.brand || "";
  document.getElementById("yarnFiber").value = yarn.fiber || "";
  document.getElementById("yarnNeedleSize").value = yarn.needle_size || "";
  document.getElementById("yarnCare").value = yarn.care || "";
  document.getElementById("yarnPrice").value = yarn.purchase_price || "";
  document.getElementById("yarnLocation").value = yarn.stash_location || "";
  document.getElementById("yarnNotes").value = yarn.notes || "";

  pendingYarnPhotoData = yarn.photo_data || "";
  if (pendingYarnPhotoData) {
    document.getElementById("yarnPhotoPreview").src = pendingYarnPhotoData;
    document.getElementById("yarnPhotoPreviewWrap").style.display = "flex";
  } else {
    clearYarnPhoto();
  }

  document.getElementById("yarnFormHeading").textContent = `Edytujesz włóczkę: ${yarn.name}`;
  document.getElementById("yarnSubmitBtn").textContent = "Zapisz zmiany";
  document.getElementById("cancelYarnEditBtn").hidden = false;
  document.getElementById("yarnFormCard").open = true;
  document.getElementById("yarnFormCard").scrollIntoView({ behavior: "smooth" });
}

function resetYarnForm() {
  editingYarnId = null;
  document.getElementById("yarnName").value = "";
  document.getElementById("yarnColorLot").value = "";
  document.getElementById("yarnWeightG").value = 50;
  document.getElementById("yarnLengthM").value = 105;
  document.getElementById("yarnSkeins").value = 1;
  document.getElementById("yarnStatus").value = "in_stash";
  ["yarnNotes", "yarnBrand", "yarnFiber", "yarnNeedleSize", "yarnCare", "yarnPrice", "yarnLocation"].forEach(
    id => (document.getElementById(id).value = "")
  );
  clearYarnPhoto();
  document.getElementById("yarnFormHeading").textContent = "Dodaj Włóczkę do Zapasów (Stash)";
  document.getElementById("yarnSubmitBtn").textContent = "Zapisz włóczkę";
  document.getElementById("cancelYarnEditBtn").hidden = true;
}

async function saveYarnForm() {
  const name = document.getElementById("yarnName").value.trim();
  if (!name) {
    showToast("Podaj nazwę włóczki!", "warning");
    return;
  }

  const payload = {
    name,
    color_lot: document.getElementById("yarnColorLot").value.trim(),
    weight_g: parseInt(document.getElementById("yarnWeightG").value, 10) || 0,
    length_m: parseInt(document.getElementById("yarnLengthM").value, 10) || 0,
    skeins: parseFloat(document.getElementById("yarnSkeins").value) || 0,
    status: document.getElementById("yarnStatus").value,
    notes: document.getElementById("yarnNotes").value.trim(),
    photo_data: pendingYarnPhotoData,
    brand: document.getElementById("yarnBrand").value.trim(),
    fiber: document.getElementById("yarnFiber").value.trim(),
    needle_size: document.getElementById("yarnNeedleSize").value.trim(),
    care: document.getElementById("yarnCare").value.trim(),
    purchase_price: parseFloat(document.getElementById("yarnPrice").value) || 0,
    stash_location: document.getElementById("yarnLocation").value.trim()
  };

  try {
    const wasEditing = Boolean(editingYarnId);
    if (editingYarnId) {
      const data = await apiRequest(`/api/yarns/${editingYarnId}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      const idx = yarns.findIndex(y => y.id === editingYarnId);
      if (idx !== -1) yarns[idx] = data.yarn;
    } else {
      const data = await apiRequest("/api/yarns", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      yarns.unshift(data.yarn);
    }
    resetYarnForm();
    populateProjectYarnSelect();
    renderYarnList();
    showToast(wasEditing ? "Zaktualizowano włóczkę." : "Dodano włóczkę do zapasów.", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function changeYarnSkeins(yarnId, delta) {
  const yarn = yarns.find(y => y.id === yarnId);
  if (!yarn) return;
  const nextSkeins = Math.max(0, Math.round((yarn.skeins + delta) * 10) / 10);

  try {
    const data = await apiRequest(`/api/yarns/${yarnId}`, {
      method: "PATCH",
      body: JSON.stringify({ skeins: nextSkeins })
    });
    const idx = yarns.findIndex(y => y.id === yarnId);
    if (idx !== -1) yarns[idx] = data.yarn;
    populateProjectYarnSelect();
    renderYarnList();
    const activeProj = projects.find(p => p.id === activeProjectId);
    if (activeProj) updateCounterYarnAlert(activeProj);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Szybkie: „Zużyłem cały motek” (odejmuje 1 motek; gdy 0 -> status 'used_up')
async function consumeOneYarnSkein(yarnId) {
  const yarn = yarns.find(y => y.id === yarnId);
  if (!yarn) return;
  const current = Number(yarn.skeins) || 0;
  if (current <= 0) {
    showToast("Ta włóczka ma już 0 motków.", "info");
    return;
  }

  const nextSkeins = Math.max(0, Math.round((current - 1) * 10) / 10);
  const nextStatus = nextSkeins === 0 ? "used_up" : yarn.status;

  try {
    const data = await apiRequest(`/api/yarns/${yarnId}`, {
      method: "PATCH",
      body: JSON.stringify({ skeins: nextSkeins, status: nextStatus })
    });
    const idx = yarns.findIndex(y => y.id === yarnId);
    if (idx !== -1) yarns[idx] = data.yarn;
    populateProjectYarnSelect();
    renderYarnList();
    const activeProj = projects.find(p => p.id === activeProjectId);
    if (activeProj) updateCounterYarnAlert(activeProj);
    showToast(
      nextSkeins === 0
        ? `Zużyto ostatni motek „${yarn.name}” (oznaczono jako zużytą).`
        : `Odjęto 1 motek „${yarn.name}” (pozostało: ${nextSkeins}).`,
      "success"
    );
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Szybkie: „Odłóż resztę” (ustawia resztę np. 0.5 motka i przenosi status z powrotem do 'in_stash')
async function stashYarnLeftover(yarnId) {
  const yarn = yarns.find(y => y.id === yarnId);
  if (!yarn) return;

  const current = Number(yarn.skeins) || 0;
  const leftoverVal = current > 1 ? Math.round((current - 0.5) * 10) / 10 : 0.5;
  const stamp = new Date().toLocaleDateString("pl-PL");
  const leftoverTag = `Resztka odłożona (${stamp})`;
  const nextNotes = yarn.notes
    ? (yarn.notes.includes("Resztka odłożona") ? yarn.notes : `${yarn.notes} · ${leftoverTag}`)
    : leftoverTag;

  try {
    const data = await apiRequest(`/api/yarns/${yarnId}`, {
      method: "PATCH",
      body: JSON.stringify({
        skeins: leftoverVal,
        status: "in_stash",
        notes: nextNotes
      })
    });
    const idx = yarns.findIndex(y => y.id === yarnId);
    if (idx !== -1) yarns[idx] = data.yarn;
    populateProjectYarnSelect();
    renderYarnList();
    const activeProj = projects.find(p => p.id === activeProjectId);
    if (activeProj) updateCounterYarnAlert(activeProj);
    showToast(`Odłożono resztkę „${yarn.name}” (${leftoverVal} mot.) do zapasów.`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteYarn(yarnId) {
  const yarn = yarns.find(y => y.id === yarnId);
  const confirmed = await showConfirm(
    `Usunąć włóczkę${yarn ? ` „${yarn.name}”` : ""} z zapasów?`,
    { title: "Usuwanie włóczki", confirmText: "Usuń", danger: true }
  );
  if (!confirmed) return;

  try {
    await apiRequest(`/api/yarns/${yarnId}`, { method: "DELETE" });
    yarns = yarns.filter(y => y.id !== yarnId);
    if (editingYarnId === yarnId) resetYarnForm();
    populateProjectYarnSelect();
    renderYarnList();
    showToast("Włóczka została usunięta z zapasów.", "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function renderYarnList() {
  const list = document.getElementById("yarnList");
  const summaryEl = document.getElementById("stashSummary");
  list.innerHTML = "";

  const totalSkeins = yarns.reduce((sum, y) => sum + (Number(y.skeins) || 0), 0);
  const totalMeters = yarns.reduce((sum, y) => sum + (Number(y.skeins) || 0) * (Number(y.length_m) || 0), 0);
  summaryEl.textContent = `${totalSkeins} motków · ${Math.round(totalMeters)} m`;

  if (yarns.length === 0) {
    list.innerHTML = '<li style="color: var(--text-muted);">Brak zapisanych włóczek. Dodaj pierwszy motek powyżej!</li>';
    return;
  }
  const query = (document.getElementById("yarnSearch")?.value || "").toLowerCase().trim();
  const minMeters = parseFloat(document.getElementById("yarnMinMetersFilter")?.value) || 0;

  const visibleYarns = yarns.filter(y => {
    const availableMeters = (Number(y.skeins) || 0) * (Number(y.length_m) || 0);
    const matchesText = [y.name, y.color_lot, y.brand, y.fiber, y.stash_location].join(" ").toLowerCase().includes(query);
    return matchesText && availableMeters >= minMeters;
  });

  if (!visibleYarns.length) {
    list.innerHTML = "<li>Brak włóczek spełniających podane kryteria.</li>";
    return;
  }

  visibleYarns.forEach(yarn => {
    const li = document.createElement("li");
    li.className = "yarn-item";

    const availableMeters = Math.round((Number(yarn.skeins) || 0) * (Number(yarn.length_m) || 0));
    const statusText = YARN_STATUS_LABELS[yarn.status] || "W zapasie";
    const metaParts = [
      yarn.color_lot ? `Kolor/partia: ${yarn.color_lot}` : null,
      yarn.brand ? `Marka: ${yarn.brand}` : null,
      yarn.fiber ? `Skład: ${yarn.fiber}` : null,
      yarn.needle_size ? `Druty: ${yarn.needle_size}` : null,
      yarn.stash_location ? `Miejsce: ${yarn.stash_location}` : null,
      yarn.care ? `Pielęgnacja: ${yarn.care}` : null,
      Number(yarn.purchase_price) > 0 ? `Cena: ${Number(yarn.purchase_price).toFixed(2)} zł` : null,
      `${yarn.weight_g} g / ${yarn.length_m} m (łącznie ~${availableMeters} m)`,
      `Status: ${statusText}`
    ].filter(Boolean);

    const hasValidPhoto = yarn.photo_data && yarn.photo_data.startsWith("data:image/");

    li.innerHTML = `
      <div class="yarn-item-top">
        <div class="yarn-item-main">
          ${hasValidPhoto ? `<img class="yarn-thumb" src="${yarn.photo_data}" alt="${escapeHtml(yarn.name)}" title="Kliknij, aby powiększyć">` : ""}
          <div>
            <strong>${escapeHtml(yarn.name)}</strong>
            <div class="yarn-meta">${escapeHtml(metaParts.join(" · "))}</div>
            ${yarn.notes ? `<div class="yarn-meta">${escapeHtml(yarn.notes)}</div>` : ""}
          </div>
        </div>
        <div class="project-header-actions">
          <button type="button" class="btn-small" title="Edytuj włóczkę" onclick="editYarn(${yarn.id})">✏️</button>
          <button type="button" class="btn-danger" title="Usuń włóczkę" onclick="deleteYarn(${yarn.id})">🗑️</button>
        </div>
      </div>
      <div class="yarn-controls">
        <label class="yarn-status-control">Status: <select class="form-select" onchange="changeYarnStatus(${yarn.id}, this.value)"><option value="in_stash" ${yarn.status === "in_stash" ? "selected" : ""}>W zapasie</option><option value="in_use" ${yarn.status === "in_use" ? "selected" : ""}>W robótce</option><option value="used_up" ${yarn.status === "used_up" ? "selected" : ""}>Zużyta</option></select></label>
        <span>Motki w zapasie: <strong>${yarn.skeins}</strong></span>
        <div>
          <button type="button" class="btn-small" onclick="changeYarnSkeins(${yarn.id}, -0.5)">-0.5</button>
          <button type="button" class="btn-small" onclick="changeYarnSkeins(${yarn.id}, 0.5)">+0.5</button>
          <button type="button" class="btn-small" onclick="changeYarnSkeins(${yarn.id}, 1)">+1</button>
        </div>
      </div>
      <div class="yarn-quick-actions">
        <button type="button" class="btn-small" onclick="consumeOneYarnSkein(${yarn.id})">🧶 Zużyłem cały motek (−1)</button>
        <button type="button" class="btn-small" onclick="stashYarnLeftover(${yarn.id})">📦 Odłóż resztę do zapasu</button>
      </div>
    `;

    if (hasValidPhoto) {
      const thumb = li.querySelector(".yarn-thumb");
      if (thumb) {
        thumb.onclick = () => openLightbox(yarn.photo_data, `${yarn.name}${yarn.color_lot ? ` (${yarn.color_lot})` : ""}`);
      }
    }

    list.appendChild(li);
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// === STOPER, HISTORIA, STATYSTYKI, PRZYPOMNIENIA ===
let timerSeconds = 0;
let timerRunning = false;
let timerTick = null;

function formatDuration(total) {
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}
function drawTimer() {
  const el = document.getElementById("knittingTimerDisplay");
  if (el) el.textContent = formatDuration(timerSeconds);
  const project = projects.find(p => p.id === activeProjectId);
  if (project) updateRowProgressUI(project);
}
async function loadTimerState() {
  if (timerTick) {
    clearInterval(timerTick);
    timerTick = null;
  }
  timerRunning = false;
  timerSeconds = 0;
  if (!activeProjectId) {
    drawTimer();
    return;
  }
  try {
    const d = await apiRequest(`/api/timer?project_id=${activeProjectId}`);
    timerSeconds = d.seconds || 0;
    timerRunning = !!d.running;
    drawTimer();
    if (timerRunning) startTimerTicker();
    const status = document.getElementById("timerStatus");
    if (status) status.textContent = timerRunning ? "Stoper działa dla tego projektu." : "Czas zapisuje się osobno dla tego projektu.";
  } catch (e) {
    console.warn(e);
  }
}
function startTimerTicker() {
  if (timerTick) clearInterval(timerTick);
  timerTick = setInterval(() => {
    if (timerRunning) {
      timerSeconds++;
      drawTimer();
    }
  }, 1000);
}
async function startKnittingTimer() {
  if (!activeProjectId) return showToast("Wybierz projekt.", "warning");
  if (timerRunning) return;
  try {
    const d = await apiRequest("/api/timer", { method: "POST", body: JSON.stringify({ action: "start", project_id: activeProjectId }) });
    timerSeconds = d.seconds || timerSeconds;
    timerRunning = true;
    startTimerTicker();
    document.getElementById("timerStatus").textContent = "🧶 Stoper działa dla wybranego projektu.";
  } catch (e) {
    showToast(e.message, "error");
  }
}
async function pauseKnittingTimer() {
  if (!activeProjectId || !timerRunning) return;
  try {
    const d = await apiRequest("/api/timer", { method: "POST", body: JSON.stringify({ action: "pause", project_id: activeProjectId }) });
    timerSeconds = d.seconds || 0;
    timerRunning = false;
    drawTimer();
    if (timerTick) clearInterval(timerTick);
    timerTick = null;
    document.getElementById("timerStatus").textContent = "Sesja tego projektu została zapisana.";
    loadStats();
  } catch (e) {
    showToast(e.message, "error");
  }
}
async function resetKnittingTimer() {
  if (!activeProjectId) return;
  const ok = await showConfirm("Czy na pewno wyzerować czas stopera dla tego projektu?", {
    title: "Zerowanie czasu",
    confirmText: "Wyzeruj",
    danger: true
  });
  if (!ok) return;
  if (timerRunning) await pauseKnittingTimer();
  try {
    const d = await apiRequest("/api/timer", { method: "POST", body: JSON.stringify({ action: "reset", project_id: activeProjectId }) });
    timerSeconds = d.seconds || 0;
    drawTimer();
    showToast("Czas stopera został wyzerowany.", "info");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function loadProjectHistory() {
  const list = document.getElementById("projectHistoryList");
  if (!list || !activeProjectId) return;
  try {
    const d = await apiRequest(`/api/projects/${activeProjectId}/history`);
    list.innerHTML = "";
    if (!d.history.length) {
      list.innerHTML = "<li>Brak wpisów — dodaj pierwszy postęp.</li>";
      return;
    }
    d.history.forEach(entry => {
      const li = document.createElement("li");
      const date = new Date(entry.created_at.replace(" ", "T") + "Z");
      li.textContent = `${date.toLocaleString("pl-PL")} · rząd ${entry.rows}${entry.note ? " · " + entry.note : ""}`;
      list.appendChild(li);
    });
  } catch (e) {
    console.warn(e);
  }
}
async function saveProgressNote() {
  if (!activeProjectId) return showToast("Najpierw wybierz projekt.", "warning");
  const input = document.getElementById("historyNote");
  const note = input.value.trim();
  if (!note) return showToast("Wpisz krótką notatkę.", "warning");
  try {
    await apiRequest(`/api/projects/${activeProjectId}/history`, { method: "POST", body: JSON.stringify({ note }) });
    input.value = "";
    await loadProjectHistory();
    showToast("Zapisano wpis w dzienniku.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function loadStats() {
  const summary = document.getElementById("statsSummary");
  if (!summary) return;
  try {
    const d = await apiRequest("/api/stats");
    const p = d.projects || {},
      y = d.stash || {};
    const hours = Math.floor((d.seconds || 0) / 3600);
    summary.innerHTML = "";
    [
      ["Projekty", p.total || 0],
      ["Ukończone", p.completed || 0],
      ["Przerobione rzędy", p.rows || 0],
      ["Motki w zapasie", Number(y.skeins || 0).toFixed(1)],
      ["Metry włóczki", Math.round(y.meters || 0)],
      ["Czas dziergania", `${hours} h`]
    ].forEach(([label, value]) => {
      const box = document.createElement("div");
      box.className = "stat-tile";
      const strong = document.createElement("strong");
      strong.textContent = value;
      const small = document.createElement("span");
      small.textContent = label;
      box.append(strong, small);
      summary.appendChild(box);
    });
    const chart = document.getElementById("monthlyStats");
    chart.innerHTML = "";
    const max = Math.max(1, ...(d.monthly || []).map(x => x.seconds || 0));
    (d.monthly || []).forEach(item => {
      const row = document.createElement("div");
      row.className = "bar-row";
      const label = document.createElement("span");
      label.textContent = item.month;
      const track = document.createElement("div");
      track.className = "bar-track";
      const bar = document.createElement("div");
      bar.className = "bar-fill";
      bar.style.width = `${Math.max(2, (100 * item.seconds) / max)}%`;
      track.appendChild(bar);
      const val = document.createElement("small");
      val.textContent = `${(item.seconds / 3600).toFixed(1)} h`;
      row.append(label, track, val);
      chart.appendChild(row);
    });
    if (!d.monthly?.length) chart.textContent = "Zapisane sesje pojawią się tutaj po użyciu stopera.";
  } catch (e) {
    summary.textContent = e.message;
  }
}

function updateNotificationButtonUI() {
  const btn = document.getElementById("notifPermBtn");
  if (!btn) return;
  if (!("Notification" in window)) {
    btn.style.display = "none";
    return;
  }
  if (Notification.permission === "granted") {
    btn.classList.add("active");
    btn.textContent = "🔔 Powiadomienia włączone";
  } else if (Notification.permission === "denied") {
    btn.textContent = "🔕 Zablokowane w przeglądarce";
  } else {
    btn.textContent = "🔔 Włącz powiadomienia";
  }
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    showToast("Twoja przeglądarka nie obsługuje powiadomień.", "warning");
    return;
  }
  const result = await Notification.requestPermission();
  updateNotificationButtonUI();
  if (result === "granted") {
    new Notification("🧶 Asystent Dziergania", {
      body: "Powiadomienia o terminach z kalendarza zostały włączone!"
    });
  }
}

function checkDueRemindersForNotification(reminders) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  reminders.forEach(r => {
    if (r.is_done || notifiedReminderIds.has(r.id)) return;
    const dueTime = new Date(r.due_at).getTime();
    if (!isNaN(dueTime) && dueTime <= now + 15 * 60 * 1000) {
      notifiedReminderIds.add(r.id);
      new Notification("🗓️ Przypomnienie dziewiarskie", {
        body: `${r.title} (${new Date(r.due_at).toLocaleString("pl-PL")})`
      });
    }
  });
}

async function loadReminders() {
  const list = document.getElementById("reminderList");
  if (!list) return;
  try {
    const d = await apiRequest("/api/reminders");
    checkDueRemindersForNotification(d.reminders || []);
    list.innerHTML = "";
    const select = document.getElementById("reminderProject");
    if (select) {
      const current = select.value;
      select.innerHTML = '<option value="">Bez przypisanego projektu</option>';
      projects.forEach(p => {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        select.appendChild(o);
      });
      select.value = current;
    }
    if (!d.reminders.length) {
      list.innerHTML = "<li>Nie masz jeszcze przypomnień.</li>";
      return;
    }
    d.reminders.forEach(r => {
      const li = document.createElement("li");
      li.className = "reminder-item";
      const text = document.createElement("span");
      text.textContent = `${r.is_done ? "✓ " : ""}${r.title} — ${new Date(r.due_at).toLocaleString("pl-PL")}${r.notes ? " · " + r.notes : ""}`;
      if (r.is_done) text.classList.add("is-done");
      const done = document.createElement("button");
      done.className = "btn-small";
      done.textContent = r.is_done ? "Cofnij" : "Zrobione";
      done.onclick = async () => {
        await apiRequest(`/api/reminders/${r.id}`, { method: "PATCH", body: JSON.stringify({ is_done: !r.is_done }) });
        loadReminders();
      };
      const del = document.createElement("button");
      del.className = "btn-danger";
      del.textContent = "Usuń";
      del.onclick = async () => {
        const confirmed = await showConfirm(`Usunąć przypomnienie „${r.title}”?`, {
          title: "Usuwanie przypomnienia",
          confirmText: "Usuń",
          danger: true
        });
        if (confirmed) {
          await apiRequest(`/api/reminders/${r.id}`, { method: "DELETE" });
          loadReminders();
          showToast("Przypomnienie usunięte.", "info");
        }
      };
      li.append(text, done, del);
      list.appendChild(li);
    });
  } catch (e) {
    console.warn(e);
  }
}

async function addReminder() {
  const title = document.getElementById("reminderTitle").value.trim(),
    due = document.getElementById("reminderDue").value,
    project = document.getElementById("reminderProject").value,
    notes = document.getElementById("reminderNotes").value.trim();
  if (!title || !due) return showToast("Podaj tytuł i termin.", "warning");
  try {
    await apiRequest("/api/reminders", {
      method: "POST",
      body: JSON.stringify({ title, due_at: new Date(due).toISOString(), project_id: project ? Number(project) : null, notes })
    });
    document.getElementById("reminderTitle").value = "";
    document.getElementById("reminderDue").value = "";
    document.getElementById("reminderNotes").value = "";
    await loadReminders();
    showToast("Dodano przypomnienie.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function downloadBackup() {
  try {
    const includePhotos = document.getElementById("backupIncludePhotos")?.checked ? "1" : "0";
    const d = await apiRequest(`/api/backup?include_photos=${includePhotos}`);
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `asystent-dziergania-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Pobrano kopię zapasową JSON.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function importBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const confirmed = await showConfirm(
      "Zaimportować dane z kopii zapasowej? Zostaną dodane do obecnego konta, bez usuwania istniejących rekordów.",
      { title: "Import kopii zapasowej", confirmText: "Importuj" }
    );
    if (!confirmed) return;
    const result = await apiRequest("/api/backup/import", { method: "POST", body: JSON.stringify(backup) });
    showToast(`Import zakończony. Projekty: ${result.imported_projects}, włóczki: ${result.imported_yarns}.`, "success");
    await loadYarnsFromServer();
    await Promise.all([loadProjectsFromServer(), loadReminders(), loadStats()]);
  } catch (e) {
    showToast(e.message || "Nie udało się odczytać kopii.", "error");
  } finally {
    event.target.value = "";
  }
}

function downloadPdfReport() {
  window.location.href = "/api/export.pdf";
}

async function changeYarnStatus(yarnId, status) {
  try {
    const d = await apiRequest(`/api/yarns/${yarnId}`, { method: "PATCH", body: JSON.stringify({ status }) });
    const i = yarns.findIndex(y => y.id === yarnId);
    if (i >= 0) yarns[i] = d.yarn;
    renderYarnList();
  } catch (e) {
    showToast(e.message, "error");
  }
}