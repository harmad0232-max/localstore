let currentPath = "";
let currentUser = null;
let authProviders = { local: true, google: false };
let storageProviders = { local: true, aws: false };
let storageMode = "local";
let viewMode = "own"; // "own" | "shared"
let sharesCache = { owned: [], received: [] };
let currentShare = null; // selected shared folder when in shared view
let selectedItems = new Set(); // paths relative to root/view
let bulkShareHideTimer = null;
let allUsers = [];

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // ignore
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function offerExternalShare(url, name) {
  const choice = (prompt(`Share "${name}" externally:\n1 - Copy link\n2 - Share via system dialog\nAnything else - cancel`) || "").trim();
  if (choice === "1") {
    const ok = await copyToClipboard(url);
    alert(ok ? "Link copied to clipboard." : "Could not copy link. Please copy it manually:\n" + url);
  } else if (choice === "2") {
    if (navigator.share) {
      try {
        await navigator.share({ title: name, url });
      } catch {
        // user cancelled or share failed
      }
    } else {
      alert("System sharing is not supported in this browser.");
    }
  }
}

function saveState() {
  if (!currentUser) {
    try {
      localStorage.removeItem("storageState");
    } catch {}
    return;
  }
  const payload = {
    storageMode,
    viewMode,
    currentPath,
    shareId: currentShare?.id || null
  };
  try {
    localStorage.setItem("storageState", JSON.stringify(payload));
  } catch {}
}

function loadStateFromStorage() {
  try {
    const raw = localStorage.getItem("storageState");
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.storageMode === "local" || data.storageMode === "cloud") {
      storageMode = data.storageMode;
    }
    if (data.viewMode === "own" || data.viewMode === "shared") {
      viewMode = data.viewMode;
    }
    if (typeof data.currentPath === "string") {
      currentPath = data.currentPath;
    }
    if (data.shareId && Array.isArray(sharesCache.received)) {
      currentShare = sharesCache.received.find((s) => s.id === data.shareId) || null;
    }
  } catch {
    // ignore bad state
  }
}

function show(el, on) {
  if (!el) return;
  el.classList.toggle("hidden", !on);
}

function setUserLabel(user) {
  const label = document.getElementById("userLabel");
  const logoutBtn = document.getElementById("logoutBtn");
  const avatar = document.getElementById("userAvatar");
  if (!label || !logoutBtn) return;
  if (user) {
    label.textContent = user.email ? user.email : user.name ? user.name : user.id;
    logoutBtn.classList.remove("hidden");
    if (avatar) {
      if (user.avatarUrl) {
        avatar.src = user.avatarUrl;
        avatar.classList.remove("hidden");
      } else {
        avatar.classList.add("hidden");
      }
    }
  } else {
    label.textContent = "";
    logoutBtn.classList.add("hidden");
    if (avatar) avatar.classList.add("hidden");
  }
}

function setAuthMsg(msg) {
  const el = document.getElementById("authMsg");
  if (el) el.textContent = msg || "";
}

function applyAuthState() {
  show(document.getElementById("authPanel"), !currentUser);
  show(document.getElementById("appPanel"), !!currentUser);
  setUserLabel(currentUser);
}

function applyProviderState() {
  const googleBtn = document.getElementById("googleBtn");
  if (googleBtn) show(googleBtn, Boolean(authProviders.google));
}

function applyStorageState() {
  const label = document.getElementById("storageModeLabel");
  if (label) label.textContent = storageMode === "cloud" ? "Cloud" : "Local";
  const tabCloud = document.getElementById("tabCloud");
  if (tabCloud) {
    tabCloud.classList.toggle("primary", storageMode === "cloud");
    tabCloud.disabled = !storageProviders.aws;
  }
}

function join(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return `${a.replace(/\\+/g, "/").replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

function fmtSize(n) {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|bmp|svg|ico)$/i;
const VIDEO_EXTS = /\.(mp4|webm|ogg|mov|m4v)$/i;
const AUDIO_EXTS = /\.(mp3|wav|ogg|m4a)$/i;
const DOC_EXTS = /\.(docx?|pdf)$/i;
const SHEET_EXTS = /\.(xlsx?|csv)$/i;
const TEXT_EXTS = /\.(txt|md|json|log|cfg|ini)$/i;

function fileExt(name) {
  const m = String(name || "").match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function isImageFileName(name) {
  return name && IMAGE_EXTS.test(String(name));
}
function isVideoFileName(name) {
  return name && VIDEO_EXTS.test(String(name));
}
function isAudioFileName(name) {
  return name && AUDIO_EXTS.test(String(name));
}
function fileKindIcon(name) {
  if (DOC_EXTS.test(name)) return "📄"; // Word/PDF
  if (SHEET_EXTS.test(name)) return "📊"; // Excel/CSV
  if (TEXT_EXTS.test(name)) return "📃"; // Text/Notepad
  return "📁";
}

function thumbnailUrl(itemPath) {
  if (viewMode === "shared" && currentShare) {
    return `/api/shared/download?shareId=${encodeURIComponent(currentShare.id)}&path=${encodeURIComponent(itemPath)}&inline=1`;
  }
  return `/api/download?path=${encodeURIComponent(itemPath)}&inline=1`;
}

async function list() {
  console.log("Listing items for path:", currentPath, "viewMode:", viewMode, "storageMode:", storageMode);
  // Shared view (read-only listing of a shared cloud folder)
  if (viewMode === "shared" && currentShare) {
    const params = new URLSearchParams();
    params.set("shareId", currentShare.id);
    if (currentPath) params.set("path", currentPath);
    const r = await fetch(`/api/shared/list?${params.toString()}`);
    if (r.status === 401) {
      currentUser = null;
      applyAuthState();
      setAuthMsg("Please login to continue.");
      return;
    }
    if (r.status === 501) {
      const data = await r.json().catch(() => ({}));
      alert(data.error || "Cloud storage is not configured.");
      storageMode = "local";
      viewMode = "own";
      currentShare = null;
      currentPath = "";
      applyStorageState();
      applyViewTabs();
      saveState();
      return;
    }
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(data.error || "Failed to load shared data.");
      return;
    }
    const data = await r.json();
    render(data.items || []);
    renderCrumbs(currentPath, true);
    return;
  }

  // Default: own storage (local or cloud)
  const r = await fetch(`/api/list?path=${encodeURIComponent(currentPath)}`);
  if (r.status === 401) {
    currentUser = null;
    applyAuthState();
    setAuthMsg("Please login to continue.");
    return;
  }
  if (r.status === 501) {
    const data = await r.json().catch(() => ({}));
    alert(data.error || "Cloud storage is not configured.");
    storageMode = "local";
    applyStorageState();
    currentPath = "";
    return;
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    alert(data.error || "Failed to load data.");
    return;
  }
  const data = await r.json();
  render(data.items || []);
  renderCrumbs(currentPath, false);
}

const folderStatsCache = new Map();
const folderStatsInflight = new Map();

async function fetchItemsForPath(p) {
  if (viewMode === "shared" && currentShare) {
    const params = new URLSearchParams();
    params.set("shareId", currentShare.id);
    if (p) params.set("path", p);
    const r = await fetch(`/api/shared/list?${params.toString()}`);
    if (!r.ok) throw new Error("list failed");
    const data = await r.json().catch(() => ({}));
    return Array.isArray(data.items) ? data.items : [];
  }
  const r = await fetch(`/api/list?path=${encodeURIComponent(p || "")}`);
  if (!r.ok) throw new Error("list failed");
  const data = await r.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items : [];
}

async function computeFolderStats(basePath) {
  const maxNodes = 3000;
  const maxDepth = 10;
  let nodes = 0;
  let totalSize = 0;
  let maxMtime = 0;
  let complete = true;
  const stack = [{ p: basePath, d: 0 }];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur) break;
    if (cur.d > maxDepth) {
      complete = false;
      continue;
    }
    let items;
    try {
      items = await fetchItemsForPath(cur.p);
    } catch {
      complete = false;
      continue;
    }
    for (const it of items) {
      nodes++;
      if (nodes > maxNodes) {
        complete = false;
        stack.length = 0;
        break;
      }
      if (it?.type === "file") {
        totalSize += Number(it.size || 0);
        const mt = Number(it.mtime || 0);
        if (mt > maxMtime) maxMtime = mt;
      } else if (it?.type === "dir") {
        const next = join(cur.p, it.name);
        stack.push({ p: next, d: cur.d + 1 });
        const mt = Number(it.mtime || 0);
        if (mt > maxMtime) maxMtime = mt;
      }
    }
  }

  return { size: totalSize, mtime: maxMtime, complete };
}

function scheduleFolderStats(relPath, sizeEl, mtimeEl) {
  if (!relPath || !sizeEl || !mtimeEl) return;
  const cached = folderStatsCache.get(relPath);
  if (cached) {
    sizeEl.textContent = cached.complete ? fmtSize(cached.size) : `${fmtSize(cached.size)}+`;
    if (cached.mtime && cached.mtime > 0) {
      const d = new Date(cached.mtime);
      mtimeEl.textContent = isNaN(d.getTime()) ? "" : d.toLocaleString();
    } else {
      mtimeEl.textContent = "";
    }
    return;
  }
  if (folderStatsInflight.has(relPath)) return;

  sizeEl.dataset.folderPath = relPath;
  mtimeEl.dataset.folderPath = relPath;
  sizeEl.textContent = "...";
  mtimeEl.textContent = "";

  const p = computeFolderStats(relPath)
    .then((res) => {
      folderStatsCache.set(relPath, res);
      if (sizeEl.dataset.folderPath !== relPath) return;
      sizeEl.textContent = res.complete ? fmtSize(res.size) : `${fmtSize(res.size)}+`;
      if (res.mtime && res.mtime > 0) {
        const d = new Date(res.mtime);
        mtimeEl.textContent = isNaN(d.getTime()) ? "" : d.toLocaleString();
      } else {
        mtimeEl.textContent = "";
      }
    })
    .finally(() => {
      folderStatsInflight.delete(relPath);
    });

  folderStatsInflight.set(relPath, p);
}

function render(items) {
  const tbody = document.getElementById("list");
  tbody.innerHTML = "";
  selectedItems = new Set(selectedItems); // ensure it's a Set instance
  items.forEach((it) => {
    const tr = document.createElement("tr");
    const thumbTd = document.createElement("td");
    thumbTd.className = "thumb-wrap";
    if (it.type === "dir") {
      const icon = document.createElement("span");
      icon.className = "thumb-icon";
      icon.textContent = "📁";
      thumbTd.appendChild(icon);
    } else if (isImageFileName(it.name) && (it.size == null || it.size < 2 * 1024 * 1024)) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.alt = it.name;
      img.src = thumbnailUrl(join(currentPath, it.name));
      img.loading = "lazy";
      img.onerror = () => {
        img.style.display = "none";
        const fallback = document.createElement("span");
        fallback.className = "thumb-icon";
        fallback.textContent = "🖼";
        thumbTd.appendChild(fallback);
      };
      thumbTd.appendChild(img);
    } else if (isVideoFileName(it.name)) {
      const icon = document.createElement("span");
      icon.className = "thumb-icon";
      icon.textContent = "🎬";
      thumbTd.appendChild(icon);
    } else if (isAudioFileName(it.name)) {
      const icon = document.createElement("span");
      icon.className = "thumb-icon";
      icon.textContent = "🎵";
      thumbTd.appendChild(icon);
    } else {
      const icon = document.createElement("span");
      icon.className = "thumb-icon";
      icon.textContent = fileKindIcon(it.name);
      thumbTd.appendChild(icon);
    }
    const selectTd = document.createElement("td");
    // Allow selecting both files and folders for sharing
    if ((it.type === "file" || it.type === "dir") && (viewMode === "own" || (viewMode === "shared" && currentShare))) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      const relPath = join(currentPath, it.name);
      cb.dataset.rel = relPath;
      cb.checked = selectedItems.has(relPath);
      cb.onchange = () => {
        if (cb.checked) selectedItems.add(relPath);
        else selectedItems.delete(relPath);
        const all = document.getElementById("selectAll");
        if (all) all.checked = false;
      };
      selectTd.appendChild(cb);
    }

    const nameTd = document.createElement("td");
    const name = document.createElement("span");
    name.textContent = it.name;
    name.className = "name";
    name.onclick = () => {
      if (it.type === "dir") {
        currentPath = join(currentPath, it.name);
        saveState();
        list();
      }
    };
    nameTd.appendChild(name);
    const typeTd = document.createElement("td");
    typeTd.textContent = it.type;
    const sizeTd = document.createElement("td");
    sizeTd.textContent = it.type === "file" ? fmtSize(it.size) : "";
    const mtimeTd = document.createElement("td");
    if (it.mtime && Number(it.mtime) > 0) {
      const d = new Date(it.mtime);
      mtimeTd.textContent = isNaN(d.getTime()) ? "" : d.toLocaleString();
    } else {
      mtimeTd.textContent = "";
    }
    if (it.type === "dir") {
      const relPath = join(currentPath, it.name);
      setTimeout(() => scheduleFolderStats(relPath, sizeTd, mtimeTd), 0);
    }
  const actionsTd = document.createElement("td");
  const relPath = join(currentPath, it.name);
  const actionsRow = document.createElement("div");
  actionsRow.style.display = "flex";
  actionsRow.style.gap = "4px";
  actionsTd.appendChild(actionsRow);

  if (it.type === "file") {
    const a = document.createElement("a");
    a.className = "btn";
    if (viewMode === "shared" && currentShare) {
      a.href = `/api/shared/download?shareId=${encodeURIComponent(currentShare.id)}&path=${encodeURIComponent(
        join(currentPath, it.name)
      )}`;
    } else {
      a.href = `/api/download?path=${encodeURIComponent(join(currentPath, it.name))}`;
    }
    a.textContent = "Download";
    actionsRow.appendChild(a);
  }

    tr.appendChild(thumbTd);
    tr.appendChild(selectTd);
    tr.appendChild(nameTd);
    tr.appendChild(typeTd);
    tr.appendChild(sizeTd);
    tr.appendChild(mtimeTd);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
}

function renderCrumbs(p, isShared) {
  const el = document.getElementById("breadcrumbs");
  el.innerHTML = "";
  const parts = p ? p.split(/[\\/]+/).filter(Boolean) : [];
  let acc = "";
  const root = document.createElement("a");
  root.href = "#";
  root.textContent = isShared ? "shared-root" : "root";
  root.onclick = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    currentPath = "";
    saveState();
    list();
  };
  el.appendChild(root);
  parts.forEach((part, idx) => {
    el.appendChild(document.createTextNode(" / "));
    const parentAcc = acc;
    acc = join(acc, part);
    const crumbAcc = acc;
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = part;
    a.onclick = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const isLast = idx === parts.length - 1;
      currentPath = isLast ? parentAcc : crumbAcc;
      saveState();
      list();
    };
    el.appendChild(a);
  });
}

const mkdirBtn = document.getElementById("mkdir");
if (mkdirBtn) {
  mkdirBtn.onclick = async () => {
    const folderNameEl = document.getElementById("folderName");
    const name = String(folderNameEl?.value || "").trim();
    if (!name) return;
    const p = join(currentPath, name);
    const r = await fetch("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) });
    if (!r.ok) {
      const ct = r.headers.get("content-type") || "";
      let msg = "Failed to create folder.";
      if (ct.includes("application/json")) {
        const data = await r.json().catch(() => ({}));
        msg = data.error || msg;
      } else {
        msg = await r.text().catch(() => msg);
      }
      alert(msg);
      return;
    }
    if (folderNameEl) folderNameEl.value = "";
    saveState();
    list();
  };
}

const upBtn = document.getElementById("up");
if (upBtn) {
  upBtn.onclick = () => {
    if (!currentPath) return;
    const parts = currentPath.split(/[\\/]+/).filter(Boolean);
    parts.pop();
    currentPath = parts.join("/");
    saveState();
    list();
  };
}

const backupStatusEl = document.getElementById("backupStatus");
function setBackupStatus(msg) {
  if (backupStatusEl) backupStatusEl.textContent = msg || "";
}

const backupProgressRow = document.getElementById("backupProgressRow");
const backupProgressEl = document.getElementById("backupProgress");
const backupProgressLabelEl = document.getElementById("backupProgressLabel");
function setBackupProgressVisible(on) {
  show(backupProgressRow, Boolean(on));
}
function setBackupProgressLabel(msg) {
  if (backupProgressLabelEl) backupProgressLabelEl.textContent = msg || "";
}
function setBackupProgressDeterminate(value, max, label) {
  if (!backupProgressEl) return;
  backupProgressEl.max = Number.isFinite(max) && max > 0 ? max : 1;
  backupProgressEl.value = Number.isFinite(value) ? Math.max(0, Math.min(value, backupProgressEl.max)) : 0;
  setBackupProgressLabel(label || "");
  setBackupProgressVisible(true);
}
function setBackupProgressIndeterminate(label) {
  if (!backupProgressEl) return;
  backupProgressEl.removeAttribute("value");
  setBackupProgressLabel(label || "");
  setBackupProgressVisible(true);
}
function clearBackupProgress() {
  if (backupProgressEl) {
    backupProgressEl.value = 0;
    backupProgressEl.max = 1;
  }
  setBackupProgressLabel("");
  setBackupProgressVisible(false);
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtQuotaGb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  return (n / (1024 * 1024 * 1024)).toFixed(2);
}

function sanitizeDeviceName(name) {
  const raw = String(name || "").trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "device";
}

function sanitizeBackupRootName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[\\/]+/g, "-").replace(/\s+/g, " ").trim();
  return cleaned;
}

function inferSingleRootFolderName(files) {
  if (!Array.isArray(files) || files.length === 0) return "";
  let root = "";
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const rel = normalizeRelPath(f?.webkitRelativePath || "");
    if (!rel) return "";
    const parts = rel.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    const first = parts[0] || "";
    if (!first) return "";
    if (!root) root = first;
    else if (root !== first) return "";
  }
  return root;
}

async function chooseBackupRootDir(files, deviceName) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const inferredRoot = sanitizeBackupRootName(inferSingleRootFolderName(files));
  const fallback = `${sanitizeDeviceName(deviceName)}-${ts}`;
  const preferred = inferredRoot || fallback;

  try {
    const r = await fetch("/api/list?path=");
    if (!r.ok) return { baseDir: preferred, sourceRoot: inferredRoot };
    const data = await r.json().catch(() => ({}));
    const items = Array.isArray(data.items) ? data.items : [];
    const exists = items.some((it) => it && it.type === "dir" && String(it.name || "") === preferred);
    if (!exists) return { baseDir: preferred, sourceRoot: inferredRoot };
    return { baseDir: `${preferred}-${ts}`, sourceRoot: inferredRoot };
  } catch {
    return { baseDir: preferred, sourceRoot: inferredRoot };
  }
}

function normalizeRelPath(p) {
  const parts = String(p || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  const safe = [];
  for (const part of parts) {
    if (part === "." || part === "..") continue;
    safe.push(part);
  }
  return safe.join("/");
}

function posixDirname(p) {
  const s = String(p || "");
  const i = s.lastIndexOf("/");
  return i === -1 ? "" : s.slice(0, i);
}

function posixBasename(p) {
  const s = String(p || "");
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

function chunkFiles(files, maxCount, maxBytes) {
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const f of files) {
    const size = Number(f?.size || 0);
    const wouldExceedCount = cur.length >= maxCount;
    const wouldExceedBytes = cur.length > 0 && curBytes + size > maxBytes;
    if (wouldExceedCount || wouldExceedBytes) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function xhrUploadFormData(url, formData, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (signal) {
      signal.addEventListener("abort", () => {
        xhr.abort();
        reject(new Error("Aborted"));
      });
    }
    xhr.open("POST", url, true);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    if (xhr.upload && typeof onProgress === "function") {
      xhr.upload.onprogress = (e) => {
        onProgress({ loaded: e.loaded, total: e.total, lengthComputable: e.lengthComputable });
      };
    }
    xhr.send(formData);
  });
}

function xhrDownloadBlob(url, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "blob";
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error(xhr.responseText || `Download failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Download failed"));
    if (typeof onProgress === "function") {
      xhr.onprogress = (e) => {
        onProgress({ loaded: e.loaded, total: e.total, lengthComputable: e.lengthComputable });
      };
    }
    xhr.send();
  });
}

async function uploadFilesToDir(dir, files, apiPath, onProgress, expectedBytes, signal) {
  if (storageMode === "cloud") {
    // Optimization: Direct browser-to-S3 upload using Presigned URLs
    // This bypasses the server bottleneck and doubles the speed.
    const fileInfos = files.map(f => ({ 
      name: f.name, 
      type: f.type || "application/octet-stream" 
    }));
    
    try {
      const r = await fetch("/api/cloud/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dir, files: fileInfos })
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Presign failed");
      
      // Upload files individually in parallel
      const uploads = data.urls.map(async (info, idx) => {
        const file = files[idx];
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          if (signal) {
            signal.addEventListener("abort", () => {
              xhr.abort();
              reject(new Error("Aborted"));
            });
          }
          xhr.open(info.method, info.url, true);
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`S3 upload failed (${xhr.status})`));
          };
          xhr.onerror = () => reject(new Error("S3 upload failed"));
          
          // Progress is tracked at the chunk level by the caller
          xhr.send(file);
        });
      });
      await Promise.all(uploads);
      return;
    } catch (err) {
      console.warn("Direct S3 upload failed, falling back to server upload:", err);
      // Fallback to server-side upload if presign fails
    }
  }

  // Standard server-side upload logic
  const fd = new FormData();
  for (const f of files) {
    const rel = normalizeRelPath(f.webkitRelativePath || f.name || "file");
    fd.append("files", f, posixBasename(rel) || "file");
  }
  const base = String(apiPath || "/api/upload");
  const url = `${base}?path=${encodeURIComponent(dir)}`;
  await xhrUploadFormData(url, fd, (e) => onProgress && onProgress(e, expectedBytes), signal);
}

const JOB_STORAGE_KEY = "backupJobs";
const activeAbortControllers = new Map();

function getPersistedJobs() {
  try {
    const raw = localStorage.getItem(JOB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePersistedJobs(jobs) {
  try {
    localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(jobs));
  } catch {}
}

function updatePersistedJob(id, updates) {
  const jobs = getPersistedJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx !== -1) {
    jobs[idx] = { ...jobs[idx], ...updates, lastUpdated: Date.now() };
    savePersistedJobs(jobs);
    if (viewMode === "jobs") renderPersistedJobs();
  }
}

function addPersistedJob(job) {
  const jobs = getPersistedJobs();
  jobs.unshift({ ...job, createdAt: Date.now(), lastUpdated: Date.now() });
  savePersistedJobs(jobs.slice(0, 50)); // Keep last 50 jobs
  if (viewMode === "jobs") renderPersistedJobs();
}

function renderPersistedJobs() {
  const container = document.getElementById("persistedJobsList");
  if (!container) return;
  
  const jobs = getPersistedJobs();
  if (jobs.length === 0) {
    container.innerHTML = '<div class="hint">No backup jobs yet.</div>';
    return;
  }

  container.innerHTML = "";
  jobs.forEach((job) => {
    const div = document.createElement("div");
    div.className = "card";
    div.style.padding = "10px";
    div.style.border = "1px solid #eee";
    div.style.background = job.status === "running" ? "#e8f4fd" : "#fff";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";

    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.textContent = job.name || "Unnamed Job";
    header.appendChild(title);

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      const cleanupBtn = document.createElement("button");
      cleanupBtn.className = "btn";
      cleanupBtn.style.fontSize = "0.8em";
      cleanupBtn.style.padding = "2px 6px";
      cleanupBtn.textContent = "Clean Up";
      cleanupBtn.title = "Delete all uploaded data from this backup job";
      cleanupBtn.onclick = async () => {
        if (!confirm(`Permanently delete all data uploaded by this job: ${job.name}?`)) return;
        try {
          cleanupBtn.disabled = true;
          // In our backup logic, the folder name is stored in job.backupFolder if we add it
          // For now, we use deviceName-timestamp. Let's find it.
          // The backup folder naming is device-ts.
          // Let's search for folders starting with deviceName.
          const r = await fetch(`/api/list?path=`);
          const data = await r.json();
          const backupFolders = data.items.filter(it => it.type === "dir" && it.name.startsWith(job.name));
          
          if (backupFolders.length === 0) {
             alert("Could not find backup folder to clean up.");
             return;
          }
          
          // Delete the actual backup folder
          const delRes = await fetch("/api/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: job.backupFolder })
          });
          if (delRes.ok) {
            alert("Cleanup successful. Backup data removed.");
            const updatedJobs = getPersistedJobs().filter(j => j.id !== job.id);
            savePersistedJobs(updatedJobs);
            renderPersistedJobs();
          } else {
            // Fallback: try to find by name if backupFolder path failed
            const r = await fetch(`/api/list?path=`);
            const data = await r.json();
            const backupFolders = data.items.filter(it => it.type === "dir" && it.name.startsWith(job.name));
            if (backupFolders.length > 0) {
              const retryDel = await fetch("/api/remove", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: backupFolders[0].name })
              });
              if (retryDel.ok) {
                alert("Cleanup successful via fallback.");
                const updatedJobs = getPersistedJobs().filter(j => j.id !== job.id);
                savePersistedJobs(updatedJobs);
                renderPersistedJobs();
                return;
              }
            }
            alert("Cleanup failed.");
          }
        } catch (e) {
          alert(`Error: ${e.message}`);
        } finally {
          cleanupBtn.disabled = false;
        }
      };
      header.appendChild(cleanupBtn);
    }
    div.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "hint";
    const date = new Date(job.createdAt).toLocaleString();
    meta.textContent = `${date} - ${job.status.toUpperCase()}`;

    const progWrap = document.createElement("div");
    progWrap.style.marginTop = "6px";
    
    const prog = document.createElement("progress");
    prog.className = "progress";
    prog.style.width = "100%";
    prog.value = job.uploadedBytes || 0;
    prog.max = job.totalBytes || 1;

    const stats = document.createElement("div");
    stats.className = "hint";
    stats.textContent = `${fmtBytes(job.uploadedBytes || 0)} / ${fmtBytes(job.totalBytes || 0)}`;

    div.appendChild(meta);
    div.appendChild(progWrap);
    progWrap.appendChild(prog);
    div.appendChild(stats);

    if (job.status === "interrupted" || job.status === "failed") {
      const btn = document.createElement("button");
      btn.className = "btn primary";
      btn.style.marginTop = "8px";
      btn.textContent = "Resume (Re-select Folder)";
      btn.onclick = () => {
        alert("To resume this backup, please click 'Backup device', select 'Folder / Drive', and choose the SAME folder you were backing up.");
        viewMode = "own";
        applyViewTabs();
      };
      div.appendChild(btn);
    }

    container.appendChild(div);
  });
}

function createJobUI(id, name) {
  const container = document.getElementById("activeJobsList");
  if (!container) return null;
  
  const div = document.createElement("div");
  div.id = `job-${id}`;
  div.className = "card";
  div.style.padding = "8px";
  div.style.border = "1px solid #ccc";
  div.style.borderRadius = "4px";
  div.style.background = "#f9f9f9";
  div.style.marginBottom = "8px";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.style.fontWeight = "bold";
  header.textContent = `Backup Job: ${name}`;

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.style.fontSize = "0.8em";
  cancelBtn.style.padding = "2px 6px";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = () => {
    if (confirm(`Cancel backup job: ${name}?`)) {
      const controller = activeAbortControllers.get(id);
      if (controller) controller.abort();
    }
  };
  header.appendChild(cancelBtn);
  
  const status = document.createElement("div");
  status.id = `job-status-${id}`;
  status.className = "hint";
  status.textContent = "Starting...";

  const progress = document.createElement("progress");
  progress.id = `job-progress-${id}`;
  progress.className = "progress";
  progress.style.width = "100%";
  progress.value = 0;
  progress.max = 100;

  div.appendChild(header);
  div.appendChild(status);
  div.appendChild(progress);
  container.appendChild(div);

  return {
    setStatus: (msg) => { 
      status.textContent = msg; 
      updatePersistedJob(id, { statusMsg: msg });
    },
    setProgress: (val, max) => { 
      progress.value = val; 
      progress.max = max; 
      updatePersistedJob(id, { uploadedBytes: val, totalBytes: max });
    },
    setComplete: () => {
      updatePersistedJob(id, { status: "completed" });
      cancelBtn.style.display = "none";
    },
    setFailed: (err) => {
      updatePersistedJob(id, { status: "failed", error: String(err) });
      cancelBtn.style.display = "none";
    },
    setCancelled: () => {
      updatePersistedJob(id, { status: "cancelled" });
      status.textContent = "Cancelled";
      cancelBtn.style.display = "none";
      setTimeout(() => {
        if (div.parentNode) div.parentNode.removeChild(div);
      }, 3000);
    },
    remove: () => { 
      if (div.parentNode) div.parentNode.removeChild(div); 
    }
  };
}

function stripLeadingFolder(rel, folder) {
  const r = String(rel || "");
  const f = String(folder || "");
  if (!f) return r;
  const prefix = `${f}/`;
  return r.startsWith(prefix) ? r.slice(prefix.length) : r;
}

async function backupFromDeviceFiles(files, baseDir, sourceRoot, jobUI, jobId) {
  console.log(`Starting backup for ${files.length} files`);
  const MAX_COUNT = 1000; // Increased from 5
  const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB per chunk (safer for network)
  const dirName = String(baseDir || "").trim();
  if (!dirName) throw new Error("Invalid backup folder name");

  // Store the actual backup folder in the persisted job record
  if (jobId) {
    updatePersistedJob(jobId, { backupFolder: dirName, name: dirName });
  }

  const byDir = new Map();
  for (const f of files) {
    const originalRel = normalizeRelPath(f.webkitRelativePath || f.name || "");
    const rel = stripLeadingFolder(originalRel, sourceRoot);
    const dir = join(dirName, posixDirname(rel));
    const bucket = byDir.get(dir) || [];
    bucket.push(f);
    byDir.set(dir, bucket);
  }

  const dirs = Array.from(byDir.keys()).sort((a, b) => a.localeCompare(b));
  console.log(`Found ${dirs.length} directories to backup`);
  let uploaded = 0;
  let total = 0;
  for (const d of dirs) total += byDir.get(d)?.length || 0;
  const totalBytes = files.reduce((acc, f) => acc + Number(f?.size || 0), 0);
  let uploadedBytes = 0;

  const controller = new AbortController();
  if (jobId) activeAbortControllers.set(jobId, controller);

  try {
    for (const d of dirs) {
      const list = byDir.get(d) || [];
      console.log(`Processing directory: ${d} with ${list.length} files`);
      
      const chunks = chunkFiles(list, MAX_COUNT, MAX_TOTAL_BYTES);
      const CONCURRENCY = 6;
      const active = [];

      for (const chunk of chunks) {
        if (controller.signal.aborted) throw new Error("Aborted");

        const chunkBytes = chunk.reduce((acc, f) => acc + Number(f?.size || 0), 0);
        
        const uploadTask = async () => {
          try {
            await uploadFilesToDir(
              d,
              chunk,
              "/api/upload-cloud",
              (evt, expected) => {
                if (!evt) return;
              },
              chunkBytes,
              controller.signal
            );
            uploaded += chunk.length;
            uploadedBytes += chunkBytes;
            
            if (jobUI) {
              jobUI.setProgress(uploadedBytes, totalBytes);
              jobUI.setStatus(`Backing up... ${fmtBytes(uploadedBytes)} / ${fmtBytes(totalBytes)}`);
            } else {
              setBackupProgressDeterminate(uploadedBytes, totalBytes, `${fmtBytes(uploadedBytes)} / ${fmtBytes(totalBytes)}`);
            }
          } catch (err) {
            if (err.message === "Aborted") throw err;
            console.error(`Failed to upload chunk for ${d}:`, err);
            throw err;
          }
        };

        const p = uploadTask().then(() => active.splice(active.indexOf(p), 1));
        active.push(p);
        if (active.length >= CONCURRENCY) {
          await Promise.race(active);
        }
      }
      await Promise.all(active);
    }
    
    if (jobUI) {
      jobUI.setStatus(`Device backup completed (${uploaded} files).`);
      jobUI.setComplete();
      setTimeout(() => jobUI.remove(), 5000);
    } else {
      setBackupStatus(`Device backup completed (${uploaded} files).`);
      clearBackupProgress();
      setTimeout(() => setBackupStatus(""), 5000);
    }
  } catch (e) {
    if (e.message === "Aborted") {
      if (jobUI) jobUI.setCancelled();
      else setBackupStatus("Backup cancelled.");
    } else {
      if (jobUI) {
        jobUI.setStatus(`Failed: ${e.message || e}`);
        jobUI.setFailed(e);
      } else {
        setBackupStatus(`Backup failed: ${e.message || e}`);
      }
    }
    throw e;
  } finally {
    if (jobId) activeAbortControllers.delete(jobId);
  }
  await list();
}

const downloadCloudBackupBtn = document.getElementById("downloadCloudBackupBtn");
const cloudBackupPicker = document.getElementById("cloudBackupPicker");
const cloudBackupHint = document.getElementById("cloudBackupHint");
const cloudBackupList = document.getElementById("cloudBackupList");
const cloudBackupDownloadBtn = document.getElementById("cloudBackupDownloadBtn");
const cloudBackupCancelBtn = document.getElementById("cloudBackupCancelBtn");
if (
  downloadCloudBackupBtn &&
  cloudBackupPicker &&
  cloudBackupHint &&
  cloudBackupList &&
  cloudBackupDownloadBtn &&
  cloudBackupCancelBtn
) {
  let cloudBackups = [];

  function setCloudBackupPickerVisible(on) {
    show(cloudBackupPicker, Boolean(on));
  }

  function setCloudBackupHint(msg) {
    cloudBackupHint.textContent = msg || "";
  }

  function renderCloudBackups(list) {
    cloudBackupList.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "No backup folders found.";
      cloudBackupList.appendChild(empty);
      return;
    }
    list.forEach((b, idx) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      row.style.padding = "4px 2px";

      const rb = document.createElement("input");
      rb.type = "radio";
      rb.name = "cloudBackupChoice";
      rb.value = b.path;
      rb.checked = idx === 0;

      const label = document.createElement("span");
      label.textContent = `📁 ${b.name}`;
      label.style.cursor = "pointer";
      label.onclick = () => {
        rb.checked = true;
      };

      row.appendChild(rb);
      row.appendChild(label);
      cloudBackupList.appendChild(row);
    });
  }

  function getSelectedCloudBackupPath() {
    const sel = cloudBackupList.querySelector('input[type="radio"][name="cloudBackupChoice"]:checked');
    return sel ? String(sel.value || "") : "";
  }

  downloadCloudBackupBtn.onclick = async () => {
    if (!currentUser) {
      alert("Please login first.");
      return;
    }
    try {
      downloadCloudBackupBtn.disabled = true;
      setCloudBackupHint("Loading backup folders...");
      setCloudBackupPickerVisible(true);
      const r = await fetch("/api/cloud/backups");
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        setCloudBackupHint(data.error || "Failed to load backup folders.");
        cloudBackups = [];
        renderCloudBackups([]);
        return;
      }
      cloudBackups = Array.isArray(data.backups) ? data.backups : [];
      setCloudBackupHint(`Found ${cloudBackups.length} folder(s).`);
      renderCloudBackups(cloudBackups);
    } catch (e) {
      setCloudBackupHint(String(e?.message || e || "Failed to load backup folders."));
      cloudBackups = [];
      renderCloudBackups([]);
    } finally {
      downloadCloudBackupBtn.disabled = false;
    }
  };

  cloudBackupCancelBtn.onclick = () => {
    setCloudBackupPickerVisible(false);
    setCloudBackupHint("");
    cloudBackupList.innerHTML = "";
  };

  cloudBackupDownloadBtn.onclick = async () => {
    const p = getSelectedCloudBackupPath();
    if (!p) {
      alert("Select a backup folder.");
      return;
    }
    const name = p.split("/").filter(Boolean).pop() || "backup";
    try {
      cloudBackupDownloadBtn.disabled = true;
      cloudBackupCancelBtn.disabled = true;
      setBackupStatus("Preparing cloud backup download...");
      setBackupProgressIndeterminate("Starting download...");
      const url = `/api/cloud/backup/download?path=${encodeURIComponent(p)}`;
      const blob = await xhrDownloadBlob(url, (evt) => {
        if (evt.lengthComputable && evt.total > 0) {
          setBackupProgressDeterminate(evt.loaded, evt.total, `${fmtBytes(evt.loaded)} / ${fmtBytes(evt.total)}`);
        } else {
          setBackupProgressIndeterminate(`Downloading... ${fmtBytes(evt.loaded)}`);
        }
      });
      clearBackupProgress();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = `${name}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(obj), 1000);
      setBackupStatus("Cloud backup downloaded.");
      setTimeout(() => setBackupStatus(""), 4000);
      setCloudBackupPickerVisible(false);
      setCloudBackupHint("");
      cloudBackupList.innerHTML = "";
    } catch (e) {
      clearBackupProgress();
      setBackupStatus(String(e?.message || e || "Cloud backup download failed."));
    } finally {
      cloudBackupDownloadBtn.disabled = false;
      cloudBackupCancelBtn.disabled = false;
    }
  };
}

function fileLabelForSelection(f) {
  const rel = normalizeRelPath(f?.webkitRelativePath || f?.name || "");
  return rel || "file";
}

async function runDeviceBackup(files, deviceName) {
  const labels = files.map(fileLabelForSelection).filter(Boolean);
  const sample = labels.slice(0, 12);
  const extra = labels.length > sample.length ? `\n...and ${labels.length - sample.length} more` : "";
  const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
  
  const picked = await chooseBackupRootDir(files, deviceName);
  const backupRootDir = picked?.baseDir || "";
  const sourceRoot = picked?.sourceRoot || "";

  // Create a new job UI
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  
  // Add to persistence
  addPersistedJob({
    id: jobId,
    name: backupRootDir,
    status: "running",
    totalBytes: totalBytes,
    uploadedBytes: 0,
    fileCount: files.length,
    backupFolder: backupRootDir
  });

  const jobUI = createJobUI(jobId, backupRootDir);
  
  if (jobUI) {
    jobUI.setStatus(`Selected ${labels.length} files. Preparing...`);
  } else {
    setBackupStatus(`Selected ${labels.length} files:\n${sample.join("\n")}${extra}`);
  }
  
  await new Promise((r) => setTimeout(r, 250));
  
  try {
    await backupFromDeviceFiles(files, backupRootDir, sourceRoot, jobUI, jobId);
  } catch (e) {
    if (e.message === "Aborted") return; // Handled in backupFromDeviceFiles
    if (jobUI) {
      jobUI.setStatus(`Failed: ${e.message || e}`);
    } else {
      throw e;
    }
  }
}

const deviceBackupBtn = document.getElementById("deviceBackupBtn");
const deviceBackupDirInput = document.getElementById("deviceBackupDirInput");
const deviceBackupFilesInput = document.getElementById("deviceBackupFilesInput");
const deviceBackupPanel = document.getElementById("deviceBackupPanel");
const deviceBackupBrowseBtn = document.getElementById("deviceBackupBrowseBtn");
const systemDriveBackupBtn = document.getElementById("systemDriveBackupBtn");
const deviceBackupBrowseMode = document.getElementById("deviceBackupBrowseMode");
const deviceBackupStartBtn = document.getElementById("deviceBackupStartBtn");
const deviceBackupClearBtn = document.getElementById("deviceBackupClearBtn");
if (
  deviceBackupBtn &&
  deviceBackupDirInput &&
  deviceBackupFilesInput &&
  deviceBackupPanel &&
  deviceBackupBrowseBtn &&
  systemDriveBackupBtn &&
  deviceBackupBrowseMode &&
  deviceBackupStartBtn &&
  deviceBackupClearBtn
) {
  let stagedBackup = null;
  let isSystemBackup = false;

  function getDeviceName() {
    return (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "device";
  }

  function isSystemFile(file) {
    const name = file.name.toLowerCase();
    const path = (file.webkitRelativePath || "").toLowerCase();
    // Skip common system files that are often locked or huge
    if (name === "hiberfil.sys" || name === "pagefile.sys" || name === "swapfile.sys") return true;
    if (path.includes("/$recycle.bin/") || path.includes("/system volume information/") || path.includes("/windows/")) return true;
    return false;
  }

  function dedupeFiles(files) {
    if (!files || files.length === 0) return [];
    const seen = new Set();
    const result = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (isSystemBackup && isSystemFile(f)) continue;
      const rel = normalizeRelPath(f?.webkitRelativePath || f?.name || "");
      const size = Number(f?.size || 0);
      const lm = Number(f?.lastModified || 0);
      const key = `${rel}::${size}::${lm}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(f);
      }
    }
    return result;
  }

  function setPanelVisible(on) {
    show(deviceBackupPanel, on);
  }

  function updateStagedStatus() {
    const files = stagedBackup?.files || [];
    const count = files.length;
    if (count === 0) {
      setBackupStatus("Select files and/or a folder to back up.");
      return;
    }
    
    // Only process a small sample for the UI label to avoid hanging
    const sampleSize = 12;
    const sampleFiles = files.slice(0, sampleSize);
    const labels = sampleFiles.map(fileLabelForSelection).filter(Boolean);
    const extra = count > sampleSize ? `\n...and ${count - sampleSize} more` : "";
    setBackupStatus(`Selected ${count} files:\n${labels.join("\n")}${extra}`);
  }

  function clearStaged() {
    stagedBackup = null;
    setPanelVisible(false);
    setBackupStatus("");
  }

  deviceBackupBtn.onclick = () => {
    if (!currentUser) {
      alert("Please login first.");
      return;
    }
    // Always start a new backup session
    stagedBackup = { deviceName: getDeviceName(), files: [] };
    setPanelVisible(true);
    updateStagedStatus();
  };

  async function browseAndAddToStaging() {
    if (!stagedBackup) stagedBackup = { deviceName: getDeviceName(), files: [] };
    const mode = String(deviceBackupBrowseMode.value || "files");
    if (mode === "files") {
      if (window.showOpenFilePicker) {
        try {
          const handles = await window.showOpenFilePicker({ multiple: true });
          const picked = [];
          for (const h of handles || []) {
            const f = await h.getFile();
            picked.push(f);
          }
          if (picked.length) {
            stagedBackup.files = stagedBackup.files.concat(picked);
            updateStagedStatus();
          }
          return;
        } catch {
          return;
        }
      }
      deviceBackupFilesInput.click();
      return;
    }
    if (mode === "folder") {
      deviceBackupDirInput.click();
    }
  }

  deviceBackupBrowseBtn.onclick = () => {
    isSystemBackup = false;
    browseAndAddToStaging();
  };

  systemDriveBackupBtn.onclick = () => {
    const ok = confirm(
      "Browser Security Notice:\n\n" +
      "Web browsers block direct access to the root 'C:\\' drive for security reasons.\n\n" +
      "To back up your data, please select your User folder (e.g., C:\\Users\\YourName) in the next window.\n\n" +
      "Click OK to proceed."
    );
    if (!ok) return;
    
    isSystemBackup = true;
    deviceBackupBrowseMode.value = "folder";
    deviceBackupDirInput.click();
  };

  deviceBackupClearBtn.onclick = () => {
    clearStaged();
    isSystemBackup = false;
  };
  deviceBackupStartBtn.onclick = async () => {
    const files = dedupeFiles(stagedBackup?.files || []);
    if (files.length === 0) {
      setBackupStatus("No files selected.");
      return;
    }
    
    // Start the backup job in the background
    runDeviceBackup(files, stagedBackup.deviceName).catch(console.error);
    
    // Immediately clear staging so user can start another job
    clearStaged();
    setBackupStatus("Backup job started. You can start another one.");
  };

  deviceBackupDirInput.onclick = () => {
    // Reset value to ensure onchange fires even if same folder selected
    deviceBackupDirInput.value = "";
  };

  deviceBackupDirInput.onchange = () => {
    console.log("Directory input changed");
    // Access files immediately to ensure we capture them
    const files = Array.from(deviceBackupDirInput.files || []);
    console.log(`Selected ${files.length} files from directory`);
    
    if (files.length === 0) {
      setBackupStatus("No files found. Please try selecting a specific subfolder (e.g. Documents) if the User folder fails.");
      return;
    }

    setBackupStatus(`Processing ${files.length} files...`);
    
    // Use a small timeout to allow the UI to render the "Processing" message
    setTimeout(() => {
        if (!stagedBackup) stagedBackup = { deviceName: getDeviceName(), files: [] };
        stagedBackup.files = stagedBackup.files.concat(files);
        updateStagedStatus();
        // Clear value to allow re-selecting the same folder if needed
        deviceBackupDirInput.value = "";
      }, 50);
  };
  deviceBackupFilesInput.onchange = () => {
    const files = Array.from(deviceBackupFilesInput.files || []);
    deviceBackupFilesInput.value = "";
    if (files.length === 0) return;
    if (!stagedBackup) stagedBackup = { deviceName: getDeviceName(), files: [] };
    stagedBackup.files = stagedBackup.files.concat(files);
    updateStagedStatus();
  };
}

const restoreInput = document.getElementById("restoreFile");
if (restoreInput) {
  restoreInput.disabled = true;
}

const plansBtn = document.getElementById("plansBtn");
const plansPanel = document.getElementById("plansPanel");
const plansStatusEl = document.getElementById("plansStatus");
const plansListEl = document.getElementById("plansList");
const plansCloseBtn = document.getElementById("plansCloseBtn");
if (plansBtn && plansPanel && plansStatusEl && plansListEl && plansCloseBtn) {
  function setPlansVisible(on) {
    show(plansPanel, Boolean(on));
  }

  function setPlansStatus(msg) {
    plansStatusEl.textContent = msg || "";
  }

  let stripeStatus = { configured: false, publishableKey: "", googlePayMerchantId: "", googlePayEnvironment: "TEST" };

  function renderPlans(plans, current) {
    plansListEl.innerHTML = "";
    const currentPlanId = current?.planId || null;
    const currentQuotaGb = fmtQuotaGb(Number(current?.quotaBytes || 0));
    const header = document.createElement("div");
    header.className = "hint";
    header.textContent = `Current: ${currentPlanId || "none"} (${currentQuotaGb || "0.00"} GB)`;
    plansListEl.appendChild(header);

    (plans || []).forEach((p) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "10px";
      row.style.padding = "6px 2px";
      row.style.borderTop = "1px solid #eee";

      const left = document.createElement("div");
      left.textContent = `${p.name}`;

      const btn = document.createElement("button");
      btn.className = "btn primary";
      btn.textContent = currentPlanId === p.id ? "Current" : "Purchase";
      btn.disabled = currentPlanId === p.id;
      btn.onclick = async () => {
        try {
          btn.disabled = true;
          setPlansStatus("Redirecting to payment...");
          const r = await fetch("/api/payments/stripe/create-checkout-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planId: p.id })
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok && data.url) {
            window.location.href = data.url;
            return;
          }
          const fallback = await fetch("/api/plans/purchase", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planId: p.id })
          });
          const fb = await fallback.json().catch(() => ({}));
          if (!fallback.ok || !fb.ok) {
            setPlansStatus(fb.error || data.error || "Purchase failed.");
            btn.disabled = false;
            return;
          }
          setPlansStatus("Plan activated. Quota updated.");
          const rr = await fetch("/api/plans");
          const dd = await rr.json().catch(() => ({}));
          if (rr.ok && dd.ok) renderPlans(dd.plans, dd.current);
        } catch (e) {
          setPlansStatus(String(e?.message || e || "Purchase failed."));
          btn.disabled = false;
        }
      };

      const gPayBtnWrap = document.createElement("div");
      gPayBtnWrap.id = `gPayBtn_${p.id}`;
      gPayBtnWrap.style.marginTop = "4px";

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.flexDirection = "column";
      right.style.alignItems = "flex-end";
      right.appendChild(btn);
      right.appendChild(gPayBtnWrap);

      row.appendChild(left);
      row.appendChild(right);
      plansListEl.appendChild(row);

      if (currentPlanId !== p.id) {
        initGooglePayForPlan(p, gPayBtnWrap);
      }
    });
  }

  function initGooglePayForPlan(plan, container) {
    if (typeof google === "undefined" || !google.payments || !google.payments.api) return;
    const paymentsClient = new google.payments.api.PaymentsClient({ environment: stripeStatus.googlePayEnvironment || "TEST" });
    const button = paymentsClient.createButton({
      onClick: () => onGooglePayButtonClicked(plan),
      buttonSizeMode: "fill"
    });
    container.appendChild(button);
  }

  async function onGooglePayButtonClicked(plan) {
    const paymentsClient = new google.payments.api.PaymentsClient({ environment: stripeStatus.googlePayEnvironment || "TEST" });
    const paymentDataRequest = {
      apiVersion: 2,
      apiVersionMinor: 0,
      allowedPaymentMethods: [
        {
          type: "CARD",
          parameters: {
            allowedAuthMethods: ["PAN_ONLY", "CRYPTOGRAM_3DS"],
            allowedCardNetworks: ["AMEX", "DISCOVER", "INTERAC", "JCB", "MASTERCARD", "VISA"]
          },
          tokenizationSpecification: {
            type: "PAYMENT_GATEWAY",
            parameters: {
              gateway: "stripe",
              "stripe:version": "2024-04-10",
              "stripe:publishableKey": stripeStatus.publishableKey || "pk_test_TYooMQauvdEDq54NiTphI7jx"
            }
          }
        }
      ],
      merchantInfo: { 
        merchantId: stripeStatus.googlePayMerchantId || "12345678901234567890", 
        merchantName: "Local Storage App" 
      },
      transactionInfo: {
        totalPriceStatus: "FINAL",
        totalPriceLabel: "Total",
        totalPrice: (plan.priceMonthlyCents / 100).toFixed(2),
        currencyCode: stripeStatus.currency?.toUpperCase() || "USD",
        countryCode: "US"
      }
    };

    try {
      const paymentData = await paymentsClient.loadPaymentData(paymentDataRequest);
      const token = JSON.parse(paymentData.paymentMethodData.tokenizationData.token).id;
      setPlansStatus("Processing Google Pay payment...");
      const r = await fetch("/api/payments/gpay/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, planId: plan.id })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        setPlansStatus(data.error || "Payment failed.");
        return;
      }
      setPlansStatus("Payment successful! Plan activated.");
      const rr = await fetch("/api/plans");
      const dd = await rr.json().catch(() => ({}));
      if (rr.ok && dd.ok) renderPlans(dd.plans, dd.current);
    } catch (err) {
      console.error("Google Pay Error:", err);
      if (err.statusCode === "CANCELED") {
        setPlansStatus("");
      } else if (err.statusMessage && err.statusMessage.includes("OR_BIBED_11")) {
        setPlansStatus("Google Pay: Merchant registration incomplete for PRODUCTION. Check Google Pay Console.");
        console.warn("OR_BIBED_11 typically means the merchant account hasn't been approved for PRODUCTION web access yet.");
      } else {
        setPlansStatus(`Google Pay failed: ${err.statusMessage || "Unknown error"}`);
      }
    }
  }

  window.onGooglePayLoaded = async () => {
    if (typeof google === "undefined" || !google.payments || !google.payments.api) return;
    const paymentsClient = new google.payments.api.PaymentsClient({ environment: "TEST" });
    const isReadyToPayRequest = {
      apiVersion: 2,
      apiVersionMinor: 0,
      allowedPaymentMethods: [
        {
          type: "CARD",
          parameters: {
            allowedAuthMethods: ["PAN_ONLY", "CRYPTOGRAM_3DS"],
            allowedCardNetworks: ["AMEX", "DISCOVER", "INTERAC", "JCB", "MASTERCARD", "VISA"]
          }
        }
      ]
    };
    try {
      const response = await paymentsClient.isReadyToPay(isReadyToPayRequest);
      if (response.result) {
        console.log("Google Pay is ready.");
      }
    } catch (err) {
      console.error("Google Pay isReadyToPay error:", err);
    }
  };

  async function loadPlans() {
    const sr = await fetch("/api/payments/stripe/status");
    const sd = await sr.json().catch(() => ({}));
    stripeStatus = sd;
    if (sr.ok && sd.ok && sd.requirePaymentForPlans && !sd.configured) {
      plansListEl.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "hint";
      msg.textContent = "Stripe is not configured on the server. Set STRIPE_SECRET_KEY in .env and restart.";
      plansListEl.appendChild(msg);
      throw new Error("Stripe is not configured");
    }
    const r = await fetch("/api/plans");
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "Failed to load plans");
    renderPlans(data.plans || [], data.current || {});
  }

  plansBtn.onclick = async () => {
    if (!currentUser) {
      alert("Please login first.");
      return;
    }
    setPlansVisible(plansPanel.classList.contains("hidden"));
    if (!plansPanel.classList.contains("hidden")) {
      try {
        setPlansStatus("Loading plans...");
        await loadPlans();
        setPlansStatus("");
      } catch (e) {
        setPlansStatus(String(e?.message || e || "Failed to load plans."));
      }
    }
  };

  plansCloseBtn.onclick = () => {
    setPlansVisible(false);
    setPlansStatus("");
    plansListEl.innerHTML = "";
  };
}

const adminBtn = document.getElementById("adminBtn");
const adminPanel = document.getElementById("adminPanel");
const adminTokenInput = document.getElementById("adminToken");
const adminLoadUsersBtn = document.getElementById("adminLoadUsersBtn");
const adminUserSearchInput = document.getElementById("adminUserSearch");
const adminSearchBtn = document.getElementById("adminSearchBtn");
const adminStatusEl = document.getElementById("adminStatus");
const adminUsersEl = document.getElementById("adminUsers");
const adminUserSelect = document.getElementById("adminUserSelect");
const adminQuotaGbInput = document.getElementById("adminQuotaGb");
const adminSetQuotaBtn = document.getElementById("adminSetQuotaBtn");
const adminCloseBtn = document.getElementById("adminCloseBtn");

if (
  adminBtn &&
  adminPanel &&
  adminTokenInput &&
  adminLoadUsersBtn &&
  adminUserSearchInput &&
  adminSearchBtn &&
  adminStatusEl &&
  adminUsersEl &&
  adminUserSelect &&
  adminQuotaGbInput &&
  adminSetQuotaBtn &&
  adminCloseBtn
) {
  let adminUsers = [];
  let adminDefaultQuotaBytes = 0;
  let adminFilteredUsers = [];
  let selectedAdminUserId = "";

  function setAdminPanelVisible(on) {
    show(adminPanel, Boolean(on));
  }

  function setAdminStatus(msg) {
    adminStatusEl.textContent = msg || "";
  }

  function getAdminToken() {
    const raw = String(adminTokenInput.value || "").trim();
    try {
      if (raw) sessionStorage.setItem("adminToken", raw);
    } catch {}
    return raw;
  }

  function loadAdminToken() {
    try {
      const t = sessionStorage.getItem("adminToken");
      if (t) adminTokenInput.value = t;
    } catch {}
  }

  function renderAdminUsersTable(defaultQuotaBytes) {
    adminUsersEl.innerHTML = "";
    const list = adminFilteredUsers.length ? adminFilteredUsers : adminUsers;
    if (!list.length) {
      const el = document.createElement("div");
      el.className = "hint";
      el.textContent = "No users.";
      adminUsersEl.appendChild(el);
      return;
    }
    const header = document.createElement("div");
    header.className = "hint";
    header.textContent = `Default quota: ${fmtQuotaGb(defaultQuotaBytes)} GB`;
    adminUsersEl.appendChild(header);

    list.forEach((u) => {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "1fr 200px 110px";
      row.style.gap = "8px";
      row.style.padding = "4px 2px";
      row.style.borderTop = "1px solid #eee";
      row.style.cursor = "pointer";
      const isSelected = selectedAdminUserId && u.id === selectedAdminUserId;
      if (isSelected) row.style.background = "#e8f4fd";
      row.onclick = () => {
        selectedAdminUserId = u.id;
        adminUserSelect.value = u.id;
        adminQuotaGbInput.value = String(Math.max(1, Math.round(Number(fmtQuotaGb(u.quotaBytes)) || 1)));
        renderAdminUsersTable(defaultQuotaBytes);
      };

      const name = document.createElement("div");
      name.textContent = u.email || u.name || u.id;

      const quota = document.createElement("div");
      quota.textContent = `${fmtQuotaGb(u.quotaBytes)} GB${u.hasCustomQuota ? "" : " (default)"}`;

      const id = document.createElement("div");
      id.textContent = String(u.id).slice(0, 8);
      id.title = u.id;

      row.appendChild(name);
      row.appendChild(quota);
      row.appendChild(id);
      adminUsersEl.appendChild(row);
    });
  }

  function renderAdminUserSelect() {
    adminUserSelect.innerHTML = "";
    const list = adminFilteredUsers.length ? adminFilteredUsers : adminUsers;
    list.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.email || u.name || u.id;
      adminUserSelect.appendChild(opt);
    });
    if (selectedAdminUserId && list.some((u) => u.id === selectedAdminUserId)) {
      adminUserSelect.value = selectedAdminUserId;
    } else if (adminUserSelect.options.length) {
      selectedAdminUserId = adminUserSelect.value;
    }
  }

  function applyAdminUserFilter() {
    const q = String(adminUserSearchInput.value || "").trim().toLowerCase();
    if (!q) {
      adminFilteredUsers = [];
      renderAdminUserSelect();
      renderAdminUsersTable(adminDefaultQuotaBytes);
      return;
    }
    adminFilteredUsers = adminUsers.filter((u) => {
      const hay = `${u.email || ""} ${u.name || ""} ${u.id || ""}`.toLowerCase();
      return hay.includes(q);
    });
    renderAdminUserSelect();
    renderAdminUsersTable(adminDefaultQuotaBytes);
    setAdminStatus(`Matched ${adminFilteredUsers.length} users.`);
  }

  async function fetchAdminUsers() {
    const token = getAdminToken();
    if (!token) throw new Error("Admin token required");
    const r = await fetch("/api/admin/users", { headers: { "x-admin-token": token } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "Failed to load users");
    adminUsers = Array.isArray(data.users) ? data.users : [];
    adminDefaultQuotaBytes = Number(data.defaultQuotaBytes || 0);
    adminFilteredUsers = [];
    selectedAdminUserId = "";
    renderAdminUserSelect();
    renderAdminUsersTable(adminDefaultQuotaBytes);
  }

  async function setUserQuota(userId, quotaGb) {
    const token = getAdminToken();
    if (!token) throw new Error("Admin token required");
    const r = await fetch("/api/admin/quota", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": token },
      body: JSON.stringify({ userId, quotaGb })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "Failed to update quota");
  }

  adminBtn.onclick = () => {
    if (!currentUser) {
      alert("Please login first.");
      return;
    }
    loadAdminToken();
    setAdminPanelVisible(adminPanel.classList.contains("hidden"));
    setAdminStatus("");
  };

  adminCloseBtn.onclick = () => {
    setAdminPanelVisible(false);
    setAdminStatus("");
  };

  adminLoadUsersBtn.onclick = async () => {
    try {
      adminLoadUsersBtn.disabled = true;
      setAdminStatus("Loading...");
      await fetchAdminUsers();
      setAdminStatus(`Loaded ${adminUsers.length} users.`);
    } catch (e) {
      setAdminStatus(String(e?.message || e || "Failed to load users."));
    } finally {
      adminLoadUsersBtn.disabled = false;
    }
  };

  adminUserSelect.onchange = () => {
    selectedAdminUserId = String(adminUserSelect.value || "");
    const u = adminUsers.find((x) => x.id === selectedAdminUserId) || null;
    if (u) {
      adminQuotaGbInput.value = String(Math.max(1, Math.round(Number(fmtQuotaGb(u.quotaBytes)) || 1)));
      renderAdminUsersTable(adminDefaultQuotaBytes);
    }
  };

  adminSearchBtn.onclick = () => {
    applyAdminUserFilter();
  };
  adminUserSearchInput.onkeydown = (e) => {
    if (e.key === "Enter") applyAdminUserFilter();
  };

  adminSetQuotaBtn.onclick = async () => {
    const userId = String(adminUserSelect.value || "").trim();
    const quotaGb = Number(adminQuotaGbInput.value);
    if (!userId) {
      alert("Select a user.");
      return;
    }
    if (!Number.isFinite(quotaGb) || quotaGb <= 0) {
      alert("Enter a valid quota in GB.");
      return;
    }
    try {
      adminSetQuotaBtn.disabled = true;
      setAdminStatus("Updating quota...");
      await setUserQuota(userId, quotaGb);
      await fetchAdminUsers();
      setAdminStatus("Quota updated.");
    } catch (e) {
      setAdminStatus(String(e?.message || e || "Failed to update quota."));
    } finally {
      adminSetQuotaBtn.disabled = false;
    }
  };
}

async function loadMe() {
  try {
    const r = await fetch("/api/me");
    if (!r.ok) {
      currentUser = null;
      applyAuthState();
      return;
    }
    const data = await r.json().catch(() => ({ ok: false }));
    currentUser = data.ok ? data.user : null;
    applyAuthState();
    if (currentUser) setAuthMsg("");
  } catch (e) {
    console.error("loadMe failed:", e);
    currentUser = null;
    applyAuthState();
  }
}

async function loadProviders() {
  try {
    const r = await fetch("/api/auth/providers");
    const data = await r.json();
    authProviders = data?.providers || authProviders;
  } catch {
    authProviders = authProviders;
  }
  applyProviderState();
}

async function loadStorageProviders() {
  try {
    const r = await fetch("/api/storage/providers");
    const data = await r.json();
    storageProviders = data?.providers || storageProviders;
  } catch {
    storageProviders = storageProviders;
  }
  applyStorageState();
}

async function loadStorageMode() {
  if (!currentUser) return;
  try {
    const r = await fetch("/api/storage/mode");
    const data = await r.json();
    if (data?.ok && (data.mode === "local" || data.mode === "cloud")) storageMode = data.mode;
  } catch {
    storageMode = "local";
  }
  applyStorageState();
}

async function loadShares() {
  if (!currentUser) return;
  try {
    const r = await fetch("/api/shares");
    const data = await r.json();
    if (data?.ok) {
      sharesCache = {
        owned: Array.isArray(data.owned) ? data.owned : [],
        received: Array.isArray(data.received) ? data.received : []
      };
    }
  } catch {
    sharesCache = { owned: [], received: [] };
  }
}

async function loadAllUsers() {
  if (!currentUser) return;
  try {
    const r = await fetch("/api/users");
    const data = await r.json();
    if (data?.ok && Array.isArray(data.users)) {
      allUsers = data.users;
    }
  } catch {
    allUsers = [];
  }
}

function applyViewTabs() {
  const tabMy = document.getElementById("tabMy");
  const tabJobs = document.getElementById("tabJobs");
  const jobsPanel = document.getElementById("jobsPanel");
  const storageBrowser = document.getElementById("storageBrowser");

  if (tabMy && tabJobs) {
    tabMy.classList.toggle("primary", viewMode === "own");
    tabJobs.classList.toggle("primary", viewMode === "jobs");
  }

  if (jobsPanel && storageBrowser) {
    show(jobsPanel, viewMode === "jobs");
    show(storageBrowser, viewMode !== "jobs");
  }

  const bulkShareToUserBtn = document.getElementById("bulkShareToUserBtn");
  if (bulkShareToUserBtn) show(bulkShareToUserBtn, viewMode === "own");
  const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");
  if (bulkDeleteBtn) show(bulkDeleteBtn, viewMode === "own");
}

const tabJobsBtn = document.getElementById("tabJobs");
if (tabJobsBtn) {
  tabJobsBtn.onclick = () => {
    if (!currentUser) return;
    viewMode = "jobs";
    currentShare = null;
    currentPath = "";
    applyViewTabs();
    saveState();
    renderPersistedJobs();
  };
}

function readAuthError() {
  const params = new URLSearchParams(window.location.search || "");
  const err = params.get("authError");
  if (err === "google_not_configured") {
    setAuthMsg("Google login is not configured on the server.");
  }
}

const tabCloudBtn = document.getElementById("tabCloud");
if (tabCloudBtn) {
  tabCloudBtn.onclick = async () => {
    if (!currentUser) return;
    if (storageMode === "cloud") {
      viewMode = "own";
      currentShare = null;
      currentPath = "";
      applyStorageState();
      applyViewTabs();
      saveState();
      await list();
      return;
    }
    const r = await fetch("/api/storage/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "cloud" })
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      alert(data.error || "Failed to switch storage mode.");
      return;
    }
    storageMode = data.mode;
    viewMode = "own";
    currentShare = null;
    currentPath = "";
    applyStorageState();
    applyViewTabs();
    saveState();
    await list();
  };
}

document.getElementById("loginBtn").onclick = async () => {
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  setAuthMsg("");
  const r = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) {
    setAuthMsg(data.error || "Login failed");
    return;
  }
  await loadMe();
  await loadStorageProviders();
  await loadStorageMode();
  await loadShares();
  await loadAllUsers();
  viewMode = "own";
  currentShare = null;
  currentPath = "";
  applyViewTabs();
  saveState();
  await list();
};

document.getElementById("registerBtn").onclick = async () => {
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  const name = document.getElementById("name").value;
  setAuthMsg("");
  const r = await fetch("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name })
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) {
    setAuthMsg(data.error || "Register failed");
    return;
  }
  await loadMe();
  await loadStorageProviders();
  await loadStorageMode();
  await loadShares();
  await loadAllUsers();
  currentPath = "";
  await list();
};

document.getElementById("logoutBtn").onclick = async () => {
  await fetch("/auth/logout", { method: "POST" });
  currentUser = null;
  currentPath = "";
  applyAuthState();
  storageMode = "local";
  applyStorageState();
  setAuthMsg("Logged out.");
};

async function handleStripeCheckoutReturn() {
  const params = new URLSearchParams(window.location.search || "");
  const isSuccess = params.get("stripeSuccess") === "1";
  const sessionId = params.get("session_id");
  if (!isSuccess || !sessionId || !currentUser) return;
  try {
    setBackupStatus("Confirming payment...");
    setBackupProgressIndeterminate("Confirming payment...");
    const r = await fetch("/api/payments/stripe/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      clearBackupProgress();
      setBackupStatus(data.error || "Payment confirmation failed.");
      return;
    }
    clearBackupProgress();
    setBackupStatus("Payment confirmed. Plan activated.");
    setTimeout(() => setBackupStatus(""), 5000);
  } finally {
    params.delete("stripeSuccess");
    params.delete("session_id");
    params.delete("stripeCancel");
    const next = `${window.location.pathname}${params.toString() ? "?" + params.toString() : ""}${window.location.hash || ""}`;
    window.history.replaceState({}, "", next);
  }
}

(async () => {
  try {
    readAuthError();
    await loadProviders();
    await loadMe();
    await handleStripeCheckoutReturn();
    await loadStorageProviders();
    await loadStorageMode();
    await loadShares();
    await loadAllUsers();
    
    // Persistence logic for backup jobs
    const jobs = getPersistedJobs();
    const interrupted = jobs.map(j => j.status === "running" ? { ...j, status: "interrupted" } : j);
    savePersistedJobs(interrupted);

    if (currentUser) {
      loadStateFromStorage();
      // Sync desired storageMode with server session
      if (storageMode === "cloud") {
        try {
          const r = await fetch("/api/storage/mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "cloud" })
          });
          const data = await r.json().catch(() => ({}));
          if (!data.ok) {
            storageMode = "local";
          } else {
            storageMode = data.mode;
          }
        } catch {
          storageMode = "local";
        }
      }
    }
  } catch (e) {
    console.error("Initialization error:", e);
  } finally {
    applyAuthState();
    applyStorageState();
    applyViewTabs();
    if (currentUser) list().catch(console.error);
  }
})();

window.addEventListener("beforeunload", (e) => {
  const jobs = getPersistedJobs();
  const running = jobs.some((j) => j.status === "running");
  if (running) {
    e.preventDefault();
    e.returnValue = "Backup jobs are currently running. Leaving this page will interrupt them.";
    return e.returnValue;
  }
});

const tabMyBtn = document.getElementById("tabMy");
if (tabMyBtn) {
  tabMyBtn.onclick = async () => {
    if (!currentUser) return;
    viewMode = "own";
    currentShare = null;
    currentPath = "";
    applyViewTabs();
    saveState();
    await list();
  };
}

const selectAllCb = document.getElementById("selectAll");
if (selectAllCb) {
  selectAllCb.onchange = () => {
    const tbody = document.getElementById("list");
    const boxes = tbody ? tbody.querySelectorAll('input[type="checkbox"]') : [];
    selectedItems = new Set();
    boxes.forEach((cb) => {
      cb.checked = selectAllCb.checked;
      const rel = cb.dataset && cb.dataset.rel;
      if (cb.checked && rel) selectedItems.add(rel);
    });
  };
}

const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");
if (bulkDeleteBtn) {
  bulkDeleteBtn.onclick = async () => {
    if (!currentUser) {
      alert("Please login first.");
      return;
    }
    if (viewMode !== "own") {
      alert("Bulk delete is only available in My Storage.");
      return;
    }
    const paths = Array.from(selectedItems || []);
    if (!paths.length) {
      alert("Please select at least one item to delete.");
      return;
    }
    const ok = confirm(`Delete ${paths.length} selected item(s)?`);
    if (!ok) return;
    const ordered = paths.slice().sort((a, b) => b.length - a.length);
    try {
      bulkDeleteBtn.disabled = true;
      const all = document.getElementById("selectAll");
      if (all) all.checked = false;
      setBackupProgressDeterminate(0, ordered.length, `0 / ${ordered.length}`);
      for (let i = 0; i < ordered.length; i++) {
        const p = ordered[i];
        setBackupStatus(`Deleting ${i + 1}/${ordered.length}: ${p}`);
        setBackupProgressDeterminate(i, ordered.length, `${i} / ${ordered.length}`);
        await fetch("/api/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: p })
        });
      }
      setBackupProgressDeterminate(ordered.length, ordered.length, `${ordered.length} / ${ordered.length}`);
      selectedItems = new Set();
      setBackupStatus("Delete completed.");
      setTimeout(() => setBackupStatus(""), 2000);
      setTimeout(() => clearBackupProgress(), 1000);
      await list();
    } catch (e) {
      clearBackupProgress();
      setBackupStatus(String(e?.message || e || "Bulk delete failed."));
    } finally {
      bulkDeleteBtn.disabled = false;
    }
  };
}

const bulkShareBtn = document.getElementById("bulkShareBtn");
const bulkShareOptionsEl = document.getElementById("bulkShareOptions");
if (bulkShareBtn && bulkShareOptionsEl) {
  bulkShareBtn.onclick = () => {
    if (!currentUser) {
      alert("Please login first.");
      return;
    }
    if (storageMode !== "cloud") {
      alert("Sharing is only available in Cloud storage.");
      return;
    }
    if (!selectedItems.size) {
      alert("Please select at least one file to share.");
      return;
    }
    // Show/highlight the sharing options subset (toggle visibility)
    const willShow = bulkShareOptionsEl.classList.contains("hidden");
    bulkShareOptionsEl.classList.toggle("hidden", !willShow);

    // When showing, start/refresh an auto-hide timer (2 seconds)
    if (willShow) {
      if (bulkShareHideTimer) {
        clearTimeout(bulkShareHideTimer);
      }
      bulkShareHideTimer = setTimeout(() => {
        bulkShareOptionsEl.classList.add("hidden");
        bulkShareHideTimer = null;
      }, 2000);
    } else if (bulkShareHideTimer) {
      clearTimeout(bulkShareHideTimer);
      bulkShareHideTimer = null;
    }
  };
}

const bulkShareToUserBtn = document.getElementById("bulkShareToUserBtn");
if (bulkShareToUserBtn) {
  bulkShareToUserBtn.onclick = async () => {
    if (!currentUser || !selectedItems.size) {
      alert("Please select at least one file to share.");
      return;
    }
    if (!allUsers.length) {
      await loadAllUsers();
    }
    const candidates = allUsers.filter((u) => u.id !== currentUser.id);
    if (!candidates.length) {
      alert("No other users found to share with.");
      return;
    }
    const list = candidates
      .map((u, idx) => `${idx + 1}. ${u.email || u.name || u.id}`)
      .join("\n");
    const choiceStr = (prompt(`Select a user to share with:\n\n${list}`) || "").trim();
    const choice = parseInt(choiceStr, 10);
    if (!choice || choice < 1 || choice > candidates.length) return;
    const target = candidates[choice - 1];
    const email = (target.email || "").trim();
    if (!email) {
      alert("Selected user has no email set.");
      return;
    }
    const accessInput = (prompt('Enter access level for all selected: "read" or "write" (default: read):') || "")
      .trim()
      .toLowerCase();
    const access = accessInput === "write" ? "write" : "read";
    const paths = Array.from(selectedItems);
    let okCount = 0;
    for (const p of paths) {
      try {
        const r = await fetch("/api/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: p, email, access })
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) okCount++;
      } catch {
        // ignore
      }
    }
    alert(`Shared ${okCount} of ${paths.length} items with ${email} (${access}).`);
    if (bulkShareOptionsEl) bulkShareOptionsEl.classList.add("hidden");
    if (bulkShareHideTimer) {
      clearTimeout(bulkShareHideTimer);
      bulkShareHideTimer = null;
    }
  };
}

function buildSelectedLinks() {
  const paths = Array.from(selectedItems || []);
  if (!paths.length) {
    alert("Please select at least one file first.");
    return null;
  }
  const baseUrl = window.location.origin;
  if (viewMode === "shared" && currentShare) {
    return paths
      .map((p) => `${baseUrl}/api/shared/download?shareId=${encodeURIComponent(currentShare.id)}&path=${encodeURIComponent(p)}`)
      .join("\n");
  }
  return paths.map((p) => `${baseUrl}/api/download?path=${encodeURIComponent(p)}`).join("\n");
}

const bulkCopyLinksBtn = document.getElementById("bulkCopyLinksBtn");
if (bulkCopyLinksBtn) {
  bulkCopyLinksBtn.onclick = async () => {
    if (!currentUser) {
      alert("Please login first.");
      return;
    }
    const links = buildSelectedLinks();
    if (!links) return;
    const copied = await copyToClipboard(links);
    alert(copied ? "Links copied to clipboard." : "Could not copy links. Please copy manually:\n\n" + links);
    if (bulkShareOptionsEl) bulkShareOptionsEl.classList.add("hidden");
    if (bulkShareHideTimer) {
      clearTimeout(bulkShareHideTimer);
      bulkShareHideTimer = null;
    }
  };
}

const bulkEmailBtn = document.getElementById("bulkEmailBtn");
if (bulkEmailBtn) {
  bulkEmailBtn.onclick = () => {
    if (!currentUser) {
      alert("Please login first.");
      return;
    }
    const links = buildSelectedLinks();
    if (!links) return;
    const subject = encodeURIComponent("Shared files");
    const body = encodeURIComponent(`Here are the links to the files:\n\n${links}`);
    const mailtoUrl = `mailto:?subject=${subject}&body=${body}`;
    window.open(mailtoUrl, "_blank", "noopener,noreferrer");
    if (bulkShareOptionsEl) bulkShareOptionsEl.classList.add("hidden");
    if (bulkShareHideTimer) {
      clearTimeout(bulkShareHideTimer);
      bulkShareHideTimer = null;
    }
  };
}

const bulkWhatsAppBtn = document.getElementById("bulkWhatsAppBtn");
if (bulkWhatsAppBtn) {
  bulkWhatsAppBtn.onclick = () => {
    if (!currentUser) {
      alert("Please login first.");
      return;
    }
    const links = buildSelectedLinks();
    if (!links) return;
    const text = encodeURIComponent(`Shared files:\n${links}`);
    window.open(`https://wa.me/?text=${text}`, "_blank");
    if (bulkShareOptionsEl) bulkShareOptionsEl.classList.add("hidden");
    if (bulkShareHideTimer) {
      clearTimeout(bulkShareHideTimer);
      bulkShareHideTimer = null;
    }
  };
}
