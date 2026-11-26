"use strict";

const DRIVE_SCOPE = "openid email https://www.googleapis.com/auth/drive";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const CHUNK_SIZE = 8 * 1024 * 1024;
const SESSION_KEY = "pracownia-drive-session";
const TASK_VERSION = 1;
const TASK_FILE_SUFFIX = ".json";
const TASK_FOLDER_CACHE_KEY = "pracownia-tasks-folder";
const TASK_CACHE_KEY = "pracownia-tasks-cache";
const CACHE_TTL = 60_000;
const TASK_REFRESH_INTERVAL = 60_000;
const FILE_RENDER_BATCH = 200;
const TASK_STATUSES = {
  todo: "Do zrobienia",
  doing: "W trakcie",
  done: "Gotowe"
};
const PRIORITY_LABELS = {
  low: "Niski",
  normal: "Normalny",
  high: "Wysoki"
};
const config = window.APP_CONFIG;
const elements = Object.fromEntries([
  "welcome", "workspace", "sign-in", "sign-out", "new-folder", "upload",
  "file-input", "refresh", "breadcrumbs", "files", "empty", "notice",
  "profile-control", "profile-avatar", "current-member", "workspace-title", "workspace-subtitle",
  "file-actions", "task-actions", "dashboard-tab", "files-tab", "tasks-tab",
  "dashboard-panel", "files-panel",
  "tasks-panel", "task-tab-count", "task-filters", "task-summary",
  "todo-count", "doing-count", "done-count", "todo-list", "doing-list",
  "done-list", "new-task", "task-dialog", "task-form", "task-dialog-title",
  "close-task-dialog", "cancel-task", "task-title", "task-description",
  "task-assignee", "task-status", "task-priority", "task-file",
  "task-comments-section", "task-comments", "task-new-comment", "delete-task",
  "dashboard-open-count", "dashboard-progress-label", "dashboard-mine-count",
  "dashboard-doing-count", "dashboard-done-count", "dashboard-my-tasks",
  "dashboard-team", "dashboard-activity",
  "load-more-files"
].map(id => [id, document.getElementById(id)]));

let token = null;
let tokenClient = null;
let path = [];
let tasks = [];
let tasksFolderId = null;
let currentFileOptions = [];
let activeView = null;
let taskFilter = "all";
let visibleFileCount = FILE_RENDER_BATCH;
let visibleFileSource = [];
let editedTask = null;
const pendingTaskIds = new Set();
let currentUserEmail = "";
let currentMember = null;
let loadingTasks = null;
const folderCache = new Map();
const taskContentCache = new Map();
let busy = false;
let noticeTimer;
let expiryTimer;

function notice(message, isError = false) {
  clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", isError);
  elements.notice.hidden = false;
  if (!isError) noticeTimer = setTimeout(() => { elements.notice.hidden = true; }, 5000);
}

function setBusy(value) {
  busy = value;
  for (const id of ["sign-in", "sign-out", "new-folder", "upload", "refresh", "new-task"]) {
    elements[id].disabled = value;
  }
  elements.files.querySelectorAll("button").forEach(button => { button.disabled = value; });
  elements.breadcrumbs.querySelectorAll("button").forEach(button => { button.disabled = value; });
  elements["tasks-panel"].querySelectorAll("button").forEach(button => { button.disabled = value; });
}

async function run(action) {
  if (busy) return;
  setBusy(true);
  try {
    await action();
  } catch (error) {
    notice(error.message || "Wystąpił nieznany błąd.", true);
  } finally {
    setBusy(false);
  }
}

function clearStoredSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    return true;
  } catch {
    notice("Nie można usunąć zapisanej sesji. Wyczyść dane tej strony w ustawieniach przeglądarki.", true);
    return false;
  }
}

function signOut(revoke = true, clearStorage = true) {
  if (revoke && token && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(token, () => {});
  }
  clearTimeout(expiryTimer);
  token = null;
  path = [];
  tasks = [];
  tasksFolderId = null;
  currentUserEmail = "";
  currentMember = null;
  loadingTasks = null;
  folderCache.clear();
  taskContentCache.clear();
  try {
    sessionStorage.removeItem(TASK_CACHE_KEY);
  } catch {
    // Wylogowanie nie może zależeć od dostępu do pamięci sesji.
  }
  elements.files.replaceChildren();
  elements.breadcrumbs.replaceChildren();
  closeTaskDialog();
  activeView = null;
  elements["task-tab-count"].textContent = "";
  elements.welcome.hidden = false;
  elements.workspace.hidden = true;
  elements["sign-out"].hidden = true;
  elements["profile-control"].hidden = true;
  return !clearStorage || clearStoredSession();
}

function scheduleExpiry(expiresAt) {
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => {
    if (signOut(false)) notice("Sesja Google wygasła. Zaloguj się ponownie.", true);
  }, Math.max(0, expiresAt - Date.now()));
}

function saveSession(accessToken, expiresIn) {
  const lifetime = Number(expiresIn);
  if (!Number.isFinite(lifetime) || lifetime <= 0) {
    notice("Google nie podało czasu ważności sesji. Logowanie nie zostanie zapamiętane.", true);
    return;
  }
  const expiresAt = Date.now() + lifetime * 1000;
  scheduleExpiry(expiresAt);
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      token: accessToken,
      expiresAt,
      clientId: config.clientId,
      folderId: config.folderId
    }));
    notice("Połączono z folderem projektu.");
  } catch {
    notice("Nie można zapamiętać sesji w przeglądarce. Po zamknięciu strony zaloguj się ponownie.", true);
  }
}

async function connectToFolder() {
  const activeToken = token;
  const root = await (await driveFetch(fileUrl(config.folderId, { fields: "id,name,mimeType,trashed" }))).json();
  if (root.mimeType !== FOLDER_TYPE || root.trashed) throw new Error("Skonfigurowany element nie jest dostępnym folderem.");
  await identifyCurrentMember();
  path = [{ id: root.id, name: root.name }];
  if (!token || token !== activeToken) throw new Error("Sesja uległa zmianie. Zaloguj się ponownie.");
  elements.welcome.hidden = true;
  elements.workspace.hidden = false;
  elements["sign-out"].hidden = false;
  elements["profile-control"].hidden = false;
  await navigateFromHash();
}

function restoreSession() {
  let saved;
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return;
    saved = JSON.parse(stored);
  } catch {
    notice("Nie można odczytać zapisanej sesji. Zaloguj się ponownie.", true);
    return;
  }
  if (!saved || typeof saved.token !== "string" || !saved.token ||
      typeof saved.expiresAt !== "number" || !Number.isFinite(saved.expiresAt) ||
      saved.clientId !== config?.clientId || saved.folderId !== config?.folderId ||
      saved.expiresAt <= Date.now()) {
    if (clearStoredSession()) notice("Zapisana sesja wygasła lub konfiguracja się zmieniła. Zaloguj się ponownie.", true);
    return;
  }
  token = saved.token;
  scheduleExpiry(saved.expiresAt);
  run(async () => {
    try {
      await connectToFolder();
    } catch (error) {
      signOut(false, false);
      throw error;
    }
  });
}

async function identifyCurrentMember() {
  const profile = await (await driveFetch(new URL("https://www.googleapis.com/oauth2/v3/userinfo"), {
    headers: { Accept: "application/json" }
  })).json();
  currentUserEmail = String(profile.email || "").trim().toLowerCase();
  currentMember = config.teamByEmail?.[currentUserEmail] || null;
  elements["current-member"].textContent = currentMember || currentUserEmail || "Nieznane konto";
  elements["profile-avatar"].textContent = (currentMember || "?").slice(0, 1).toUpperCase();
  elements["profile-control"].title = currentUserEmail;
  if (!currentMember) {
    notice(`Konto ${currentUserEmail || "Google"} nie jest przypisane do Malibura, Filipa ani Arka. Pliki działają, ale taski są tylko do odczytu.`, true);
  }
}

async function driveFetch(url, options = {}) {
  if (!token) throw new Error("Zaloguj się ponownie.");
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    if (!signOut(false)) throw new Error("Sesja wygasła. Nie można usunąć zapisanej sesji; wyczyść dane strony w przeglądarce.");
    throw new Error("Sesja wygasła. Zaloguj się ponownie.");
  }
  if (!response.ok) {
    let message = `Błąd Google Drive (HTTP ${response.status}).`;
    const body = await response.json().catch(() => null);
    if (body?.error?.message) message += ` ${body.error.message}`;
    throw new Error(message);
  }
  return response;
}

function fileUrl(id, params = {}) {
  const url = new URL(`${API}/${encodeURIComponent(id)}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function getFiles(folderId) {
  const files = [];
  let pageToken;
  do {
    const url = new URL(API);
    url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,capabilities(canTrash))");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("orderBy", "folder,name");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await (await driveFetch(url)).json();
    files.push(...result.files);
    pageToken = result.nextPageToken;
  } while (pageToken);
  return files;
}

async function ensureTasksFolder() {
  if (tasksFolderId) return tasksFolderId;
  try {
    const cached = JSON.parse(localStorage.getItem(TASK_FOLDER_CACHE_KEY) || "null");
    if (cached?.rootId === config.folderId && typeof cached.folderId === "string") {
      tasksFolderId = cached.folderId;
      return tasksFolderId;
    }
  } catch {
    localStorage.removeItem(TASK_FOLDER_CACHE_KEY);
  }
  const url = new URL(API);
  url.searchParams.set("q", `'${config.folderId}' in parents and trashed = false and mimeType = '${FOLDER_TYPE}' and name = '${config.tasksFolderName}'`);
  url.searchParams.set("fields", "files(id,name)");
  const result = await (await driveFetch(url)).json();
  if (result.files.length > 1) throw new Error("W Drive istnieje kilka systemowych folderów tasków. Usuń duplikaty i odśwież stronę.");
  if (result.files[0]) {
    tasksFolderId = result.files[0].id;
    cacheTasksFolder();
    return tasksFolderId;
  }
  const created = await (await driveFetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: config.tasksFolderName,
      mimeType: FOLDER_TYPE,
      parents: [config.folderId]
    })
  })).json();
  tasksFolderId = created.id;
  cacheTasksFolder();
  return tasksFolderId;
}

function cacheTasksFolder() {
  try {
    localStorage.setItem(TASK_FOLDER_CACHE_KEY, JSON.stringify({
      rootId: config.folderId,
      folderId: tasksFolderId
    }));
  } catch {
    // Tasky nadal działają bez lokalnego cache.
  }
}

function restoreTaskCache() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(TASK_CACHE_KEY) || "[]");
    for (const item of cached) {
      if (item?.id && item.task && item.modifiedTime) taskContentCache.set(item.id, item);
    }
  } catch {
    sessionStorage.removeItem(TASK_CACHE_KEY);
  }
}

function persistTaskCache() {
  try {
    sessionStorage.setItem(TASK_CACHE_KEY, JSON.stringify([...taskContentCache.entries()].map(([id, item]) => ({
      id,
      modifiedTime: item.modifiedTime,
      task: item.task
    }))));
  } catch {
    // Cache jest tylko optymalizacją; brak miejsca nie blokuje tasków.
  }
}

async function loadTasks({ force = false } = {}) {
  if (loadingTasks) return loadingTasks;
  loadingTasks = loadTasksInternal({ force });
  try {
    return await loadingTasks;
  } finally {
    loadingTasks = null;
  }
}

async function loadTasksInternal({ force }) {
  await ensureTasksFolder();
  const taskFiles = (await getFiles(tasksFolderId)).filter(file => (
    file.mimeType === "application/json" && file.name.endsWith(TASK_FILE_SUFFIX)
  ));
  const activeIds = new Set(taskFiles.map(file => file.id));
  for (const id of taskContentCache.keys()) {
    if (!activeIds.has(id)) taskContentCache.delete(id);
  }
  const loaded = await mapWithConcurrency(taskFiles, 4, async file => {
    const cached = taskContentCache.get(file.id);
    if (!force && cached?.modifiedTime === file.modifiedTime) return { ...cached.task, fileId: file.id };
    const task = await (await driveFetch(fileUrl(file.id, { alt: "media" }))).json();
    if (!isTaskRecord(task)) {
      throw new Error(`Plik taska „${file.name}” ma nieprawidłowy format.`);
    }
    taskContentCache.set(file.id, { modifiedTime: file.modifiedTime, task });
    return { ...task, fileId: file.id };
  });
  tasks = loaded.sort((a, b) => {
    const byUpdate = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    return byUpdate || a.title.localeCompare(b.title, "pl");
  });
  persistTaskCache();
  renderTasks();
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function isTaskRecord(task) {
  return task && task.version === TASK_VERSION &&
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.description === "string" &&
    config.team.includes(task.assignee) &&
    Object.hasOwn(TASK_STATUSES, task.status) &&
    Object.hasOwn(PRIORITY_LABELS, task.priority) &&
    typeof task.updatedAt === "string" &&
    Array.isArray(task.comments) &&
    task.comments.every(comment => (
      comment && typeof comment.id === "string" &&
      config.team.includes(comment.author) &&
      typeof comment.text === "string" &&
      typeof comment.createdAt === "string"
    )) &&
    (task.linkedFile === null || (
      task.linkedFile && typeof task.linkedFile.id === "string" &&
      typeof task.linkedFile.name === "string"
    ));
}

async function writeTask(task) {
  await ensureTasksFolder();
  const boundary = `pracownia-${crypto.randomUUID()}`;
  const isUpdate = Boolean(task.fileId);
  const metadata = isUpdate
    ? { name: `${task.id}${TASK_FILE_SUFFIX}` }
    : { name: `${task.id}${TASK_FILE_SUFFIX}`, mimeType: "application/json", parents: [tasksFolderId] };
  const taskToStore = { ...task };
  delete taskToStore.fileId;
  const body = [
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    `${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\n`,
    "Content-Type: application/json\r\n\r\n",
    `${JSON.stringify(taskToStore)}\r\n`,
    `--${boundary}--`
  ].join("");
  const url = isUpdate
    ? new URL(`${UPLOAD_API}/${encodeURIComponent(task.fileId)}`)
    : new URL(UPLOAD_API);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("fields", "id");
  const result = await (await driveFetch(url, {
    method: isUpdate ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body
  })).json();
  taskContentCache.delete(task.fileId);
  persistTaskCache();
  return result.id;
}

async function removeTask(task) {
  await driveFetch(fileUrl(task.fileId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true })
  });
  taskContentCache.delete(task.fileId);
  persistTaskCache();
}

async function notifyDiscord(events, task) {
  if (!config.discordRelayUrl) return { configured: false };
  const results = [];
  for (const event of events) {
    const response = await fetch(config.discordRelayUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        event,
        folderId: config.folderId,
        accessToken: token,
        pageUrl: window.location.href.split("#")[0],
        task
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error || `Pośrednik Discord zwrócił HTTP ${response.status}.`);
    }
    results.push(body);
  }
  return { configured: true, results };
}

function formatSize(size) {
  if (size === undefined) return "—";
  const bytes = Number(size);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function makeButton(label, title, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", () => run(action));
  return button;
}

async function showFolder(nextPath, { force = false } = {}) {
  const folderId = nextPath[nextPath.length - 1].id;
  const cached = folderCache.get(folderId);
  const files = !force && cached && Date.now() - cached.at < CACHE_TTL
    ? cached.files
    : await getFiles(folderId);
  folderCache.set(folderId, { files, at: Date.now() });
  path = nextPath;
  visibleFileCount = FILE_RENDER_BATCH;
  currentFileOptions = files.filter(file => (
    file.mimeType !== FOLDER_TYPE &&
    file.mimeType !== "application/vnd.google-apps.folder" &&
    file.id !== tasksFolderId
  ));
  renderPath();
  renderFiles(files);
}

function renderPath() {
  elements.breadcrumbs.replaceChildren();
  path.forEach((folder, index) => {
    if (index) {
      const separator = document.createElement("span");
      separator.textContent = "/";
      elements.breadcrumbs.append(separator);
    }
    const button = makeButton(folder.name, `Otwórz folder ${folder.name}`, () => showFolder(path.slice(0, index + 1)));
    if (index === path.length - 1) button.setAttribute("aria-current", "page");
    elements.breadcrumbs.append(button);
  });
}

function renderFiles(files) {
  elements.files.replaceChildren();
  visibleFileSource = files.filter(file => file.id !== tasksFolderId && file.name !== config.tasksFolderName);
  const visibleFiles = visibleFileSource.slice(0, visibleFileCount);
  elements.empty.hidden = visibleFiles.length > 0;
  const fragment = document.createDocumentFragment();
  for (const file of visibleFiles) {
    const isFolder = file.mimeType === FOLDER_TYPE;
    const isGoogleFile = file.mimeType.startsWith("application/vnd.google-apps.");
    const row = document.createElement("div");
    row.className = "file-row";
    const name = document.createElement("div");
    name.className = "file-name";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = isFolder ? "▰" : "▤";
    name.append(icon);
    if (isFolder || !isGoogleFile) {
      name.append(makeButton(file.name, `${isFolder ? "Otwórz folder" : "Pobierz"} ${file.name}`, () => (
        isFolder ? showFolder([...path, { id: file.id, name: file.name }]) : downloadFile(file)
      )));
    } else {
      const text = document.createElement("span");
      text.textContent = file.name;
      text.title = "Pliki Google Docs nie są obsługiwane przez tę stronę.";
      name.append(text);
    }
    const date = document.createElement("span");
    date.className = "date";
    date.textContent = file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString("pl-PL") : "—";
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = formatSize(file.size);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (!isFolder && !isGoogleFile) actions.append(makeButton("↓", `Pobierz ${file.name}`, () => downloadFile(file)));
    if (file.capabilities?.canTrash) actions.append(makeButton("×", `Przenieś do kosza: ${file.name}`, () => trashFile(file)));
    row.append(name, date, size, actions);
    fragment.append(row);
  }
  elements.files.append(fragment);
  elements["load-more-files"].hidden = visibleFileSource.length <= visibleFileCount;
  elements["load-more-files"].textContent =
    `Pokaż więcej (${visibleFileSource.length - Math.min(visibleFileCount, visibleFileSource.length)})`;
}

function initializeTeamUi() {
  const members = Array.isArray(config?.team) ? config.team : [];
  elements["task-assignee"].replaceChildren();
  elements["task-filters"].replaceChildren();
  addFilterButton("all", "Wszyscy");
  for (const member of members) {
    addSelectOption(elements["task-assignee"], member, member);
    addFilterButton(member, member);
  }
}

function addSelectOption(select, value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  select.append(option);
}

function addFilterButton(value, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.assignee = value;
  button.textContent = label;
  button.classList.toggle("active", value === taskFilter);
  button.addEventListener("click", () => {
    taskFilter = value;
    renderTasks();
  });
  elements["task-filters"].append(button);
}

function getProfile() {
  return currentMember;
}

function requireProfile() {
  const member = getProfile();
  if (!member) {
    throw new Error(`Konto ${currentUserEmail || "Google"} nie należy do skonfigurowanego zespołu.`);
  }
  return member;
}

async function navigateFromHash() {
  const route = ["dashboard", "tasks", "files"].includes(window.location.hash.slice(1))
    ? window.location.hash.slice(1)
    : "dashboard";
  if (route === activeView) return;
  setActiveView(route);
  if (route === "dashboard" || route === "tasks") {
    renderTasks();
    await loadTasks();
  } else {
    await showFolder(path);
  }
}

function setActiveView(view) {
  if (view === activeView) return;
  activeView = view;
  const sections = {
    dashboard: elements["dashboard-panel"],
    files: elements["files-panel"],
    tasks: elements["tasks-panel"]
  };
  for (const [name, element] of Object.entries(sections)) element.hidden = name !== view;
  elements["file-actions"].hidden = view !== "files";
  elements["task-actions"].hidden = view !== "tasks";
  const tabs = {
    dashboard: elements["dashboard-tab"],
    files: elements["files-tab"],
    tasks: elements["tasks-tab"]
  };
  for (const [name, tab] of Object.entries(tabs)) {
    tab.classList.toggle("active", name === view);
    tab.removeAttribute("aria-current");
    if (name === view) tab.setAttribute("aria-current", "page");
  }
  const headings = {
    dashboard: ["Pulpit zespołu", "Najważniejsze rzeczy w jednym widoku."],
    files: ["Pliki zespołu", "Wszystko, nad czym razem pracujemy."],
    tasks: ["Taski zespołu", "Przeciągaj zadania i przesuwaj pracę do przodu."]
  };
  elements["workspace-title"].innerHTML = `${headings[view][0]}<span class="brand-dot">.</span>`;
  elements["workspace-subtitle"].textContent = headings[view][1];
}

function renderTasks() {
  const lists = {
    todo: elements["todo-list"],
    doing: elements["doing-list"],
    done: elements["done-list"]
  };
  for (const list of Object.values(lists)) list.replaceChildren();
  const visible = tasks.filter(task => taskFilter === "all" || task.assignee === taskFilter);
  const fragments = Object.fromEntries(Object.keys(TASK_STATUSES).map(status => [status, document.createDocumentFragment()]));
  for (const status of Object.keys(TASK_STATUSES)) {
    const statusTasks = visible.filter(task => task.status === status);
    elements[`${status}-count`].textContent = String(statusTasks.length);
    if (!statusTasks.length) {
      const empty = document.createElement("div");
      empty.className = "task-empty-column";
      empty.textContent = "Brak tasków";
      fragments[status].append(empty);
    }
    for (const task of statusTasks) fragments[status].append(makeTaskCard(task));
  }
  for (const status of Object.keys(TASK_STATUSES)) lists[status].append(fragments[status]);
  for (const button of elements["task-filters"].querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.assignee === taskFilter);
  }
  elements["task-summary"].textContent = `${visible.length} ${visible.length === 1 ? "task" : "tasków"}`;
  elements["task-tab-count"].textContent = String(tasks.filter(task => task.status !== "done").length || "");
  renderDashboard();
}

function renderDashboard() {
  const open = tasks.filter(task => task.status !== "done");
  const doing = tasks.filter(task => task.status === "doing");
  const done = tasks.filter(task => task.status === "done");
  const mine = open.filter(task => task.assignee === currentMember);
  const completion = tasks.length ? Math.round(done.length / tasks.length * 100) : 0;
  elements["dashboard-open-count"].textContent = String(open.length);
  elements["dashboard-progress-label"].textContent = `${completion}% ukończonych`;
  elements["dashboard-mine-count"].textContent = String(mine.length);
  elements["dashboard-doing-count"].textContent = String(doing.length);
  elements["dashboard-done-count"].textContent = String(done.length);
  renderDashboardTasks(mine);
  renderTeamOverview(open);
  renderDashboardActivity();
}

function renderDashboardTasks(myTasks) {
  elements["dashboard-my-tasks"].replaceChildren();
  const important = [...myTasks].sort((a, b) => {
    const priority = { high: 0, normal: 1, low: 2 };
    return priority[a.priority] - priority[b.priority] ||
      new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
  }).slice(0, 5);
  if (!important.length) {
    elements["dashboard-my-tasks"].append(makeDashboardEmpty(
      currentMember ? `Brak otwartych zadań dla: ${currentMember}.` : "Zaloguj się kontem zespołu, aby zobaczyć swoje zadania."
    ));
    return;
  }
  for (const task of important) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dashboard-task";
    row.addEventListener("click", () => openTaskDialog(task));
    const copy = document.createElement("span");
    copy.className = "dashboard-task-copy";
    const title = document.createElement("strong");
    title.textContent = task.title;
    const state = document.createElement("small");
    state.textContent = `${TASK_STATUSES[task.status]} · ${PRIORITY_LABELS[task.priority]}`;
    copy.append(title, state);
    const arrow = document.createElement("span");
    arrow.className = "dashboard-task-arrow";
    arrow.textContent = "→";
    row.append(copy, arrow);
    elements["dashboard-my-tasks"].append(row);
  }
}

function renderTeamOverview(openTasks) {
  elements["dashboard-team"].replaceChildren();
  for (const member of config.team) {
    const memberTasks = openTasks.filter(task => task.assignee === member);
    const active = memberTasks.filter(task => task.status === "doing").length;
    const row = document.createElement("div");
    row.className = "team-member-row";
    const avatar = document.createElement("span");
    avatar.className = "task-avatar";
    avatar.textContent = member.slice(0, 1).toUpperCase();
    const name = document.createElement("strong");
    name.textContent = member;
    if (member === currentMember) name.append(" (Ty)");
    const load = document.createElement("span");
    load.textContent = `${active} w trakcie · ${memberTasks.length} otwartych`;
    const meter = document.createElement("span");
    meter.className = "team-member-meter";
    const fill = document.createElement("span");
    fill.style.width = `${Math.min(100, memberTasks.length / Math.max(1, open.length) * 100)}%`;
    meter.append(fill);
    row.append(avatar, name, load, meter);
    elements["dashboard-team"].append(row);
  }
}

function renderDashboardActivity() {
  elements["dashboard-activity"].replaceChildren();
  const recent = [...tasks]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 7);
  if (!recent.length) {
    elements["dashboard-activity"].append(makeDashboardEmpty("Pierwszy task pojawi się tutaj po utworzeniu."));
    return;
  }
  for (const task of recent) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "activity-row";
    row.addEventListener("click", () => openTaskDialog(task));
    const dot = document.createElement("span");
    dot.className = `activity-dot status-${task.status}`;
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = task.title;
    const detail = document.createElement("small");
    detail.textContent = `${task.updatedBy || task.assignee} · ${TASK_STATUSES[task.status]} · ${formatDateTime(task.updatedAt)}`;
    copy.append(title, detail);
    row.append(dot, copy);
    elements["dashboard-activity"].append(row);
  }
}

function makeDashboardEmpty(message) {
  const empty = document.createElement("p");
  empty.className = "dashboard-empty";
  empty.textContent = message;
  return empty;
}

function makeTaskCard(task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.dataset.taskId = task.id;
  card.draggable = Boolean(currentMember) && !pendingTaskIds.has(task.id);
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Edytuj task ${task.title}`);
  card.addEventListener("click", event => {
    if (!event.target.closest("a")) openTaskDialog(task);
  });
  card.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTaskDialog(task);
    }
  });
  card.addEventListener("dragstart", event => {
    if (!card.draggable) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    document.querySelectorAll(".task-column.drag-over").forEach(column => column.classList.remove("drag-over"));
  });

  const top = document.createElement("div");
  top.className = "task-card-top";
  const title = document.createElement("span");
  title.className = "task-card-title";
  title.textContent = task.title;
  const priority = document.createElement("span");
  priority.className = `task-priority priority-${task.priority}`;
  priority.textContent = PRIORITY_LABELS[task.priority];
  top.append(title, priority);

  const description = document.createElement("p");
  description.className = "task-card-description";
  description.textContent = task.description || "Bez opisu";

  const meta = document.createElement("div");
  meta.className = "task-card-meta";
  const assignee = document.createElement("span");
  assignee.className = "task-assignee";
  const avatar = document.createElement("span");
  avatar.className = "task-avatar";
  avatar.textContent = task.assignee.slice(0, 1).toUpperCase();
  assignee.append(avatar, document.createTextNode(task.assignee));
  const links = document.createElement("span");
  links.className = "task-links";
  if (task.linkedFile) {
    const link = document.createElement("a");
    link.href = task.linkedFile.webViewLink ||
      `https://drive.google.com/file/d/${encodeURIComponent(task.linkedFile.id)}/view`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Plik ↗";
    link.title = task.linkedFile.name;
    link.style.color = "inherit";
    links.append(link);
  }
  if (task.comments.length) links.append(document.createTextNode(`◇ ${task.comments.length}`));
  meta.append(assignee, links);
  const statusControl = document.createElement("label");
  statusControl.className = "task-quick-status";
  const statusLabel = document.createElement("span");
  statusLabel.textContent = "Status";
  const statusSelect = document.createElement("select");
  statusSelect.setAttribute("aria-label", `Zmień status: ${task.title}`);
  for (const [value, label] of Object.entries(TASK_STATUSES)) {
    addSelectOption(statusSelect, value, label);
  }
  statusSelect.value = task.status;
  statusSelect.disabled = pendingTaskIds.has(task.id) || !currentMember;
  statusSelect.addEventListener("click", event => event.stopPropagation());
  statusSelect.addEventListener("change", () => changeTaskStatus(task.id, statusSelect.value));
  statusControl.append(statusLabel, statusSelect);
  card.append(top, description, meta, statusControl);
  return card;
}

async function changeTaskStatus(taskId, status) {
  try {
    requireProfile();
    if (!Object.hasOwn(TASK_STATUSES, status)) throw new Error("Nieznany status taska.");
    const index = tasks.findIndex(task => task.id === taskId);
    if (index < 0 || pendingTaskIds.has(taskId) || tasks[index].status === status) return;
    const previous = tasks[index];
    const updated = {
      ...previous,
      status,
      updatedBy: currentMember,
      updatedAt: new Date().toISOString()
    };
    pendingTaskIds.add(taskId);
    tasks[index] = updated;
    renderTasks();
    try {
      updated.fileId = await writeTask(updated);
      tasks[index] = updated;
      notifyDiscordInBackground(
        [status === "done" ? "completed" : "status_changed"],
        updated
      );
    } catch (error) {
      tasks[index] = previous;
      renderTasks();
      throw error;
    } finally {
      pendingTaskIds.delete(taskId);
      renderTasks();
    }
  } catch (error) {
    notice(error.message || "Nie można zmienić statusu taska.", true);
  }
}

function initializeDragAndDrop() {
  for (const column of document.querySelectorAll(".task-column")) {
    column.addEventListener("dragover", event => {
      if (!currentMember || pendingTaskIds.size) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      column.classList.add("drag-over");
    });
    column.addEventListener("dragleave", event => {
      if (!column.contains(event.relatedTarget)) column.classList.remove("drag-over");
    });
    column.addEventListener("drop", event => {
      event.preventDefault();
      column.classList.remove("drag-over");
      const taskId = event.dataTransfer.getData("text/plain");
      const status = column.dataset.status;
      if (taskId && status) changeTaskStatus(taskId, status);
    });
  }
}

function openTaskDialog(task = null) {
  try {
    const member = requireProfile();
    editedTask = task ? structuredClone(task) : null;
    elements["task-form"].reset();
    populateTaskFileOptions(task?.linkedFile || null);
    elements["task-dialog-title"].textContent = task ? "Edytuj task" : "Nowy task";
    elements["delete-task"].hidden = !task;
    elements["task-comments-section"].hidden = !task?.comments.length;
    elements["task-comments"].replaceChildren();
    if (task) {
      elements["task-title"].value = task.title;
      elements["task-description"].value = task.description || "";
      elements["task-assignee"].value = task.assignee;
      elements["task-status"].value = task.status;
      elements["task-priority"].value = task.priority;
      elements["task-file"].value = task.linkedFile?.id || "";
      renderTaskComments(task.comments);
    } else {
      elements["task-assignee"].value = member;
      elements["task-status"].value = "todo";
      elements["task-priority"].value = "normal";
    }
    elements["task-dialog"].showModal();
    elements["task-title"].focus();
  } catch (error) {
    notice(error.message, true);
  }
}

function closeTaskDialog() {
  if (elements["task-dialog"].open) elements["task-dialog"].close();
  editedTask = null;
  elements["task-new-comment"].value = "";
}

function populateTaskFileOptions(linkedFile) {
  elements["task-file"].replaceChildren();
  addSelectOption(elements["task-file"], "", "Bez powiązania");
  const files = [...currentFileOptions];
  if (linkedFile && !files.some(file => file.id === linkedFile.id)) files.push(linkedFile);
  for (const file of files) {
    addSelectOption(elements["task-file"], file.id, file.name);
  }
  const optionData = files.map(file => ({
    id: file.id,
    name: file.name,
    webViewLink: file.webViewLink || null
  }));
  elements["task-file"].dataset.options = JSON.stringify(optionData);
}

function getSelectedTaskFile() {
  const selectedId = elements["task-file"].value;
  if (!selectedId) return null;
  const options = JSON.parse(elements["task-file"].dataset.options || "[]");
  return options.find(file => file.id === selectedId) || null;
}

function renderTaskComments(comments) {
  elements["task-comments"].replaceChildren();
  for (const comment of comments) {
    const item = document.createElement("div");
    item.className = "task-comment";
    const author = document.createElement("strong");
    author.textContent = comment.author;
    const time = document.createElement("time");
    time.dateTime = comment.createdAt;
    time.textContent = ` · ${formatDateTime(comment.createdAt)}`;
    author.append(time);
    item.append(author, document.createTextNode(comment.text));
    elements["task-comments"].append(item);
  }
  elements["task-comments-section"].hidden = comments.length === 0;
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "nieznana data" : date.toLocaleString("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function downloadFile(file) {
  notice(`Pobieranie: ${file.name}`);
  const response = await driveFetch(fileUrl(file.id, { alt: "media" }));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  notice(`Pobrano: ${file.name}`);
}

async function trashFile(file) {
  const extra = file.mimeType === FOLDER_TYPE ? " Wraz z jego zawartością." : "";
  if (!window.confirm(`Przenieść „${file.name}” do kosza Google Drive?${extra}`)) return;
  await driveFetch(fileUrl(file.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true })
  });
  await showFolder(path, { force: true });
  notice("Przeniesiono do kosza.");
}

async function createFolder() {
  const name = window.prompt("Nazwa nowego folderu:");
  if (name === null) return;
  if (!name.trim()) throw new Error("Nazwa folderu nie może być pusta.");
  await driveFetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim(), mimeType: FOLDER_TYPE, parents: [path[path.length - 1].id] })
  });
  await showFolder(path, { force: true });
  notice("Folder został utworzony.");
}

async function uploadFile(file) {
  const url = new URL(UPLOAD_API);
  url.searchParams.set("uploadType", "resumable");
  const response = await driveFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Content-Type": file.type || "application/octet-stream",
      "X-Upload-Content-Length": String(file.size)
    },
    body: JSON.stringify({ name: file.name, parents: [path[path.length - 1].id] })
  });
  const uploadUrl = response.headers.get("Location");
  if (!uploadUrl || new URL(uploadUrl).origin !== "https://www.googleapis.com") {
    throw new Error("Google Drive nie zwrócił prawidłowego adresu przesyłania.");
  }
  if (file.size === 0) {
    await driveFetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file
    });
    return;
  }
  for (let start = 0; start < file.size; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": file.type || "application/octet-stream",
        "Content-Range": `bytes ${start}-${end - 1}/${file.size}`
      },
      body: file.slice(start, end)
    });
    if (chunk.status === 401) {
      if (!signOut(false)) throw new Error("Sesja wygasła. Nie można usunąć zapisanej sesji; wyczyść dane strony w przeglądarce.");
      throw new Error("Sesja wygasła podczas przesyłania. Zaloguj się ponownie.");
    }
    if (end < file.size ? chunk.status !== 308 : !chunk.ok) {
      throw new Error(`Nie udało się przesłać „${file.name}” (HTTP ${chunk.status}).`);
    }
    notice(`Przesyłanie ${file.name}: ${Math.round(end / file.size * 100)}%`);
  }
}

function buildTaskDraft() {
  const member = requireProfile();
  const now = new Date().toISOString();
  const existing = editedTask;
  const comment = elements["task-new-comment"].value.trim();
  const comments = existing ? structuredClone(existing.comments) : [];
  if (comment) {
    comments.push({
      id: crypto.randomUUID(),
      author: member,
      text: comment,
      createdAt: now
    });
  }
  return {
    version: TASK_VERSION,
    id: existing?.id || crypto.randomUUID(),
    fileId: existing?.fileId || null,
    title: elements["task-title"].value.trim(),
    description: elements["task-description"].value.trim(),
    assignee: elements["task-assignee"].value,
    status: elements["task-status"].value,
    priority: elements["task-priority"].value,
    linkedFile: getSelectedTaskFile(),
    comments,
    createdBy: existing?.createdBy || member,
    createdAt: existing?.createdAt || now,
    updatedBy: member,
    updatedAt: now
  };
}

function getTaskEvents(previous, next, commentWasAdded) {
  if (!previous) return ["created", ...(commentWasAdded ? ["comment"] : [])];
  const events = [];
  if (previous.status !== next.status) {
    events.push(next.status === "done" ? "completed" : "status_changed");
  }
  const detailsChanged =
    previous.title !== next.title ||
    previous.description !== next.description ||
    previous.assignee !== next.assignee ||
    previous.priority !== next.priority ||
    previous.linkedFile?.id !== next.linkedFile?.id;
  if (detailsChanged) events.push("updated");
  if (commentWasAdded) events.push("comment");
  return events;
}

async function submitTask() {
  const task = buildTaskDraft();
  if (!task.title) throw new Error("Tytuł taska nie może być pusty.");
  const commentWasAdded = Boolean(elements["task-new-comment"].value.trim());
  const events = getTaskEvents(editedTask, task, commentWasAdded);
  task.fileId = await writeTask(task);
  closeTaskDialog();
  await loadTasks({ force: true });
  if (events.length) {
    notifyDiscordInBackground(events, task);
  } else {
    notice("Task zapisano.");
  }
}

async function deleteEditedTask() {
  if (!editedTask) return;
  requireProfile();
  if (!window.confirm(`Usunąć task „${editedTask.title}”?`)) return;
  const deleted = editedTask;
  await removeTask(deleted);
  closeTaskDialog();
  await loadTasks({ force: true });
  notifyDiscordInBackground(["deleted"], deleted);
}

function notifyDiscordInBackground(events, task) {
  if (!config.discordRelayUrl) {
    notice("Zmiana zapisana. Discord nie jest jeszcze skonfigurowany.");
    return;
  }
  notice("Zmiana zapisana. Wysyłam powiadomienie na Discord...");
  notifyDiscord(events, task)
    .then(result => notice(result.configured
      ? `Zapisano i wysłano powiadomienie na Discord (${events.length}).`
      : "Zmiana zapisana."))
    .catch(error => notice(`Zmiana zapisana, ale nie wysłano powiadomienia Discord: ${error.message}`, true));
}

elements["sign-in"].addEventListener("click", () => {
  if (busy) return;
  if (!config?.clientId || !config?.folderId || !/^[\w-]+$/.test(config.folderId)) {
    notice("Uzupełnij clientId i folderId w pliku config.js zgodnie z instrukcją.", true);
    return;
  }
  if (!window.google?.accounts?.oauth2) {
    notice("Nie udało się załadować logowania Google. Sprawdź połączenie i spróbuj ponownie.", true);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: config.clientId,
    scope: DRIVE_SCOPE,
    callback: response => {
      if (response.error || !response.access_token) {
        notice(`Logowanie nie powiodło się: ${response.error_description || response.error || "brak tokenu"}.`, true);
        return;
      }
      token = response.access_token;
      run(async () => {
        try {
          await connectToFolder();
          saveSession(response.access_token, response.expires_in);
        } catch (error) {
          if (!signOut(false)) throw new Error(`${error.message} Nie można usunąć zapisanej sesji; wyczyść dane strony w przeglądarce.`);
          throw error;
        }
      });
    },
    error_callback: error => notice(`Nie udało się otworzyć logowania: ${error.message || error.type}.`, true)
  });
  tokenClient.requestAccessToken();
});

elements["sign-out"].addEventListener("click", () => { if (signOut()) notice("Wylogowano."); });
elements.refresh.addEventListener("click", () => run(() => showFolder(path, { force: true })));
elements["load-more-files"].addEventListener("click", () => {
  visibleFileCount += FILE_RENDER_BATCH;
  renderFiles(visibleFileSource);
});
elements["new-folder"].addEventListener("click", () => run(createFolder));
elements.upload.addEventListener("click", () => elements["file-input"].click());
elements["new-task"].addEventListener("click", () => openTaskDialog());
for (const [element, route] of [
  [elements["dashboard-tab"], "dashboard"],
  [elements["files-tab"], "files"],
  [elements["tasks-tab"], "tasks"]
]) {
  element.addEventListener("click", event => {
    event.preventDefault();
    const hash = `#${route}`;
    if (window.location.hash !== hash) history.pushState(null, "", hash);
    navigateFromHash().catch(error => notice(error.message, true));
  });
}
elements["close-task-dialog"].addEventListener("click", closeTaskDialog);
elements["cancel-task"].addEventListener("click", closeTaskDialog);
elements["delete-task"].addEventListener("click", () => run(deleteEditedTask));
elements["task-form"].addEventListener("submit", event => {
  event.preventDefault();
  run(submitTask);
});
elements["task-dialog"].addEventListener("cancel", event => {
  event.preventDefault();
  closeTaskDialog();
});
elements["file-input"].addEventListener("change", event => {
  const files = [...event.target.files];
  event.target.value = "";
  if (!files.length) return;
  run(async () => {
    let uploaded = 0;
    try {
      for (const file of files) {
        notice(`Przesyłanie: ${file.name}`);
        await uploadFile(file);
        uploaded++;
      }
    } catch (error) {
      if (token) await showFolder(path, { force: true });
      throw new Error(`Przesłano ${uploaded} z ${files.length} plików. ${error.message}`);
    }
    await showFolder(path, { force: true });
    notice(`Przesłano pliki: ${uploaded}.`);
  });
});

window.addEventListener("storage", event => {
  if (event.key === SESSION_KEY && token && event.newValue !== event.oldValue) {
    signOut(false, false);
    notice("Sesja została zmieniona w innej karcie. Zaloguj się ponownie.", true);
  }
});

window.addEventListener("hashchange", () => {
  if (token) navigateFromHash().catch(error => notice(error.message, true));
});
window.addEventListener("popstate", () => {
  if (token) navigateFromHash().catch(error => notice(error.message, true));
});

setInterval(() => {
  if (document.visibilityState === "visible" && token && (activeView === "tasks" || activeView === "dashboard") &&
      !busy && !elements["task-dialog"].open) {
    loadTasks().catch(error => notice(`Nie można odświeżyć tasków: ${error.message}`, true));
  }
}, TASK_REFRESH_INTERVAL);

initializeTeamUi();
initializeDragAndDrop();
restoreTaskCache();
restoreSession();
