"use strict";
/* Демо-режим: имитация Supabase-клиента, данные лежат в localStorage этого браузера.
   Подключается, если config.js пустой или в адресе есть ?demo */
(function () {
  const KEY_DB = "demo_db_v1";
  const KEY_USER = "demo_user_v1";
  const ME = { id: "demo-user", email: "demo@local", user_metadata: { name: "Ты (демо)" } };
  const FRIEND = { id: "demo-friend", name: "Друг (демо)" };

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  const iso = (offsetMin = 0) => new Date(Date.now() + offsetMin * 60000).toISOString();

  function seed() {
    const duo = uid(), shared = uid(), priv = uid();
    return {
      chats: [
        { id: duo, title: "Мы вдвоём", kind: "duo", owner: ME.id, created_at: iso(-60) },
        { id: shared, title: "Идеи для проекта", kind: "shared", owner: ME.id, created_at: iso(-50) },
        { id: priv, title: "Мои заметки", kind: "private", owner: ME.id, created_at: iso(-40) }
      ],
      messages: [
        { id: uid(), chat_id: duo, author: FRIEND.id, author_name: FRIEND.name, role: "user", content: "Привет! Сайт уже открывается на телефоне?", model: null, status: "done", created_at: iso(-30), updated_at: iso(-30) },
        { id: uid(), chat_id: duo, author: ME.id, author_name: ME.user_metadata.name, role: "user", content: "Да, всё работает. Чтобы позвать ИИ в этом чате, начни сообщение с /ai", model: null, status: "done", created_at: iso(-29), updated_at: iso(-29) },
        { id: uid(), chat_id: shared, author: FRIEND.id, author_name: FRIEND.name, role: "user", content: "Придумай 3 названия для нашего проекта", model: null, status: "done", created_at: iso(-20), updated_at: iso(-20) },
        { id: uid(), chat_id: shared, author: FRIEND.id, author_name: FRIEND.name, role: "assistant", content: "Вот три варианта:\n\n1. **Дуэт** — коротко и про вас двоих\n2. **Общий контекст** — про общие чаты с ИИ\n3. **Два окна** — каждый со своим ключом\n\nМожно проверить, как выглядит код:\n\n```js\nconst chat = { title: \"Идеи\", kind: \"shared\" };\n```", model: "demo", status: "done", created_at: iso(-19), updated_at: iso(-19) }
      ]
    };
  }

  let mem = null; // копия в памяти: демо работает, даже если localStorage недоступен
  function load() {
    if (mem) return mem;
    try {
      const v = JSON.parse(localStorage.getItem(KEY_DB));
      if (v && Array.isArray(v.chats) && Array.isArray(v.messages)) { mem = v; return mem; }
    } catch { /* ignore */ }
    mem = seed();
    save(mem);
    return mem;
  }
  function save(db) { mem = db; try { localStorage.setItem(KEY_DB, JSON.stringify(db)); } catch { /* ignore */ } }

  function createDemoClient() {
    let user = ME; // по умолчанию уже "вошли"
    try {
      const raw = localStorage.getItem(KEY_USER);
      if (raw !== null) user = JSON.parse(raw);
    } catch { /* ignore */ }
    const authListeners = new Set();
    const channels = new Set();
    const emitAuth = (event) => authListeners.forEach(cb => setTimeout(() => cb(event, user ? { user } : null), 0));
    const setUser = (u) => { user = u; try { localStorage.setItem(KEY_USER, JSON.stringify(u)); } catch { /* ignore */ } };

    function emitDb(table, eventType, row, oldRow) {
      const payload = { eventType, schema: "public", table, new: row || {}, old: oldRow || {} };
      channels.forEach(ch => ch.handlers.forEach(h => { if (h.table === table) setTimeout(() => h.cb(payload), 0); }));
    }

    class Query {
      constructor(table) { this.table = table; this.op = "select"; this.filters = []; this.ord = null; this.lim = null; this.payload = null; this.wantRows = false; this.one = false; }
      select() { if (this.op === "select") this.op = "select"; else this.wantRows = true; return this; }
      insert(p) { this.op = "insert"; this.payload = p; return this; }
      update(p) { this.op = "update"; this.payload = p; return this; }
      delete() { this.op = "delete"; return this; }
      eq(col, val) { this.filters.push([col, val]); return this; }
      order(col, opts) { this.ord = [col, !(opts && opts.ascending === false)]; return this; }
      limit(n) { this.lim = n; return this; }
      single() { this.one = true; return this; }
      then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }

      match(row) { return this.filters.every(([c, v]) => row[c] === v); }

      run() {
        const db = load();
        const list = db[this.table];
        if (!list) return { data: null, error: { message: "Неизвестная таблица " + this.table } };
        const now = iso();
        const finish = (rows) => {
          if (this.one) return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "Не найдено" } };
          return { data: rows, error: null };
        };

        if (this.op === "select") {
          let rows = list.filter(r => this.match(r));
          if (this.ord) {
            const [c, asc] = this.ord;
            rows = rows.slice().sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
          }
          if (this.lim != null) rows = rows.slice(0, this.lim);
          return finish(rows.map(r => ({ ...r })));
        }

        if (this.op === "insert") {
          const p = this.payload;
          let row;
          if (this.table === "chats") {
            if (p.kind === "duo" && list.some(c => c.kind === "duo")) return { data: null, error: { code: "23505", message: "duplicate key" } };
            row = { id: uid(), owner: user ? user.id : ME.id, created_at: now, ...p };
          } else {
            row = { id: uid(), author: user ? user.id : ME.id, author_name: "", content: "", model: null, status: "done", created_at: now, updated_at: now, ...p };
          }
          list.push(row);
          save(db);
          emitDb(this.table, "INSERT", row);
          return finish([{ ...row }]);
        }

        if (this.op === "update") {
          const out = [];
          for (const r of list) if (this.match(r)) { Object.assign(r, this.payload); out.push({ ...r }); }
          save(db);
          out.forEach(r => emitDb(this.table, "UPDATE", r));
          return finish(out);
        }

        if (this.op === "delete") {
          const gone = list.filter(r => this.match(r));
          db[this.table] = list.filter(r => !this.match(r));
          if (this.table === "chats") {
            const ids = new Set(gone.map(g => g.id));
            const msgGone = db.messages.filter(m => ids.has(m.chat_id));
            db.messages = db.messages.filter(m => !ids.has(m.chat_id));
            msgGone.forEach(m => emitDb("messages", "DELETE", null, { id: m.id }));
          }
          save(db);
          gone.forEach(g => emitDb(this.table, "DELETE", null, { id: g.id }));
          return finish(gone);
        }
        return { data: null, error: { message: "Неподдерживаемая операция" } };
      }
    }

    return {
      auth: {
        async getSession() { return { data: { session: user ? { user } : null } }; },
        onAuthStateChange(cb) { authListeners.add(cb); return { data: { subscription: { unsubscribe() { authListeners.delete(cb); } } } }; },
        async signInWithPassword({ email }) {
          setUser({ ...ME, email, user_metadata: { name: (email || "демо").split("@")[0] } });
          emitAuth("SIGNED_IN");
          return { data: { user }, error: null };
        },
        async signUp({ email, options }) {
          const name = (options && options.data && options.data.name) || (email || "демо").split("@")[0];
          setUser({ ...ME, email, user_metadata: { name } });
          emitAuth("SIGNED_IN");
          return { data: { user, session: { user } }, error: null };
        },
        async signOut() { setUser(null); emitAuth("SIGNED_OUT"); return { error: null }; }
      },
      from(table) { return new Query(table); },
      channel() {
        const ch = {
          handlers: [],
          on(_type, filter, cb) { ch.handlers.push({ table: filter.table, cb }); return ch; },
          subscribe() { channels.add(ch); return ch; }
        };
        return ch;
      },
      removeChannel(ch) { channels.delete(ch); }
    };
  }

  window.createDemoClient = createDemoClient;
  window.resetDemoData = function () {
    try { localStorage.removeItem(KEY_DB); localStorage.removeItem(KEY_USER); localStorage.removeItem("lastChat"); } catch { /* ignore */ }
  };
})();
