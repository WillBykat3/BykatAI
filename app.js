(() => {
  "use strict";

  const cfg = window.BYKAT_CONFIG || {};
  const BUCKET = "attachments";
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_FILES = 10;
  const SITE_URL = location.origin + location.pathname;

  // Files Gemini reads natively (sent as-is) and text/code files (sent as text).
  const INLINE_TYPES = /^(image\/(png|jpeg|webp|heic|heif)|application\/pdf|audio\/(wav|x-wav|mp3|mpeg|aiff|aac|ogg|flac)|video\/(mp4|mpeg|quicktime|webm|x-flv|3gpp|x-ms-wmv|avi))$/;
  const EXT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", heif: "image/heif", pdf: "application/pdf", mp3: "audio/mp3", wav: "audio/wav", m4a: "audio/aac", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
  const TEXT_EXTS = new Set("txt md markdown csv tsv json jsonl xml yaml yml toml ini cfg conf log html htm css scss less js mjs cjs ts tsx jsx py rb go rs java kt kts c h cc cpp hpp cs php sh bash zsh ps1 sql swift r lua pl dart scala ex exs hs ml vue svelte tex rst srt vtt gradle dockerfile makefile".split(" "));

  // ───────────── DOM helpers ─────────────
  const $ = (id) => document.getElementById(id);
  const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function showScreen(id) {
    for (const s of ["boot", "setup", "auth", "app"]) $(s).hidden = s !== id;
  }

  function fmtSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }

  // ───────────── Theme ─────────────
  const mqDark = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme(choice) {
    if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
    const dark = choice === "dark" || (choice !== "light" && mqDark.matches);
    $("hl-light").disabled = dark;
    $("hl-dark").disabled = !dark;
    document.querySelectorAll("[data-theme-opt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeOpt === (choice || "system"))));
  }
  applyTheme(store.get("bykat:theme") || "system");
  mqDark.addEventListener("change", () => applyTheme(store.get("bykat:theme") || "system"));

  // ───────────── Markdown ─────────────
  const md = window.marked;
  md.setOptions({ gfm: true, breaks: false });
  window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
  });

  function renderMarkdown(target, text, final) {
    target.innerHTML = window.DOMPurify.sanitize(md.parse(text || ""));
    target.querySelectorAll("pre > code").forEach((code) => {
      const pre = code.parentElement;
      const lang = (code.className.match(/language-([\w+#.-]+)/) || [])[1] || "";
      const block = el("div", "code-block");
      const head = el("div", "code-head", `<span>${esc(lang || "code")}</span>`);
      const btn = el("button", "code-copy", `${icon("copy")}<span>Copy</span>`);
      btn.type = "button";
      btn.addEventListener("click", async () => {
        if (await copyText(code.textContent)) {
          btn.innerHTML = `${icon("check")}<span>Copied</span>`;
          setTimeout(() => (btn.innerHTML = `${icon("copy")}<span>Copy</span>`), 1800);
        }
      });
      head.appendChild(btn);
      pre.replaceWith(block);
      block.append(head, pre);
      if (final && window.hljs) {
        try {
          if (lang && window.hljs.getLanguage(lang)) window.hljs.highlightElement(code);
          else if (!lang) { code.innerHTML = window.hljs.highlightAuto(code.textContent).value; code.classList.add("hljs"); }
        } catch { /* leave unhighlighted */ }
      }
    });
  }

  // ───────────── Not configured ─────────────
  if (!/^https:\/\/\S+$/.test(cfg.SUPABASE_URL || "") || (cfg.SUPABASE_KEY || "").length < 20) {
    showScreen("setup");
    return;
  }
  const FUNCTION_URL = `${cfg.SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/chat`;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ───────────── State ─────────────
  let user = null;
  let conversations = [];   // [{ id, title, updated_at }]
  let current = null;       // conversation shown, or null for a new chat
  let messages = [];        // messages of `current`
  let pendingFiles = [];    // files attached in the composer
  let streaming = null;     // { controller, convoId }
  let models = [];
  let defaultModel = "";
  let selectedModel = store.get("bykat:model") || "";
  let webSearch = store.get("bykat:web") === "1";
  const signedUrls = new Map(); // storage path → { url, at }
  const localPreviews = new Map(); // storage path → object URL for files uploaded this session

  // ───────────── Auth ─────────────
  let authView = "signin";
  function setAuthView(view, message, ok) {
    authView = view;
    document.querySelectorAll(".auth-view").forEach((v) => (v.hidden = v.dataset.view !== view));
    const err = $("auth-error");
    err.hidden = !message;
    err.textContent = message || "";
    err.classList.toggle("ok", !!ok);
    const first = document.querySelector(`.auth-view[data-view="${view}"] input`);
    if (first && !matchMedia("(pointer: coarse)").matches) setTimeout(() => first.focus(), 0);
  }
  if (cfg.GOOGLE_SIGN_IN) document.querySelectorAll(".oauth").forEach((n) => (n.hidden = false));
  document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => setAuthView(b.dataset.goto)));

  async function busy(btn, fn) {
    btn.setAttribute("aria-busy", "true");
    try { return await fn(); } finally { btn.removeAttribute("aria-busy"); }
  }

  function friendlyAuthError(error) {
    const m = error?.message || String(error);
    if (/invalid login credentials/i.test(m)) return "That email and password don't match. Try again or reset your password.";
    if (/email not confirmed/i.test(m)) return "Please confirm your email first. Check your inbox for the link.";
    if (/already registered|already exists/i.test(m)) return "An account with this email already exists. Try signing in.";
    return m;
  }

  $("signin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    busy(e.submitter, async () => {
      const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
      if (error) setAuthView("signin", friendlyAuthError(error));
    });
  });

  $("signup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const email = f.get("email").trim();
    busy(e.submitter, async () => {
      const { data, error } = await sb.auth.signUp({
        email,
        password: f.get("password"),
        options: { data: { full_name: f.get("name").trim() }, emailRedirectTo: SITE_URL },
      });
      if (error) return setAuthView("signup", friendlyAuthError(error));
      if (!data.session) {
        $("check-email-text").textContent = `We sent a confirmation link to ${email}. Open it to finish creating your account.`;
        setAuthView("check-email");
      }
    });
  });

  $("forgot-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = new FormData(e.target).get("email").trim();
    busy(e.submitter, async () => {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL });
      if (error) return setAuthView("forgot", friendlyAuthError(error));
      $("check-email-text").textContent = `If an account exists for ${email}, a password reset link is on its way.`;
      setAuthView("check-email");
    });
  });

  $("reset-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get("password");
    busy(e.submitter, async () => {
      const { data, error } = await sb.auth.updateUser({ password });
      if (error) return setAuthView("reset", friendlyAuthError(error));
      toast("Password updated");
      enterApp(data.user);
    });
  });

  document.querySelectorAll("[data-oauth]").forEach((b) =>
    b.addEventListener("click", async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: b.dataset.oauth, options: { redirectTo: SITE_URL } });
      if (error) setAuthView(authView, friendlyAuthError(error));
    }),
  );

  // Supabase recommends not awaiting other Supabase calls inside this callback, so defer the work.
  sb.auth.onAuthStateChange((event, session) => {
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") {
        showScreen("auth");
        setAuthView("reset");
        return;
      }
      if (session?.user) {
        if (authView === "reset" && !$("auth").hidden) return; // finishing a password reset
        if (event === "USER_UPDATED") { user = session.user; renderUser(); return; }
        if (!user || user.id !== session.user.id) enterApp(session.user);
      } else if (event === "SIGNED_OUT" || event === "INITIAL_SESSION") {
        leaveApp();
      }
    }, 0);
  });

  // Show any error Supabase put in the URL (expired confirmation link, etc.).
  (function urlErrors() {
    const params = new URLSearchParams(location.hash.slice(1) || location.search);
    const desc = params.get("error_description");
    if (desc) {
      history.replaceState(null, "", SITE_URL);
      setTimeout(() => setAuthView("signin", desc.replace(/\+/g, " ")), 0);
    }
  })();

  function leaveApp() {
    if (streaming) streaming.controller.abort();
    user = null;
    conversations = [];
    current = null;
    messages = [];
    pendingFiles = [];
    $("messages").innerHTML = "";
    showScreen("auth");
    if (authView === "reset" || authView === "check-email") return;
    setAuthView(authView === "signup" ? "signup" : "signin", $("auth-error").hidden ? "" : $("auth-error").textContent);
  }

  // ───────────── App entry ─────────────
  function displayName() {
    return (user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split("@")[0] || "there").trim();
  }

  function renderUser() {
    const name = displayName();
    $("user-name").textContent = name;
    $("user-email").textContent = user.email || "";
    $("user-avatar").textContent = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
    $("settings-email").textContent = user.email || "";
    $("name-form").elements.name.value = name;
    renderGreeting();
  }

  function renderGreeting() {
    const h = new Date().getHours();
    const part = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    $("greeting").innerHTML = `${part}, <span class="grad-text">${esc(displayName().split(/\s+/)[0])}</span>`;
  }

  async function enterApp(u) {
    user = u;
    showScreen("app");
    renderUser();
    if (location.hash.includes("access_token") || location.search.includes("code=")) history.replaceState(null, "", SITE_URL);
    applySidebarPref();
    updateSearchToggle();
    loadModels();
    await loadConversations();
    const fromHash = location.hash.match(/^#c\/([0-9a-f-]{36})$/);
    if (fromHash && conversations.some((c) => c.id === fromHash[1])) openConversation(fromHash[1]);
    else newChat();
  }

  // ───────────── Edge function calls ─────────────
  async function callFunction(body, signal) {
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    return fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: cfg.SUPABASE_KEY },
      body: JSON.stringify(body),
      signal,
    });
  }

  async function errorFrom(res) {
    try { const j = await res.json(); if (j.error) return j.error; } catch { /* not JSON */ }
    if (res.status === 404) return "The chat function isn't deployed yet. See the README to deploy it.";
    return `Request failed (${res.status})`;
  }

  // ───────────── Models ─────────────
  async function loadModels() {
    const notice = $("gemini-notice");
    try {
      const res = await callFunction({ action: "models" });
      if (!res.ok) throw new Error(await errorFrom(res));
      const data = await res.json();
      models = data.models || [];
      defaultModel = data.default || "";
      if (selectedModel && !models.some((m) => m.id === selectedModel)) selectedModel = "";
      notice.hidden = true;
    } catch (e) {
      models = [];
      $("gemini-notice-text").textContent = e.message.includes("Failed to fetch")
        ? "Can't reach the chat function. Check that it's deployed (see the README)."
        : e.message;
      notice.hidden = false;
    }
    renderModelLabel();
  }

  function modelName(id) {
    return models.find((m) => m.id === id)?.name || id;
  }

  function renderModelLabel() {
    $("model-label").textContent = selectedModel ? modelName(selectedModel) : "BykatAI";
    $("model-btn").title = selectedModel || (defaultModel ? `Auto: ${defaultModel}` : "");
  }

  function renderModelMenu() {
    const menu = $("model-menu");
    menu.innerHTML = "";
    const opt = (id, name, sub) => {
      const b = el("button", "model-opt", `<span class="mo-text"><span class="mo-name">${esc(name)}</span><span class="mo-id">${esc(sub)}</span></span><svg class="mo-check"><use href="#i-check"/></svg>`);
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(selectedModel === id));
      b.addEventListener("click", () => {
        selectedModel = id;
        store.set("bykat:model", id || null);
        renderModelLabel();
        closeModelMenu();
      });
      menu.appendChild(b);
    };
    opt("", "BykatAI Auto", defaultModel ? `Best available · ${defaultModel}` : "Picks the best available model");
    if (!models.length) {
      menu.appendChild(el("div", "menu-note", "Models appear here once the Gemini API key is connected."));
      return;
    }
    menu.appendChild(el("div", "menu-note", "Gemini models"));
    for (const m of models) opt(m.id, m.name, m.id);
  }

  function closeModelMenu() {
    $("model-menu").hidden = true;
    $("model-btn").setAttribute("aria-expanded", "false");
  }
  $("model-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("model-menu").hidden;
    if (open) renderModelMenu();
    $("model-menu").hidden = !open;
    $("model-btn").setAttribute("aria-expanded", String(open));
  });

  // ───────────── Conversations ─────────────
  async function loadConversations() {
    const { data, error } = await sb.from("conversations").select("id, title, updated_at").order("updated_at", { ascending: false }).limit(500);
    if (error) { toast(`Couldn't load chats: ${error.message}`); return; }
    conversations = data;
    renderSidebar();
  }

  function groupLabel(date) {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const t = date.getTime();
    if (t >= startToday) return "Today";
    if (t >= startToday - 86400000) return "Yesterday";
    if (t >= startToday - 7 * 86400000) return "Previous 7 days";
    if (t >= startToday - 30 * 86400000) return "Previous 30 days";
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  function renderSidebar() {
    const nav = $("chat-groups");
    const q = $("chat-search").value.trim().toLowerCase();
    const list = q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations;
    nav.innerHTML = "";
    if (!list.length) {
      nav.appendChild(el("div", "empty-list", q ? "No chats match your search." : "Your chats will appear here."));
      return;
    }
    let group = null;
    let label = "";
    for (const c of list) {
      const l = groupLabel(new Date(c.updated_at));
      if (l !== label) {
        label = l;
        group = el("div", "chat-group", `<h3>${esc(l)}</h3>`);
        nav.appendChild(group);
      }
      const item = el("div", "chat-item");
      item.dataset.id = c.id;
      item.tabIndex = 0;
      item.setAttribute("role", "link");
      if (current?.id === c.id) item.classList.add("active");
      if (streaming?.convoId === c.id) item.classList.add("streaming");
      const title = el("span", "title");
      title.textContent = c.title;
      const more = el("button", "more", icon("more"));
      more.type = "button";
      more.setAttribute("aria-label", "Chat options");
      item.append(title, more);
      group.appendChild(item);
    }
  }

  $("chat-search").addEventListener("input", renderSidebar);
  $("chat-groups").addEventListener("click", (e) => {
    const item = e.target.closest(".chat-item");
    if (!item) return;
    const more = e.target.closest(".more");
    if (more) { e.stopPropagation(); openItemMenu(more, item.dataset.id); return; }
    openConversation(item.dataset.id);
  });
  $("chat-groups").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("chat-item")) openConversation(e.target.dataset.id);
  });

  let menuFor = null;
  function openItemMenu(anchor, id) {
    const menu = $("item-menu");
    if (!menu.hidden && menuFor === id) { closeItemMenu(); return; }
    menuFor = id;
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 4, innerHeight - 110)}px`;
    menu.style.left = `${Math.min(r.left, innerWidth - 186)}px`;
    menu.style.position = "fixed";
    menu.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
  }
  function closeItemMenu() {
    $("item-menu").hidden = true;
    document.querySelectorAll(".chat-item .more[aria-expanded]").forEach((b) => b.removeAttribute("aria-expanded"));
  }
  $("item-menu").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const id = menuFor;
    closeItemMenu();
    const convo = conversations.find((c) => c.id === id);
    if (!convo) return;
    if (act === "rename") {
      const title = await dialog({ title: "Rename chat", input: convo.title, ok: "Save" });
      if (title == null || !title.trim() || title.trim() === convo.title) return;
      const { error } = await sb.from("conversations").update({ title: title.trim() }).eq("id", id);
      if (error) return toast(`Couldn't rename: ${error.message}`);
      convo.title = title.trim();
      renderSidebar();
    } else if (act === "delete") {
      const yes = await dialog({ title: "Delete chat?", text: `“${convo.title}” and its files will be deleted. This can't be undone.`, ok: "Delete", danger: true });
      if (yes) deleteConversations([id]);
    }
  });

  async function deleteConversations(ids) {
    if (streaming && ids.includes(streaming.convoId)) streaming.controller.abort();
    const { data: rows } = await sb.from("messages").select("attachments").in("conversation_id", ids).neq("attachments", "[]");
    const paths = (rows || []).flatMap((r) => (r.attachments || []).map((a) => a.path));
    const { error } = await sb.from("conversations").delete().in("id", ids);
    if (error) return toast(`Couldn't delete: ${error.message}`);
    for (let i = 0; i < paths.length; i += 100) await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    conversations = conversations.filter((c) => !ids.includes(c.id));
    if (current && ids.includes(current.id)) newChat();
    else renderSidebar();
    toast(ids.length > 1 ? "All chats deleted" : "Chat deleted");
  }

  function setHash(id) {
    history.replaceState(null, "", id ? `${SITE_URL}#c/${id}` : SITE_URL);
  }

  function newChat() {
    current = null;
    messages = [];
    setHash(null);
    $("messages").innerHTML = "";
    $("app").classList.remove("has-thread");
    document.title = "BykatAI";
    renderGreeting();
    renderSidebar();
    updateSend();
    closeMobileSidebar();
    if (!matchMedia("(pointer: coarse)").matches) $("prompt").focus();
  }

  let openSeq = 0;
  async function openConversation(id) {
    const convo = conversations.find((c) => c.id === id);
    if (!convo) return;
    const seq = ++openSeq;
    current = convo;
    setHash(id);
    document.title = `${convo.title} · BykatAI`;
    $("app").classList.add("has-thread");
    $("messages").innerHTML = "";
    renderSidebar();
    closeMobileSidebar();
    updateSend();

    const { data, error } = await sb.from("messages").select("id, role, content, attachments, created_at").eq("conversation_id", id).order("created_at");
    if (seq !== openSeq) return;
    if (error) return toast(`Couldn't load this chat: ${error.message}`);
    messages = data;
    await signAttachmentUrls(messages);
    if (seq !== openSeq) return;
    renderMessages();
    scrollToBottom(true);
  }

  // ───────────── Rendering messages ─────────────
  async function signAttachmentUrls(list) {
    const fresh = Date.now() - 50 * 60_000;
    const paths = list.flatMap((m) => (m.attachments || []).map((a) => a.path)).filter((p) => !localPreviews.has(p) && !(signedUrls.get(p)?.at > fresh));
    if (!paths.length) return;
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    for (const d of data || []) if (d.signedUrl) signedUrls.set(d.path, { url: d.signedUrl, at: Date.now() });
  }

  const urlFor = (path) => localPreviews.get(path) || signedUrls.get(path)?.url || "";

  function renderMessages() {
    const box = $("messages");
    box.innerHTML = "";
    messages.forEach((m) => box.appendChild(renderMessage(m)));
    markLast();
  }

  function markLast() {
    const nodes = $("messages").querySelectorAll(".msg");
    nodes.forEach((n, i) => n.classList.toggle("last", i === nodes.length - 1));
  }

  function renderAttachments(atts) {
    const wrap = el("div", "atts");
    for (const a of atts) {
      if (/^image\//.test(a.mime_type) && urlFor(a.path)) {
        const b = el("button", "att-img");
        b.type = "button";
        b.title = a.name;
        const img = el("img");
        img.src = urlFor(a.path);
        img.alt = a.name;
        img.loading = "lazy";
        b.appendChild(img);
        b.addEventListener("click", () => openAttachment(a));
        wrap.appendChild(b);
      } else {
        const b = el("button", "att-file", `<span class="file-ico">${icon("file")}</span><span class="file-meta"><span class="file-name"></span><span class="file-sub">${esc(fileKind(a))} · ${fmtSize(a.size)}</span></span>`);
        b.type = "button";
        b.querySelector(".file-name").textContent = a.name;
        b.addEventListener("click", () => openAttachment(a));
        wrap.appendChild(b);
      }
    }
    return wrap;
  }

  function fileKind(a) {
    const ext = a.name.includes(".") ? a.name.split(".").pop().toUpperCase() : "";
    if (a.mime_type === "application/pdf") return "PDF";
    if (/^audio\//.test(a.mime_type)) return "Audio";
    if (/^video\//.test(a.mime_type)) return "Video";
    return ext || "File";
  }

  async function openAttachment(a) {
    // Open the tab synchronously so pop-up blockers allow it, then point it at the signed URL.
    const win = window.open("", "_blank");
    let url = urlFor(a.path);
    if (!url) {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(a.path, 3600);
      if (error) { win?.close(); return toast(`Couldn't open file: ${error.message}`); }
      url = data.signedUrl;
    }
    if (win) win.location = url;
  }

  function renderMessage(m) {
    if (m.role === "user") {
      const node = el("div", "msg user");
      if (m.attachments?.length) node.appendChild(renderAttachments(m.attachments));
      if (m.content) {
        const b = el("div", "bubble");
        b.textContent = m.content;
        node.appendChild(b);
      }
      const actions = el("div", "msg-actions", `<button class="act" data-act="copy" title="Copy">${icon("copy")}</button>`);
      actions.querySelector("[data-act=copy]").addEventListener("click", (e) => copyFeedback(e.currentTarget, m.content));
      node.appendChild(actions);
      return node;
    }

    const node = el("div", "msg model");
    m._node = node;
    node.appendChild(el("div", "", `<svg class="msg-avatar"><use href="#i-logo"/></svg>`));
    const body = el("div", "msg-body");
    const content = el("div", "md");
    body.appendChild(content);
    node.appendChild(body);
    m._content = content;
    m._body = body;
    paintModel(m, !m._streaming);
    return node;
  }

  function paintModel(m, final) {
    const { _content: content, _body: body } = m;
    if (!content) return;
    if (m._streaming && !m.content) content.innerHTML = `<span class="thinking"><i></i><i></i><i></i></span>`;
    else {
      renderMarkdown(content, m.content, final);
      if (m._streaming) {
        const last = content.lastElementChild;
        const cursor = el("span", "cursor");
        if (last && !last.classList.contains("code-block") && last.tagName !== "TABLE") last.appendChild(cursor);
        else content.appendChild(cursor);
      }
    }
    body.querySelectorAll(".sources, .msg-error, .msg-actions").forEach((n) => n.remove());
    if (m._sources?.length) {
      const s = el("div", "sources");
      for (const src of m._sources.slice(0, 8)) {
        let host = src.title;
        try { host = src.title || new URL(src.url).hostname; } catch { /* keep title */ }
        const a = el("a", "source", `${icon("link")}<span></span>`);
        a.href = src.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.querySelector("span").textContent = host;
        s.appendChild(a);
      }
      body.appendChild(s);
    }
    if (m._error) {
      const err = el("div", "msg-error", `${icon("alert")}<span></span><button class="btn" type="button">${icon("retry")}Retry</button>`);
      err.querySelector("span").textContent = m._error;
      err.querySelector("button").addEventListener("click", regenerate);
      body.appendChild(err);
    }
    if (!m._streaming && m.content) {
      const actions = el("div", "msg-actions", `<button class="act" data-act="copy" title="Copy">${icon("copy")}</button>`);
      actions.querySelector("[data-act=copy]").addEventListener("click", (e) => copyFeedback(e.currentTarget, m.content));
      if (messages[messages.length - 1] === m) {
        const r = el("button", "act", icon("retry"));
        r.title = "Regenerate";
        r.addEventListener("click", regenerate);
        actions.appendChild(r);
      }
      body.appendChild(actions);
    }
  }

  async function copyFeedback(btn, text) {
    if (await copyText(text)) {
      btn.innerHTML = icon("check");
      setTimeout(() => (btn.innerHTML = icon("copy")), 1600);
    } else toast("Couldn't copy");
  }

  // ───────────── Scrolling ─────────────
  const thread = $("thread");
  let stick = true;
  thread.addEventListener("scroll", () => {
    const gap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    stick = gap < 120;
    $("to-bottom").hidden = stick || !current;
  });
  function scrollToBottom(force) {
    if (force) stick = true;
    if (stick) thread.scrollTop = thread.scrollHeight;
  }
  $("to-bottom").addEventListener("click", () => {
    thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
  });

  // ───────────── Composer ─────────────
  const prompt = $("prompt");
  const sendBtn = $("send-btn");
  const coarse = matchMedia("(pointer: coarse)").matches;

  function autosize() {
    prompt.style.height = "auto";
    prompt.style.height = `${Math.min(prompt.scrollHeight, 240)}px`;
  }

  function updateSend() {
    const isStreaming = !!streaming && streaming.convoId === current?.id;
    sendBtn.classList.toggle("stop", isStreaming);
    sendBtn.setAttribute("aria-label", isStreaming ? "Stop" : "Send");
    const ready = pendingFiles.every((f) => f.status === "done");
    const hasInput = prompt.value.trim() || pendingFiles.some((f) => f.status === "done");
    sendBtn.disabled = !isStreaming && (!!streaming || !hasInput || !ready);
  }

  prompt.addEventListener("input", () => { autosize(); updateSend(); });
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) {
      e.preventDefault();
      if (!sendBtn.disabled) $("composer").requestSubmit();
    }
  });
  $("composer").addEventListener("click", (e) => { if (!e.target.closest("button")) prompt.focus(); });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (sendBtn.classList.contains("stop")) streaming?.controller.abort();
    else send();
  });

  function updateSearchToggle() {
    $("search-toggle").setAttribute("aria-pressed", String(webSearch));
  }
  $("search-toggle").addEventListener("click", () => {
    webSearch = !webSearch;
    store.set("bykat:web", webSearch ? "1" : null);
    updateSearchToggle();
    toast(webSearch ? "Web search on: BykatAI can look things up" : "Web search off");
  });

  document.querySelectorAll(".suggestion").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.attach) return $("file-input").click();
      prompt.value = b.dataset.prompt;
      autosize();
      updateSend();
      send();
    }),
  );

  function titleFrom(text) {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > 48 ? `${t.slice(0, 48).trimEnd()}…` : t || "New chat";
  }

  async function send() {
    if (streaming || !user) return;
    const text = prompt.value.trim();
    if (pendingFiles.some((f) => f.status === "uploading")) return toast("Still uploading. One moment…");
    const files = pendingFiles.filter((f) => f.status === "done");
    if (!text && !files.length) return;

    sendBtn.disabled = true;
    let isNew = false;
    if (!current) {
      const { data, error } = await sb.from("conversations").insert({ title: titleFrom(text || files[0].name) }).select("id, title, updated_at").single();
      if (error) { updateSend(); return toast(`Couldn't start a chat: ${error.message}`); }
      conversations.unshift(data);
      current = data;
      messages = [];
      isNew = true;
      setHash(data.id);
      document.title = `${data.title} · BykatAI`;
      $("app").classList.add("has-thread");
      $("messages").innerHTML = "";
    }

    const attachments = files.map((f) => ({ path: f.path, name: f.name, mime_type: f.mime, size: f.size }));
    const { data: row, error } = await sb.from("messages")
      .insert({ conversation_id: current.id, role: "user", content: text, attachments })
      .select("id, role, content, attachments, created_at").single();
    if (error) { updateSend(); return toast(`Couldn't send: ${error.message}`); }

    prompt.value = "";
    autosize();
    pendingFiles = [];
    renderTray();
    messages.push(row);
    $("messages").appendChild(renderMessage(row));
    current.updated_at = row.created_at;
    conversations = [current, ...conversations.filter((c) => c.id !== current.id)];
    renderSidebar();
    scrollToBottom(true);
    streamReply(isNew);
  }

  async function regenerate() {
    if (streaming || !current) return;
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role !== "user") i--;
    if (i < 0) return;
    const lastUser = messages[i];
    const { error } = await sb.from("messages").delete().eq("conversation_id", current.id).eq("role", "model").gt("created_at", lastUser.created_at);
    if (error) return toast(`Couldn't regenerate: ${error.message}`);
    messages = messages.slice(0, i + 1);
    renderMessages();
    streamReply(false);
  }

  async function streamReply(generateTitle) {
    const convo = current;
    const m = { role: "model", content: "", _streaming: true };
    messages.push(m);
    $("messages").appendChild(renderMessage(m));
    markLast();
    scrollToBottom(true);

    const controller = new AbortController();
    streaming = { controller, convoId: convo.id };
    updateSend();
    renderSidebar();

    let frame = 0;
    const repaint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (current?.id === convo.id) { paintModel(m, false); scrollToBottom(); }
      });
    };

    try {
      const res = await callFunction({
        conversation_id: convo.id,
        model: selectedModel || undefined,
        web_search: webSearch,
        generate_title: generateTitle,
      }, controller.signal);
      if (!res.ok) throw new Error(await errorFrom(res));

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "text") { m.content += ev.text; repaint(); }
          else if (ev.type === "sources") m._sources = ev.sources;
          else if (ev.type === "title") {
            convo.title = ev.title;
            if (current?.id === convo.id) document.title = `${ev.title} · BykatAI`;
            renderSidebar();
          } else if (ev.type === "done") { if (ev.message) Object.assign(m, ev.message); }
          else if (ev.type === "error") throw new Error(ev.error);
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        m._error = /Failed to fetch|NetworkError|Load failed/i.test(e.message)
          ? "Couldn't reach BykatAI. Check your connection and try again."
          : e.message;
      }
    } finally {
      if (frame) cancelAnimationFrame(frame);
      m._streaming = false;
      streaming = null;
      if (!m.content && !m._error) {
        // Stopped before any text arrived: nothing was saved, so drop the empty bubble.
        messages = messages.filter((x) => x !== m);
        m._node?.remove();
      }
      if (current?.id === convo.id) { if (m._node?.isConnected) paintModel(m, true); markLast(); scrollToBottom(); }
      updateSend();
      renderSidebar();
    }
  }

  // ───────────── Attachments ─────────────
  function resolveMime(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const type = (file.type || "").toLowerCase();
    if (INLINE_TYPES.test(type)) return type;
    if (EXT_TYPES[ext]) return EXT_TYPES[ext];
    if (type.startsWith("text/") || /json|xml|javascript|typescript|x-sh|x-python|yaml|toml|sql/.test(type) || TEXT_EXTS.has(ext) || TEXT_EXTS.has(file.name.toLowerCase())) {
      return "text/plain";
    }
    return null;
  }

  const safeName = (name) => name.normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-100) || "file";

  function addFiles(list) {
    if (!user) return;
    for (const file of list) {
      if (pendingFiles.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files at a time`); break; }
      const mime = resolveMime(file);
      if (!mime) { toast(`“${file.name}” isn't a supported file type`); continue; }
      if (file.size > MAX_FILE_BYTES) { toast(`“${file.name}” is over 10 MB`); continue; }
      if (file.size === 0) { toast(`“${file.name}” is empty`); continue; }
      const id = crypto.randomUUID();
      const item = { id, file, name: file.name || "pasted-image.png", mime, size: file.size, status: "uploading", path: `${user.id}/${id}/${safeName(file.name || "pasted-image.png")}` };
      if (mime.startsWith("image/")) { item.preview = URL.createObjectURL(file); localPreviews.set(item.path, item.preview); }
      pendingFiles.push(item);
      sb.storage.from(BUCKET).upload(item.path, file, { contentType: mime, upsert: false }).then(({ error }) => {
        if (!pendingFiles.includes(item)) {
          if (!error) sb.storage.from(BUCKET).remove([item.path]);
          return;
        }
        item.status = error ? "error" : "done";
        if (error) toast(`Upload failed for “${item.name}”: ${error.message}`);
        renderTray();
        updateSend();
      });
    }
    renderTray();
    updateSend();
  }

  function removeFile(id) {
    const item = pendingFiles.find((f) => f.id === id);
    if (!item) return;
    pendingFiles = pendingFiles.filter((f) => f !== item);
    if (item.status === "done") sb.storage.from(BUCKET).remove([item.path]);
    if (item.preview) { URL.revokeObjectURL(item.preview); localPreviews.delete(item.path); }
    renderTray();
    updateSend();
  }

  function renderTray() {
    const tray = $("tray");
    tray.innerHTML = "";
    tray.hidden = !pendingFiles.length;
    for (const f of pendingFiles) {
      const chip = el("div", `chip${f.preview ? " img" : ""}${f.status === "error" ? " error" : ""}`);
      chip.title = f.status === "error" ? `${f.name} (upload failed)` : f.name;
      if (f.preview) {
        const img = el("img");
        img.src = f.preview;
        img.alt = f.name;
        chip.appendChild(img);
      } else {
        chip.innerHTML = `<span class="file-ico">${icon("file")}</span><span class="file-meta"><span class="file-name"></span><span class="file-sub">${esc(fileKind({ name: f.name, mime_type: f.mime }))} · ${fmtSize(f.size)}</span></span>`;
        chip.querySelector(".file-name").textContent = f.name;
      }
      if (f.status === "uploading") chip.appendChild(el("span", "spinner"));
      const x = el("button", "chip-x", icon("x"));
      x.type = "button";
      x.setAttribute("aria-label", `Remove ${f.name}`);
      x.addEventListener("click", () => removeFile(f.id));
      chip.appendChild(x);
      tray.appendChild(chip);
    }
  }

  $("attach-btn").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  prompt.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  $("main").addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("drop-overlay").hidden = false; });
  $("main").addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  $("main").addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-overlay").hidden = true; } });
  $("main").addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $("drop-overlay").hidden = true;
    addFiles([...e.dataTransfer.files]);
  });

  // ───────────── Sidebar ─────────────
  const mqMobile = matchMedia("(max-width: 860px)");
  function applySidebarPref() {
    $("app").classList.toggle("sb-hidden", store.get("bykat:sidebar") === "hidden");
  }
  function closeMobileSidebar() { $("app").classList.remove("sb-open"); }
  $("sb-collapse").addEventListener("click", () => {
    if (mqMobile.matches) return closeMobileSidebar();
    $("app").classList.add("sb-hidden");
    store.set("bykat:sidebar", "hidden");
  });
  $("sb-open").addEventListener("click", () => {
    if (mqMobile.matches) return $("app").classList.add("sb-open");
    $("app").classList.remove("sb-hidden");
    store.set("bykat:sidebar", null);
  });
  $("scrim").addEventListener("click", closeMobileSidebar);
  $("new-chat").addEventListener("click", newChat);
  $("topbar-new").addEventListener("click", newChat);
  $("brand-link").addEventListener("click", (e) => { e.preventDefault(); newChat(); });

  // ───────────── Settings ─────────────
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }
  $("user-chip").addEventListener("click", () => { closeMobileSidebar(); openModal("settings"); });
  $("settings").addEventListener("click", (e) => {
    if (e.target === $("settings") || e.target.closest("[data-close]")) closeModal("settings");
  });
  document.querySelectorAll("[data-theme-opt]").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.themeOpt;
      store.set("bykat:theme", v === "system" ? null : v);
      applyTheme(v);
    }),
  );
  $("name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    if (!name) return;
    busy(e.submitter, async () => {
      const { data, error } = await sb.auth.updateUser({ data: { full_name: name } });
      if (error) return toast(`Couldn't save: ${error.message}`);
      user = data.user;
      renderUser();
      toast("Name updated");
    });
  });
  $("delete-all").addEventListener("click", async () => {
    if (!conversations.length) return toast("You have no chats to delete");
    const yes = await dialog({ title: "Delete all chats?", text: `All ${conversations.length} chats and their files will be permanently deleted.`, ok: "Delete all", danger: true });
    if (!yes) return;
    closeModal("settings");
    deleteConversations(conversations.map((c) => c.id));
  });
  $("sign-out").addEventListener("click", async () => {
    closeModal("settings");
    authView = "signin";
    await sb.auth.signOut();
  });

  // ───────────── Dialog ─────────────
  let dialogResolve = null;
  function dialog({ title, text = "", input = null, ok = "OK", danger = false }) {
    $("dialog-title").textContent = title;
    $("dialog-text").textContent = text;
    $("dialog-text").hidden = !text;
    const field = $("dialog-input");
    field.hidden = input == null;
    field.value = input ?? "";
    $("dialog-ok").textContent = ok;
    $("dialog-ok").classList.toggle("danger-bg", danger);
    openModal("dialog");
    setTimeout(() => (input != null ? (field.focus(), field.select()) : $("dialog-ok").focus()), 0);
    return new Promise((resolve) => (dialogResolve = (v) => { closeModal("dialog"); dialogResolve = null; resolve(v); }));
  }
  $("dialog-form").addEventListener("submit", (e) => {
    e.preventDefault();
    dialogResolve?.($("dialog-input").hidden ? true : $("dialog-input").value);
  });
  $("dialog-cancel").addEventListener("click", () => dialogResolve?.(null));
  $("dialog").addEventListener("click", (e) => { if (e.target === $("dialog")) dialogResolve?.(null); });

  // ───────────── Global shortcuts ─────────────
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".model-picker")) closeModelMenu();
    if (!e.target.closest("#item-menu") && !e.target.closest(".chat-item .more")) closeItemMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (dialogResolve) return dialogResolve(null);
      if (!$("settings").hidden) return closeModal("settings");
      closeModelMenu();
      closeItemMenu();
      closeMobileSidebar();
    }
    if ($("app").hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); newChat(); }
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("app").classList.remove("sb-hidden"); $("app").classList.add("sb-open"); $("chat-search").focus(); }
  });
  window.addEventListener("resize", () => { closeItemMenu(); });
})();
