// ID4 frontend. Vanilla JS, no framework, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  format: "mp4",
  quality: "best",
  embedThumbnail: false,
  embedMetadata: true,
  embedSubs: false,
  activeJobs: new Set(),
  pollTimer: null,
  infoDebounce: null,
  infoToken: 0,        // monotonic counter so old fetches don't overwrite newer
  lastUrl: "",
  history: [],
  jobs: [],
  openMenuFor: null,   // history id with open menu
};

const QUALITY_OPTIONS = {
  mp4: [
    { value: "best", label: "Best available" },
    { value: "2160", label: "2160p (4K)" },
    { value: "1440", label: "1440p (2K)" },
    { value: "1080", label: "1080p" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
    { value: "360", label: "360p" },
  ],
  mp3: [
    { value: "320", label: "320 kbps" },
    { value: "256", label: "256 kbps" },
    { value: "192", label: "192 kbps (default)" },
    { value: "128", label: "128 kbps" },
    { value: "96",  label: "96 kbps" },
  ],
};

// ---------------------------------------------------------------------------
// Theme, respects system preference, persists user override
// ---------------------------------------------------------------------------

function initTheme() {
  const saved = localStorage.getItem("crytdl-theme");
  if (saved) {
    document.documentElement.dataset.theme = saved;
  } else if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    document.documentElement.dataset.theme = "light";
  }
  $("#themeToggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("crytdl-theme", next);
  });
}

// ---------------------------------------------------------------------------
// URL detection (mirrors spotify.py / yt-dlp domain coverage)
// ---------------------------------------------------------------------------

function isLikelyYouTube(s) {
  return /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(s);
}
function isLikelySpotify(s) {
  return /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:track|album|playlist|episode)\/|spotify:(?:track|album|playlist|episode):)/i.test(s);
}
function detectSource(s) {
  if (isLikelySpotify(s)) return "spotify";
  if (isLikelyYouTube(s)) return "youtube";
  return null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtDuration(secs) {
  if (!secs) return "";
  const s = Math.round(secs);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  if (m < 60) return `${m}:${ss}`;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${h}:${mm}:${ss}`;
}

function fmtBytes(b) {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 10 ? 0 : 1)} ${u[i]}`;
}

function fmtAgo(ts) {
  if (!ts) return "";
  const s = Math.round(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function spanText(text) {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}

// ---------------------------------------------------------------------------
// Quality dropdown + format
// ---------------------------------------------------------------------------

function renderQuality() {
  const sel = $("#qualitySelect");
  sel.innerHTML = "";
  for (const opt of QUALITY_OPTIONS[state.format]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  state.quality = state.format === "mp4" ? "best" : "192";
  sel.value = state.quality;
}

function setFormat(fmt) {
  if (state.format === fmt) return;
  state.format = fmt;
  $$(".seg-btn").forEach((b) => {
    const active = b.dataset.format === fmt;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  renderQuality();
}

// ---------------------------------------------------------------------------
// URL preview
// ---------------------------------------------------------------------------

function setSourceIcon(source) {
  $("#urlPrefix").dataset.source = source || "";
}

function showSkeleton() {
  $("#previewZone").innerHTML = `
    <div class="skel">
      <div class="skel-thumb"></div>
      <div class="skel-meta">
        <div class="skel-line"></div>
        <div class="skel-line short"></div>
      </div>
    </div>`;
}

function clearPreview() {
  $("#previewZone").innerHTML = "";
}

function renderPreview(info, source) {
  if (!info || info.error) {
    clearPreview();
    return;
  }
  const subBits = [info.uploader, info.album, fmtDuration(info.duration)].filter(Boolean);
  const sourceIcon = source === "spotify"
    ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true"><path d="M12.0002 2C6.47735 2 2 6.47723 2 12.0001C2 17.5231 6.47735 22 12.0002 22C17.5236 22 22.0005 17.5231 22.0005 12.0001C22.0005 6.47759 17.5236 2.00048 12.0001 2.00048L12.0002 2ZM16.5862 16.423C16.4071 16.7167 16.0226 16.8099 15.7288 16.6295C13.3809 15.1954 10.4251 14.8706 6.94414 15.6659C6.60871 15.7423 6.27434 15.5321 6.19792 15.1966C6.12113 14.861 6.33047 14.5266 6.66674 14.4502C10.4761 13.5796 13.7436 13.9546 16.3796 15.5656C16.6734 15.7459 16.7665 16.1292 16.5862 16.423ZM17.8102 13.6997C17.5845 14.0669 17.1045 14.1827 16.7379 13.957C14.0498 12.3044 9.95233 11.826 6.7729 12.7911C6.36056 12.9156 5.92506 12.6832 5.79991 12.2716C5.67572 11.8593 5.90822 11.4246 6.31984 11.2992C9.95161 10.1973 14.4666 10.731 17.5535 12.6279C17.9201 12.8536 18.0359 13.3336 17.8102 13.6997ZM17.9153 10.8643C14.6923 8.94996 9.37472 8.77394 6.29751 9.70789C5.80337 9.85775 5.28081 9.5788 5.13106 9.08466C4.98132 8.59028 5.26003 8.06808 5.75453 7.91785C9.28695 6.84551 15.1592 7.05269 18.8699 9.25554C19.3153 9.51933 19.461 10.0934 19.1971 10.5372C18.9344 10.9817 18.3588 11.1282 17.9158 10.8643H17.9153Z" fill="currentColor"/></svg>`
    : `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M20.2043 4.00776C21.1084 4.28763 21.8189 5.10925 22.0609 6.15475C22.4982 8.04786 22.5 12 22.5 12C22.5 12 22.5 15.9522 22.0609 17.8453C21.8189 18.8908 21.1084 19.7124 20.2043 19.9922C18.5673 20.5 12 20.5 12 20.5C12 20.5 5.43274 20.5 3.79568 19.9922C2.89159 19.7124 2.1811 18.8908 1.93908 17.8453C1.5 15.9522 1.5 12 1.5 12C1.5 12 1.5 8.04786 1.93908 6.15475C2.1811 5.10925 2.89159 4.28763 3.79568 4.00776C5.43274 3.5 12 3.5 12 3.5C12 3.5 18.5673 3.5 20.2043 4.00776ZM15.5134 12.0003L9.79785 15.2999V8.70065L15.5134 12.0003Z" fill="currentColor"/></svg>`;

  $("#previewZone").innerHTML = `
    <div class="preview">
      <div class="preview-thumb-wrap">
        <img class="preview-thumb" src="${escapeAttr(info.thumbnail || "")}" alt="" />
        <span class="preview-source">${sourceIcon}</span>
      </div>
      <div class="preview-meta">
        <div class="preview-title">${escapeHtml(info.title || "")}</div>
        <div class="preview-sub">${escapeHtml(subBits.join(" · "))}</div>
      </div>
    </div>`;
}

function applySourceConstraints(source) {
  setSourceIcon(source);
  const notice = $("#spotifyNotice");
  if (source === "spotify") {
    notice.hidden = false;
    setFormat("mp3");
    $$(".seg-btn").forEach((b) => (b.disabled = b.dataset.format !== "mp3"));
  } else {
    notice.hidden = true;
    $$(".seg-btn").forEach((b) => (b.disabled = false));
  }
}

async function fetchInfo(url, token) {
  try {
    const r = await fetch("/api/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (token !== state.infoToken) return null; // user typed something newer
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function debouncePreview() {
  clearTimeout(state.infoDebounce);
  const url = $("#urlInput").value.trim();
  $("#clearBtn").hidden = !url;
  state.lastUrl = url;
  const source = detectSource(url);
  applySourceConstraints(source);
  if (!source) {
    clearPreview();
    return;
  }
  showSkeleton();
  const token = ++state.infoToken;
  state.infoDebounce = setTimeout(async () => {
    const info = await fetchInfo(url, token);
    if (token !== state.infoToken) return;
    if (info && !info.error) renderPreview(info, source);
    else clearPreview();
  }, 350);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function startDownload() {
  const url = $("#urlInput").value.trim();
  if (!url) {
    toast("Paste a YouTube or Spotify link first.", { type: "error" });
    $("#urlInput").focus();
    return;
  }
  const source = detectSource(url);
  if (!source) {
    toast("That doesn't look like a YouTube or Spotify URL.", { type: "error" });
    return;
  }
  const btn = $("#downloadBtn");
  btn.disabled = true;
  try {
    const r = await fetch("/api/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        format: state.format,
        quality: state.quality,
        embed_thumbnail: state.embedThumbnail,
        embed_metadata: state.embedMetadata,
        embed_subs: state.embedSubs,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "failed");
    state.activeJobs.add(data.job_id);
    ensurePolling();
    toast("Download queued", { type: "success" });
    $("#urlInput").value = "";
    $("#clearBtn").hidden = true;
    clearPreview();
    setSourceIcon(null);
    applySourceConstraints(null);
  } catch (e) {
    toast(`Couldn't start: ${e.message}`, { type: "error" });
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

function ensurePolling() {
  if (state.pollTimer) return;
  pollOnce();
  state.pollTimer = setInterval(pollOnce, 600);
}
function stopPolling() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function pollOnce() {
  try {
    const r = await fetch("/api/jobs");
    const jobs = await r.json();
    state.jobs = jobs;
    renderJobs(jobs);
    updatePageTitle(jobs);
    const stillActive = jobs.some((j) =>
      ["queued", "downloading", "processing", "searching", "tagging"].includes(j.status)
    );
    if (!stillActive && state.activeJobs.size === 0) stopPolling();
    const newlyDone = jobs.filter((j) => j.status === "completed" && state.activeJobs.has(j.id));
    if (newlyDone.length) {
      newlyDone.forEach((j) => {
        state.activeJobs.delete(j.id);
        toast(`Saved: ${j.title || j.filename}`, { type: "success" });
      });
      loadHistory();
    }
    const newlyError = jobs.filter((j) => j.status === "error" && state.activeJobs.has(j.id));
    newlyError.forEach((j) => {
      state.activeJobs.delete(j.id);
      toast(`Failed: ${j.error || "unknown error"}`, { type: "error" });
    });
  } catch {/* network blip, try again next tick */}
}

function updatePageTitle(jobs) {
  const active = jobs.filter((j) =>
    ["queued", "downloading", "processing", "searching", "tagging"].includes(j.status)
  );
  if (!active.length) {
    document.title = "ID4";
    return;
  }
  const total = active.reduce((acc, j) => acc + (j.percent || 0), 0);
  const avg = Math.round(total / active.length);
  document.title = `${avg}% · ID4`;
}

// ---------------------------------------------------------------------------
// Render: jobs (active downloads)
// ---------------------------------------------------------------------------

function renderJobs(jobs) {
  const card = $("#jobsCard");
  const list = $("#jobsList");
  const visible = jobs.filter((j) =>
    ["queued", "downloading", "processing", "searching", "tagging"].includes(j.status)
  );
  $("#jobsCount").textContent = visible.length ? `${visible.length} running` : "";
  if (!visible.length) {
    card.hidden = true;
    list.innerHTML = "";
    refreshEmptyState();
    return;
  }
  card.hidden = false;
  refreshEmptyState();

  // Update existing rows in place for smoother UI; add/remove as needed.
  const seen = new Set();
  for (const j of visible) {
    seen.add(j.id);
    let row = list.querySelector(`[data-job-id="${j.id}"]`);
    if (!row) {
      row = makeJobRow(j);
      list.appendChild(row);
    }
    updateJobRow(row, j);
  }
  $$(".job", list).forEach((el) => {
    if (!seen.has(el.dataset.jobId)) el.remove();
  });
}

function makeJobRow(j) {
  const li = document.createElement("li");
  li.className = "job";
  li.dataset.jobId = j.id;
  li.innerHTML = `
    <span class="job-icon"></span>
    <div class="job-body">
      <div class="job-title"></div>
      <div class="job-meta"></div>
    </div>
    <div class="row-actions"></div>
    <div class="progress"><div class="progress-bar"></div></div>
  `;
  return li;
}

function updateJobRow(row, j) {
  const icon = $(".job-icon", row);
  const title = $(".job-title", row);
  const meta = $(".job-meta", row);
  const bar = $(".progress-bar", row);

  title.textContent = j.title || j.url;

  // Icon based on status (with little animations)
  icon.className = "job-icon";
  if (j.status === "downloading") {
    icon.classList.add("is-pulse");
    icon.innerHTML = svg("download");
  } else if (j.status === "processing" || j.status === "tagging") {
    icon.classList.add("is-spin");
    icon.innerHTML = svg("cog");
  } else if (j.status === "searching") {
    icon.classList.add("is-pulse");
    icon.innerHTML = svg("search");
  } else {
    icon.innerHTML = svg("download");
  }

  // Meta line
  meta.innerHTML = "";
  const fmtPill = document.createElement("span");
  fmtPill.className = "pill";
  fmtPill.textContent = j.format;
  meta.appendChild(fmtPill);
  if (j.source && j.source !== "youtube") {
    const sp = document.createElement("span");
    sp.className = "pill";
    sp.textContent = j.source;
    meta.appendChild(sp);
  }
  if (j.status === "downloading") {
    meta.append(
      spanText(`${(j.percent || 0).toFixed(1)}%`),
      spanText(j.speed || ""),
      spanText(j.eta ? `ETA ${j.eta}` : "")
    );
  } else {
    meta.append(spanText(labelForStatus(j.status)));
  }

  // Progress bar
  if (j.status === "processing" || j.status === "tagging" || j.status === "searching" ||
      (j.status === "downloading" && !j.total_bytes)) {
    bar.classList.add("is-indeterminate");
    bar.style.width = "";
  } else if (j.status === "queued") {
    bar.classList.add("is-indeterminate");
    bar.style.width = "";
  } else {
    bar.classList.remove("is-indeterminate");
    bar.style.width = `${Math.max(2, j.percent || 0)}%`;
  }
}

function labelForStatus(s) {
  if (s === "queued") return "Queued";
  if (s === "searching") return "Searching YouTube…";
  if (s === "processing") return "Processing…";
  if (s === "tagging") return "Tagging…";
  if (s === "error") return "Error";
  return s;
}

// ---------------------------------------------------------------------------
// Render: history
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const r = await fetch("/api/history");
    const items = await r.json();
    state.history = items;
    renderHistory(items);
    refreshEmptyState();
  } catch {}
}

function renderHistory(items) {
  const card = $("#historyCard");
  const list = $("#historyList");
  if (!items.length) {
    card.hidden = true;
    list.innerHTML = "";
    return;
  }
  $("#historyCount").textContent = `${items.length} ${items.length === 1 ? "item" : "items"}`;
  card.hidden = false;
  list.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.dataset.entryId = it.id;

    const thumb = it.thumbnail
      ? `<img class="thumb" src="${escapeAttr(it.thumbnail)}" alt="" loading="lazy" />`
      : `<span class="thumb-fallback">${svg(it.format === "mp3" ? "music" : "video")}</span>`;

    li.innerHTML = `
      ${thumb}
      <div class="hi-body">
        <div class="hi-title"></div>
        <div class="hi-meta"></div>
      </div>
      <div class="row-actions">
        <button class="row-menu-btn" aria-haspopup="menu" aria-label="Actions">${svg("dots")}</button>
      </div>
    `;
    $(".hi-title", li).textContent = it.title || it.filename;
    const meta = $(".hi-meta", li);
    const fmtPill = document.createElement("span");
    fmtPill.className = "pill";
    fmtPill.textContent = it.format?.toUpperCase() || "";
    meta.appendChild(fmtPill);
    if (it.source && it.source !== "youtube") {
      const sp = document.createElement("span");
      sp.className = "pill";
      sp.textContent = it.source;
      meta.appendChild(sp);
    }
    meta.append(
      spanText(fmtBytes(it.size_bytes)),
      spanText(fmtAgo(it.completed_at))
    );

    const menuBtn = $(".row-menu-btn", li);
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleRowMenu(it, menuBtn);
    });

    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Row action menu
// ---------------------------------------------------------------------------

function closeAnyMenu() {
  $$(".row-menu").forEach((m) => m.remove());
  $$(".row-menu-btn.is-open").forEach((b) => b.classList.remove("is-open"));
  state.openMenuFor = null;
}

function toggleRowMenu(item, btn) {
  if (state.openMenuFor === item.id) {
    closeAnyMenu();
    return;
  }
  closeAnyMenu();
  state.openMenuFor = item.id;
  btn.classList.add("is-open");

  const tpl = $("#rowMenuTpl");
  const menu = tpl.content.firstElementChild.cloneNode(true);
  $$(".row-menu button", menu).forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      handleMenuAction(b.dataset.action, item);
      closeAnyMenu();
    });
  });
  btn.parentElement.appendChild(menu);
}

async function handleMenuAction(action, item) {
  if (action === "open") {
    const r = await fetch(`/api/history/${item.id}/open`, { method: "POST" });
    if (!r.ok) toast("Couldn't open file.", { type: "error" });
  } else if (action === "reveal") {
    const r = await fetch(`/api/history/${item.id}/reveal`, { method: "POST" });
    if (!r.ok) toast("Couldn't reveal file.", { type: "error" });
  } else if (action === "save") {
    window.location.href = `/api/history/${item.id}/file`;
  } else if (action === "copy") {
    try {
      await navigator.clipboard.writeText(item.url || "");
      toast("URL copied", { type: "success" });
    } catch {
      toast("Couldn't access clipboard", { type: "error" });
    }
  } else if (action === "replay") {
    $("#urlInput").value = item.url || "";
    debouncePreview();
    $("#urlInput").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (action === "delete") {
    if (!confirm(`Delete "${item.title || item.filename}"?`)) return;
    await fetch(`/api/history/${item.id}`, { method: "DELETE" });
    loadHistory();
    toast("Deleted", { type: "success" });
  }
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function refreshEmptyState() {
  const hasJobs = state.jobs?.some?.((j) =>
    ["queued", "downloading", "processing", "searching", "tagging"].includes(j.status)
  );
  const hasHistory = state.history?.length;
  $("#emptyState").classList.toggle("is-hidden", Boolean(hasJobs || hasHistory));
}

// ---------------------------------------------------------------------------
// Toasts (top-right, stackable, auto-dismiss)
// ---------------------------------------------------------------------------

function toast(message, opts = {}) {
  const stack = $("#toastStack");
  const el = document.createElement("div");
  el.className = `toast ${opts.type === "error" ? "is-error" : opts.type === "success" ? "is-success" : ""}`;
  const iconName = opts.type === "error" ? "alert" : opts.type === "success" ? "check" : "info";
  el.innerHTML = `<span class="toast-icon">${svg(iconName)}</span><span></span>`;
  $("span:last-child", el).textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, opts.ms || 2800);
  el.addEventListener("click", () => el.remove());
}

// ---------------------------------------------------------------------------
// Drag & drop URL onto the window
// ---------------------------------------------------------------------------

function initDragDrop() {
  let depth = 0;
  const overlay = $("#dropOverlay");
  window.addEventListener("dragenter", (e) => {
    if (![...e.dataTransfer?.types || []].some((t) => t === "text/uri-list" || t === "text/plain" || t === "text/x-moz-url")) return;
    depth++;
    overlay.classList.add("is-active");
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove("is-active");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove("is-active");
    const dt = e.dataTransfer;
    let url =
      dt.getData("text/uri-list") ||
      dt.getData("text/x-moz-url")?.split("\n")[0] ||
      dt.getData("text/plain") ||
      "";
    url = url.trim();
    if (!url) return;
    $("#urlInput").value = url;
    debouncePreview();
    $("#urlInput").focus();
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function initShortcuts() {
  document.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

    // Cmd/Ctrl+K, focus URL bar from anywhere
    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#urlInput").focus();
      $("#urlInput").select();
      return;
    }

    // Esc, clear URL or close menu
    if (e.key === "Escape") {
      if (state.openMenuFor) { closeAnyMenu(); return; }
      if (document.activeElement === $("#urlInput")) {
        $("#urlInput").value = "";
        debouncePreview();
      }
      return;
    }

    // Cmd/Ctrl+V outside input, auto-paste & focus
    if (meta && e.key.toLowerCase() === "v" && !inInput && navigator.clipboard?.readText) {
      navigator.clipboard.readText().then((text) => {
        if (!text) return;
        $("#urlInput").value = text.trim();
        $("#urlInput").focus();
        debouncePreview();
      }).catch(() => {});
    }
  });

  // Click anywhere else closes open menus
  document.addEventListener("click", () => {
    if (state.openMenuFor) closeAnyMenu();
  });
}

// ---------------------------------------------------------------------------
// SVG icons
// ---------------------------------------------------------------------------

const ICONS = {
  download: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M7 2H12V7C12 8.65685 13.3431 10 15 10H20V19C20 20.6569 18.6569 22 17 22H7C5.34315 22 4 20.6569 4 19V5C4 3.34315 5.34315 2 7 2ZM15.2071 17.2071L12.7071 19.7071C12.3166 20.0976 11.6834 20.0976 11.2929 19.7071L8.79289 17.2071C8.40237 16.8166 8.40237 16.1834 8.79289 15.7929C9.18342 15.4024 9.81658 15.4024 10.2071 15.7929L11 16.5858V13C11 12.4477 11.4477 12 12 12C12.5523 12 13 12.4477 13 13V16.5858L13.7929 15.7929C14.1834 15.4024 14.8166 15.4024 15.2071 15.7929C15.5976 16.1834 15.5976 16.8166 15.2071 17.2071Z' fill='currentColor'/><path d='M14 2.58579L19.4142 8H15C14.4477 8 14 7.55228 14 7V2.58579Z' fill='currentColor'/></svg>`,
  check: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M19.3209 4.24472C20.0142 4.69807 20.2088 5.62768 19.7555 6.32105L11.2555 19.321C10.9972 19.7161 10.5681 19.9665 10.0971 19.997C9.62613 20.0276 9.16825 19.8347 8.86111 19.4764L4.36111 14.2264C3.82198 13.5974 3.89482 12.6504 4.52381 12.1113C5.1528 11.5722 6.09975 11.645 6.63888 12.274L9.83825 16.0066L17.2445 4.6793C17.6979 3.98593 18.6275 3.79136 19.3209 4.24472Z' fill='currentColor'/></svg>`,
  alert: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M5.65136 5.27239C5.98524 3.93689 7.18519 3 8.56179 3H15.4387C16.8153 3 18.0152 3.93689 18.3491 5.27239L21.9704 19.7575C22.1043 20.2933 21.7786 20.8362 21.2428 20.9701C20.707 21.1041 20.164 20.7783 20.0301 20.2425L19.4695 18H14.531L13.9704 20.2425C13.8364 20.7783 13.2935 21.1041 12.7577 20.9701C12.2219 20.8362 11.8961 20.2933 12.0301 19.7575L12.4695 18H4.53101L3.97038 20.2425C3.83643 20.7783 3.2935 21.1041 2.7577 20.9701C2.22191 20.8362 1.89615 20.2933 2.03009 19.7575L5.65136 5.27239ZM17.0002 8.12311L15.031 16H18.9695L17.0002 8.12311Z' fill='currentColor'/></svg>`,
  info: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' aria-hidden='true'><path d='M11 9.5C12.1046 9.5 13 10.3954 13 11.5V18H14C14.5523 18 15 18.4477 15 19C15 19.5523 14.5523 20 14 20H10C9.44772 20 9 19.5523 9 19C9 18.4477 9.44772 18 10 18H11V11.5H10C9.44772 11.5 9 11.0523 9 10.5C9 9.94772 9.44772 9.5 10 9.5H11Z' fill='currentColor'/><path d='M12 4C12.8284 4 13.5 4.67157 13.5 5.5C13.5 6.32843 12.8284 7 12 7C11.1716 7 10.5 6.32843 10.5 5.5C10.5 4.67157 11.1716 4 12 4Z' fill='currentColor'/></svg>`,
  cog: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M3 8.66986C3 7.58603 3.58459 6.58648 4.52924 6.05512L10.5292 2.68018C11.4425 2.1665 12.5575 2.1665 13.4708 2.68019L19.4708 6.05515C20.4154 6.5865 21 7.58606 21 8.66989L21 15.3305C21 16.4143 20.4154 17.4139 19.4708 17.9452L13.4707 21.3202C12.5575 21.8338 11.4425 21.8338 10.5293 21.3202L4.52931 17.9455C3.58463 17.4142 3 16.4146 3 15.3307V8.66986ZM8.50003 12C8.50003 10.067 10.067 8.5 12 8.5C13.933 8.5 15.5 10.067 15.5 12C15.5 13.933 13.933 15.5 12 15.5C10.067 15.5 8.50003 13.933 8.50003 12Z' fill='currentColor'/></svg>`,
  music: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' aria-hidden='true'><path d='M17.7087 4.73018C18.3504 4.53769 18.9961 5.01814 18.9961 5.688V12.4713C18.3888 12.1668 17.6961 11.9999 16.9961 11.9999C14.9654 11.9999 12.9961 13.404 12.9961 15.4999C12.9961 17.5959 14.9654 18.9999 16.9961 18.9999C19.0268 18.9999 20.9961 17.5959 20.9961 15.4999V5.688C20.9961 3.67841 19.0589 2.23707 17.1341 2.81452L11.1341 4.61452C9.8651 4.99521 8.99609 6.16318 8.99609 7.488V15.4713C8.38882 15.1668 7.6961 14.9999 6.99609 14.9999C4.96541 14.9999 2.99609 16.404 2.99609 18.4999C2.99609 20.5959 4.96541 21.9999 6.99609 21.9999C9.02677 21.9999 10.9961 20.5959 10.9961 18.4999V7.488C10.9961 7.04639 11.2858 6.65707 11.7087 6.53018L17.7087 4.73018Z' fill='currentColor'/></svg>`,
  video: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M2 7C2 5.34315 3.34315 4 5 4H13C14.6569 4 16 5.34315 16 7V8.38175L19.1056 6.82896C20.4354 6.16406 22 7.13105 22 8.61782V15.3817C22 16.8685 20.4354 17.8355 19.1056 17.1706L16 15.6178V17C16 18.6569 14.6569 20 13 20H5C3.34315 20 2 18.6569 2 17V7ZM16 13.3817L20 15.3817V8.61782L16 10.6178V13.3817Z' fill='currentColor'/></svg>`,
  search: `<svg viewBox='0 0 24 24' width='14' height='14' fill='none' aria-hidden='true'><path d='M11 15C13.2091 15 15 13.2091 15 11C15 8.79086 13.2091 7 11 7C8.79086 7 7 8.79086 7 11C7 13.2091 8.79086 15 11 15Z' fill='currentColor'/><path fill-rule='evenodd' clip-rule='evenodd' d='M11 5C7.68629 5 5 7.68629 5 11C5 14.3137 7.68629 17 11 17C14.3137 17 17 14.3137 17 11C17 7.68629 14.3137 5 11 5ZM3 11C3 6.58172 6.58172 3 11 3C15.4183 3 19 6.58172 19 11C19 12.8487 18.3729 14.551 17.3199 15.9056L20.7071 19.2929C21.0976 19.6834 21.0976 20.3166 20.7071 20.7071C20.3166 21.0976 19.6834 21.0976 19.2929 20.7071L15.9056 17.3199C14.551 18.3729 12.8487 19 11 19C6.58172 19 3 15.4183 3 11Z' fill='currentColor'/></svg>`,
  dots: `<svg viewBox='0 0 24 24' width='14' height='14' fill='currentColor' aria-hidden='true'><circle cx='5' cy='12' r='1.6'/><circle cx='12' cy='12' r='1.6'/><circle cx='19' cy='12' r='1.6'/></svg>`,
};
function svg(name) { return ICONS[name] || ""; }

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bindUI() {
  $$(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      setFormat(btn.dataset.format);
      $("#optSubsWrap").style.opacity = state.format === "mp4" ? "" : "0.4";
      $("#optSubs").disabled = state.format !== "mp4";
    });
  });

  $("#qualitySelect").addEventListener("change", (e) => (state.quality = e.target.value));
  $("#optThumbnail").addEventListener("change", (e) => (state.embedThumbnail = e.target.checked));
  $("#optMetadata").addEventListener("change", (e) => (state.embedMetadata = e.target.checked));
  $("#optSubs").addEventListener("change", (e) => (state.embedSubs = e.target.checked));

  $("#urlInput").addEventListener("input", debouncePreview);
  $("#urlInput").addEventListener("paste", () => setTimeout(debouncePreview, 0));
  $("#urlInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      startDownload();
    }
  });

  $("#clearBtn").addEventListener("click", () => {
    $("#urlInput").value = "";
    debouncePreview();
    $("#urlInput").focus();
  });

  $("#pasteBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      $("#urlInput").value = text.trim();
      debouncePreview();
      $("#urlInput").focus();
    } catch {
      toast("Couldn't read clipboard.", { type: "error" });
    }
  });

  $("#cmdkBtn").addEventListener("click", () => {
    $("#urlInput").focus();
    $("#urlInput").select();
  });

  $("#downloadBtn").addEventListener("click", startDownload);
}

async function init() {
  initTheme();
  bindUI();
  initDragDrop();
  initShortcuts();
  renderQuality();
  await loadHistory();
  ensurePolling();

  // Health check
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    const ff = d.ffmpeg ? "ffmpeg ✓" : "ffmpeg missing";
    $("#footerStatus").textContent = `yt-dlp ${d.yt_dlp} · ${ff}`;
  } catch {
    $("#footerStatus").textContent = "offline";
  }
}

init();
