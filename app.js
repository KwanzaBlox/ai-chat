"use strict";

/* ============ Утилиты ============ */
const $ = (s, r = document) => r.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
};
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}
const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;

/* ============ Состояние ============ */
const cfg = window.APP_CONFIG || {};
let sb = null;
let DEMO = false;
let me = null;
let chats = [];
let current = null;
let msgs = [];
const nodes = new Map();      // id сообщения -> DOM-узел
const aborters = new Map();   // id сообщения -> AbortController (только то, что генерирую я)
const unread = new Set();
let channel = null;

const settings = {
  provider: LS.get("provider", "gemini"),
  keys: LS.get("keys", { gemini: "", openai: "" }),
  models: LS.get("models", { gemini: "gemini-2.5-flash", openai: "gpt-4o-mini" }),
  system: LS.get("system", "")
};
function saveSettings() {
  LS.set("provider", settings.provider);
  LS.set("keys", settings.keys);
  LS.set("models", settings.models);
  LS.set("system", settings.system);
}
const myName = () => (me?.user_metadata?.name || me?.email?.split("@")[0] || "Я");

/* ============ Старт ============ */
function show(id) {
  for (const v of ["view-setup", "view-auth", "view-app"]) $("#" + v).classList.toggle("hidden", v !== id);
}

async function init() {
  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
  const wantDemo = new URLSearchParams(location.search).has("demo") || !!window.__FORCE_DEMO__ || !configured;
  if (wantDemo && window.createDemoClient) {
    DEMO = true;
    sb = window.createDemoClient();
    setupDemoUI();
  } else if (!configured) {
    show("view-setup"); return;
  } else {
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }
  const { data } = await sb.auth.getSession();
  me = data.session?.user || null;
  route();
  sb.auth.onAuthStateChange((_e, session) => {
    const u = session?.user || null;
    if ((u?.id || null) !== (me?.id || null)) { me = u; route(); }
    else if (u) me = u;
  });
}

function route() {
  if (!me) { teardown(); show("view-auth"); return; }
  startApp();
}

function teardown() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  chats = []; current = null; msgs = []; nodes.clear(); unread.clear();
}

async function startApp() {
  show("view-app");
  $("#me-name").textContent = myName();
  $("#provider").value = settings.provider;
  await ensureDuo();
  await loadChats();
  subscribe();
  const last = LS.get("lastChat", null);
  const first = chats.find(c => c.id === last) || chats.find(c => c.kind === "duo") || chats[0];
  if (first) await selectChat(first.id);
}

async function ensureDuo() {
  const { data } = await sb.from("chats").select("id").eq("kind", "duo").limit(1);
  if (!data || !data.length) await sb.from("chats").insert({ title: "Мы вдвоём", kind: "duo" }); // дубль отсекает unique-индекс
}

/* ============ Вход / регистрация ============ */
let authMode = "login";
function setAuthMode(mode) {
  authMode = mode;
  $("#tab-login").classList.toggle("active", mode === "login");
  $("#tab-register").classList.toggle("active", mode === "register");
  $("#auth-name").classList.toggle("hidden", mode !== "register");
  $("#auth-name").required = mode === "register";
  $("#auth-submit").textContent = mode === "login" ? "Войти" : "Создать аккаунт";
  $("#auth-pass").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#auth-msg").textContent = "";
}
$("#tab-login").onclick = () => setAuthMode("login");
$("#tab-register").onclick = () => setAuthMode("register");

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-pass").value;
  const msg = $("#auth-msg");
  msg.className = "msg"; msg.textContent = "";
  $("#auth-submit").disabled = true;
  try {
    if (authMode === "login") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else {
      const name = $("#auth-name").value.trim();
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name } } });
      if (error) throw error;
      if (!data.session) {
        msg.className = "msg ok";
        msg.textContent = "Аккаунт создан. Подтверди почту или отключи «Confirm email» в Supabase (см. README), затем войди.";
      }
    }
  } catch (err) {
    msg.textContent = err.message || String(err);
  } finally {
    $("#auth-submit").disabled = false;
  }
});

$("#btn-logout").onclick = async () => { await sb.auth.signOut(); };

/* ============ Чаты ============ */
async function loadChats() {
  const { data, error } = await sb.from("chats").select("*").order("created_at", { ascending: true });
  if (error) { toast("Не удалось загрузить чаты: " + error.message); return; }
  chats = data || [];
  renderChatList();
  if (current && !chats.find(c => c.id === current.id)) {
    current = null; msgs = []; renderMessages(); updateHeader();
  }
}

function renderChatList() {
  const list = $("#chat-list");
  list.textContent = "";
  const groups = [
    ["Мы вдвоём", chats.filter(c => c.kind === "duo")],
    ["Общие", chats.filter(c => c.kind === "shared")],
    ["Мои личные", chats.filter(c => c.kind === "private")]
  ];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    const h = document.createElement("div");
    h.className = "group-title"; h.textContent = title;
    list.append(h);
    for (const c of items) {
      const b = document.createElement("button");
      b.className = "chat-item" + (current?.id === c.id ? " active" : "");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = (c.kind === "private" ? "🔒 " : c.kind === "duo" ? "💬 " : "# ") + c.title;
      b.append(t);
      if (unread.has(c.id)) { const d = document.createElement("span"); d.className = "dot"; b.append(d); }
      b.onclick = () => selectChat(c.id);
      list.append(b);
    }
  }
}

async function selectChat(id) {
  const chat = chats.find(c => c.id === id);
  if (!chat) return;
  current = chat;
  LS.set("lastChat", id);
  unread.delete(id);
  closeSidebar();
  updateHeader();
  renderChatList();
  msgs = []; renderMessages();
  const { data, error } = await sb.from("messages").select("*").eq("chat_id", id).order("created_at", { ascending: true }).limit(500);
  if (current?.id !== id) return; // успели переключиться
  if (error) { toast("Не удалось загрузить сообщения: " + error.message); return; }
  msgs = data || [];
  renderMessages();
}

function updateHeader() {
  const c = current;
  $("#chat-title").textContent = c ? c.title : "Выбери чат";
  $("#chat-sub").textContent = !c ? "" : c.kind === "private" ? "Личный — виден только тебе" : c.kind === "duo" ? "Только вы двое" : "Общий — видят оба";
  $("#btn-del-chat").classList.toggle("hidden", !(c && c.owner === me?.id && c.kind !== "duo"));
  $("#hint").textContent = c?.kind === "duo" ? "Это живой чат между вами. Чтобы позвать ИИ, начни сообщение с /ai" : "";
  $("#input").placeholder = c?.kind === "duo" ? "Сообщение (или /ai вопрос)…" : "Сообщение для ИИ…";
}

$("#btn-new").onclick = () => { $("#new-title").value = ""; $("#dlg-new").showModal(); closeSidebar(); };
$("#new-cancel").onclick = () => $("#dlg-new").close();
$("#form-new").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#new-title").value.trim();
  const kind = new FormData($("#form-new")).get("kind");
  $("#dlg-new").close();
  if (!title) return;
  const { data, error } = await sb.from("chats").insert({ title, kind }).select().single();
  if (error) { toast("Ошибка: " + error.message); return; }
  await loadChats();
  selectChat(data.id);
});

$("#btn-del-chat").onclick = async () => {
  if (!current || !confirm(`Удалить чат «${current.title}» вместе со всеми сообщениями?`)) return;
  const { error } = await sb.from("chats").delete().eq("id", current.id);
  if (error) { toast("Ошибка: " + error.message); return; }
  current = null; msgs = [];
  await loadChats(); updateHeader(); renderMessages();
  const next = chats.find(c => c.kind === "duo") || chats[0];
  if (next) selectChat(next.id);
};

/* ============ Боковая панель на телефоне ============ */
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#backdrop").classList.remove("show"); }
$("#btn-menu").onclick = () => { $("#sidebar").classList.add("open"); $("#backdrop").classList.add("show"); };
$("#backdrop").onclick = closeSidebar;

/* ============ Realtime ============ */
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("app-db")
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, onMessageChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "chats" }, () => loadChats())
    .subscribe();
}

function onMessageChange(p) {
  if (p.eventType === "DELETE") {
    const id = p.old?.id;
    if (!id) return;
    msgs = msgs.filter(m => m.id !== id);
    nodes.get(id)?.remove(); nodes.delete(id);
    return;
  }
  const row = p.new;
  if (!row) return;
  if (row.chat_id !== current?.id) {
    if (p.eventType === "INSERT" && row.author !== me.id) { unread.add(row.chat_id); renderChatList(); }
    return;
  }
  const i = msgs.findIndex(m => m.id === row.id);
  if (i === -1) { msgs.push(row); }
  else {
    if (aborters.has(row.id)) return; // этот ответ я генерирую сам — локальная копия свежее
    msgs[i] = row;
  }
  upsertNode(row);
}

/* ============ Рендер сообщений ============ */
function nearBottom() {
  const el = $("#messages");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function scrollDown() { const el = $("#messages"); el.scrollTop = el.scrollHeight; }

function renderMessages() {
  const box = $("#messages");
  box.textContent = "";
  nodes.clear();
  if (!current) { box.innerHTML = '<div class="empty">Выбери чат слева или создай новый</div>'; return; }
  if (!msgs.length) {
    const e = document.createElement("div");
    e.className = "empty"; e.textContent = "Пока пусто. Напиши первое сообщение.";
    box.append(e); return;
  }
  for (const m of msgs) upsertNode(m, true);
  scrollDown();
}

function isStale(m) {
  return m.status === "generating" && !aborters.has(m.id) && Date.now() - new Date(m.updated_at || m.created_at).getTime() > 60000;
}

function renderMarkdown(text) {
  const html = window.DOMPurify.sanitize(window.marked.parse(text || "", { breaks: true }));
  const tpl = document.createElement("div");
  tpl.innerHTML = html;
  tpl.querySelectorAll("a").forEach(a => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  tpl.querySelectorAll("pre").forEach(pre => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "copy-code"; b.textContent = "Копировать";
    b.onclick = () => copyText(pre.querySelector("code")?.textContent || pre.textContent);
    pre.append(b);
  });
  return tpl;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Скопировано"); }
  catch { toast("Не удалось скопировать"); }
}

function upsertNode(m, skipScroll) {
  const box = $("#messages");
  const stick = nearBottom();
  box.querySelector(".empty")?.remove();

  let node = nodes.get(m.id);
  if (!node) {
    node = document.createElement("div");
    node.dataset.id = m.id;
    nodes.set(m.id, node);
    box.append(node);
  }
  const ai = m.role === "assistant";
  const mine = m.author === me.id;
  node.className = "m " + (ai ? "ai" : mine ? "mine" : "") ;
  node.textContent = "";

  const head = document.createElement("div");
  head.className = "m-head";
  const who = document.createElement("b");
  who.textContent = ai ? "ИИ" : (m.author_name || "Аноним");
  head.append(who);
  if (ai) {
    const sub = document.createElement("span");
    sub.textContent = `${m.model || ""} · запустил(а) ${m.author_name || "?"}`;
    head.append(sub);
  }
  const st = document.createElement("span");
  if (m.status === "generating" && !isStale(m)) { st.className = "status gen"; st.textContent = "генерирует…"; head.append(st); }
  else if (isStale(m)) { st.className = "status stale"; st.textContent = "прервано"; head.append(st); }
  else if (m.status === "error") { st.className = "status err"; st.textContent = "ошибка"; head.append(st); }

  const tools = document.createElement("div");
  tools.className = "m-tools";
  if (aborters.has(m.id)) {
    const stop = document.createElement("button");
    stop.type = "button"; stop.textContent = "■ Стоп";
    stop.onclick = () => aborters.get(m.id)?.abort();
    tools.append(stop);
  } else {
    const cp = document.createElement("button");
    cp.type = "button"; cp.textContent = "Копировать";
    cp.onclick = () => copyText(m.content);
    tools.append(cp);
    if (m.author === me.id) {
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "✕";
      del.title = "Удалить";
      del.onclick = async () => { const { error } = await sb.from("messages").delete().eq("id", m.id); if (error) toast(error.message); };
      tools.append(del);
    }
  }
  head.append(tools);
  node.append(head);

  const body = document.createElement("div");
  if (ai) {
    body.className = "m-body" + (m.status === "generating" && !isStale(m) ? " caret" : "");
    body.append(renderMarkdown(m.content));
  } else {
    body.className = "m-body plain";
    body.textContent = m.content;
  }
  node.append(body);

  if (!skipScroll && stick) scrollDown();
}

/* ============ Отправка ============ */
const input = $("#input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; }
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !isTouch) { e.preventDefault(); send(); }
});
$("#btn-send").onclick = send;
$("#provider").onchange = (e) => { settings.provider = e.target.value; saveSettings(); };

async function send() {
  if (!current) { toast("Сначала выбери чат"); return; }
  let text = input.value.trim();
  if (!text) return;
  const chat = current;
  const isDuo = chat.kind === "duo";
  const wantsAI = !isDuo || /^\/ai(\s|$)/i.test(text);
  if (wantsAI && !DEMO && !settings.keys[settings.provider]) {
    toast("Добавь API-ключ в настройках (⚙)");
    openSettings();
    return;
  }
  input.value = ""; autosize();

  const { data, error } = await sb.from("messages").insert({
    chat_id: chat.id, author_name: myName(), role: "user", content: text, status: "done"
  }).select().single();
  if (error) { toast("Не отправилось: " + error.message); input.value = text; return; }
  if (!msgs.find(m => m.id === data.id)) msgs.push(data);
  upsertNode(data);
  scrollDown();

  if (wantsAI) generate(chat);
}

/* ============ Генерация ИИ ============ */
function buildHistory(chat) {
  const shared = chat.kind !== "private";
  const out = [];
  for (const m of msgs.slice(-40)) {
    if (m.status === "error" || !m.content) continue;
    if (m.role === "assistant") { out.push({ role: "assistant", content: m.content }); continue; }
    const clean = m.content.replace(/^\/ai(\s|$)/i, "").trim();
    if (!clean) continue;
    out.push({ role: "user", content: shared ? `${m.author_name}: ${clean}` : clean });
  }
  return out;
}

function systemPrompt(chat) {
  let s = settings.system.trim();
  if (chat.kind !== "private") {
    s += (s ? "\n\n" : "") + "Это общий чат двух людей. Сообщения помечены именами авторов. Отвечай тому, кто спросил, не добавляя своё имя в начало ответа.";
  }
  return s;
}

async function generate(chat) {
  const provider = settings.provider;
  const key = settings.keys[provider];
  const fake = DEMO && !key;               // в демо без ключа отвечает заглушка
  const model = fake ? "demo" : settings.models[provider];
  const history = buildHistory(chat);
  const system = systemPrompt(chat);

  const { data: row, error } = await sb.from("messages").insert({
    chat_id: chat.id, author_name: myName(), role: "assistant", content: "",
    model: fake ? "demo" : `${provider}:${model}`, status: "generating"
  }).select().single();
  if (error) { toast("Не удалось начать генерацию: " + error.message); return; }

  const ac = new AbortController();
  aborters.set(row.id, ac);
  if (current?.id === chat.id && !msgs.find(m => m.id === row.id)) msgs.push(row);
  if (current?.id === chat.id) upsertNode(row);

  let text = "";
  let lastPush = 0;
  let chain = Promise.resolve();
  const push = (patch) => {
    chain = chain.then(() => sb.from("messages").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", row.id)).catch(() => {});
    return chain;
  };
  const refresh = () => { if (current?.id === chat.id) upsertNode(row); };

  try {
    const stream = fake
      ? streamDemo(history, ac.signal)
      : provider === "openai"
        ? streamOpenAI(key, model, system, history, ac.signal)
        : streamGemini(key, model, system, history, ac.signal);
    for await (const chunk of stream) {
      text += chunk;
      row.content = text;
      refresh();
      const now = Date.now();
      if (now - lastPush > 350) { lastPush = now; push({ content: text }); }
    }
    row.status = "done";
    if (!text) { row.content = "(пустой ответ)"; text = row.content; }
    await push({ content: text, status: "done" });
  } catch (e) {
    if (e.name === "AbortError") {
      row.status = "done";
      row.content = text ? text + "\n\n*(остановлено)*" : "*(остановлено)*";
      await push({ content: row.content, status: "done" });
    } else {
      row.status = "error";
      row.content = (text ? text + "\n\n" : "") + "⚠️ " + (e.message || String(e));
      await push({ content: row.content, status: "error" });
    }
  } finally {
    aborters.delete(row.id);
    const i = msgs.findIndex(m => m.id === row.id);
    if (i !== -1) msgs[i] = row;
    refresh();
  }
}

/* Демо-ответ без ключа: стримится по словам, как настоящий */
async function* streamDemo(history, signal) {
  const last = [...history].reverse().find(m => m.role === "user")?.content || "";
  const q = last.replace(/^[^:\n]{1,30}:\s*/, "").slice(0, 200);
  const text =
    "Это **демо-ответ**: настоящий ИИ не подключён.\n\n" +
    `Ты написал: «${q}»\n\n` +
    "Чтобы получать настоящие ответы, открой ⚙ и вставь ключ Gemini или OpenAI.\n\n" +
    "```js\nconsole.log(\"Привет из демо!\");\n```\n\n" +
    "Ответ идёт потоком, а в общем чате второй человек видит, как он печатается.";
  for (const part of text.split(/(\s+)/)) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    yield part;
    await new Promise(r => setTimeout(r, 35));
  }
}

function setupDemoUI() {
  const bar = document.createElement("div");
  bar.className = "demo-badge";
  bar.innerHTML = "<span>ДЕМО</span>";
  const reset = document.createElement("button");
  reset.type = "button"; reset.textContent = "Сбросить";
  reset.title = "Удалить демо-данные и начать заново";
  reset.onclick = () => { window.resetDemoData?.(); location.reload(); };
  bar.append(reset);
  $("#sidebar").append(bar);
}

async function errorText(res) {
  try {
    const j = await res.json();
    return `${res.status}: ${j.error?.message || JSON.stringify(j).slice(0, 300)}`;
  } catch { return `${res.status} ${res.statusText}`; }
}

async function* sseLines(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (d && d !== "[DONE]") yield d;
      }
    }
  }
}

async function* streamOpenAI(key, model, system, history, signal) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push(...history);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model, stream: true, messages })
  });
  if (!res.ok) throw new Error(await errorText(res));
  for await (const d of sseLines(res)) {
    let j; try { j = JSON.parse(d); } catch { continue; }
    const t = j.choices?.[0]?.delta?.content;
    if (t) yield t;
  }
}

async function* streamGemini(key, model, system, history, signal) {
  // Gemini ждёт роли user/model; склеиваем подряд идущие одинаковые
  const contents = [];
  for (const m of history) {
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n\n" + m.content;
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await errorText(res));
  for await (const d of sseLines(res)) {
    let j; try { j = JSON.parse(d); } catch { continue; }
    const parts = j.candidates?.[0]?.content?.parts || [];
    for (const p of parts) if (p.text) yield p.text;
    if (j.promptFeedback?.blockReason) throw new Error("Запрос заблокирован: " + j.promptFeedback.blockReason);
  }
}

/* ============ Настройки ============ */
function openSettings() {
  $("#set-key-gemini").value = settings.keys.gemini || "";
  $("#set-key-openai").value = settings.keys.openai || "";
  $("#set-model-gemini").value = settings.models.gemini || "";
  $("#set-model-openai").value = settings.models.openai || "";
  $("#set-system").value = settings.system || "";
  closeSidebar();
  $("#dlg-settings").showModal();
}
$("#btn-settings").onclick = openSettings;
$("#set-cancel").onclick = () => $("#dlg-settings").close();
$("#form-settings").addEventListener("submit", () => {
  settings.keys = { gemini: $("#set-key-gemini").value.trim(), openai: $("#set-key-openai").value.trim() };
  settings.models = {
    gemini: $("#set-model-gemini").value.trim() || "gemini-2.5-flash",
    openai: $("#set-model-openai").value.trim() || "gpt-4o-mini"
  };
  settings.system = $("#set-system").value;
  saveSettings();
  toast("Сохранено");
});

init();
