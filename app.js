"use strict";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const CHUNK_SIZE = 8 * 1024 * 1024;
const SESSION_KEY = "pracownia-drive-session";
const config = window.APP_CONFIG;
const elements = Object.fromEntries([
  "welcome", "workspace", "sign-in", "sign-out", "new-folder", "upload",
  "file-input", "refresh", "breadcrumbs", "files", "empty", "notice"
].map(id => [id, document.getElementById(id)]));

let token = null;
let tokenClient = null;
let path = [];
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
  for (const id of ["sign-in", "sign-out", "new-folder", "upload", "refresh"]) {
    elements[id].disabled = value;
  }
  elements.files.querySelectorAll("button").forEach(button => { button.disabled = value; });
  elements.breadcrumbs.querySelectorAll("button").forEach(button => { button.disabled = value; });
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
  elements.files.replaceChildren();
  elements.breadcrumbs.replaceChildren();
  elements.welcome.hidden = false;
  elements.workspace.hidden = true;
  elements["sign-out"].hidden = true;
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
  await showFolder([{ id: root.id, name: root.name }]);
  if (!token || token !== activeToken) throw new Error("Sesja uległa zmianie. Zaloguj się ponownie.");
  elements.welcome.hidden = true;
  elements.workspace.hidden = false;
  elements["sign-out"].hidden = false;
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
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size,capabilities(canTrash))");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("orderBy", "folder,name");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await (await driveFetch(url)).json();
    files.push(...result.files);
    pageToken = result.nextPageToken;
  } while (pageToken);
  return files;
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

async function showFolder(nextPath) {
  const files = await getFiles(nextPath[nextPath.length - 1].id);
  path = nextPath;
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
  elements.empty.hidden = files.length > 0;
  for (const file of files) {
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
    elements.files.append(row);
  }
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
  await showFolder(path);
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
  await showFolder(path);
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
elements.refresh.addEventListener("click", () => run(() => showFolder(path)));
elements["new-folder"].addEventListener("click", () => run(createFolder));
elements.upload.addEventListener("click", () => elements["file-input"].click());
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
      if (token) await showFolder(path);
      throw new Error(`Przesłano ${uploaded} z ${files.length} plików. ${error.message}`);
    }
    await showFolder(path);
    notice(`Przesłano pliki: ${uploaded}.`);
  });
});

window.addEventListener("storage", event => {
  if (event.key === SESSION_KEY && token && event.newValue !== event.oldValue) {
    signOut(false, false);
    notice("Sesja została zmieniona w innej karcie. Zaloguj się ponownie.", true);
  }
});

restoreSession();
