// Хранилище отметок: «посмотрели», оценки, заметки, предложения, вписанные названия.
// Если в config.js заданы ключи Supabase — данные общие для всех, кто вошёл.
// Если нет — всё живёт только в этом браузере (localStorage).
window.Store = (() => {
  const C = window.CONFIG;
  const LOCAL_KEY = "recs-state-v1";
  const remote = !!(C.supabaseUrl && C.supabaseKey && window.supabase);
  const db = remote ? window.supabase.createClient(C.supabaseUrl, C.supabaseKey) : null;

  let user = null;
  let marks = {};            // item_id -> {watched, rating, note, ...}
  let suggestions = {};      // id -> {status, data}
  let pendingTitles = {};    // src -> title (вписано, ждёт обновления)
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());

  // ---------- local mode ----------
  function loadLocal() {
    try {
      const s = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null") || {};
      marks = s.items || {};
      (s.hiddenSuggestions || []).forEach((id) => (suggestions[id] = { status: "hidden", data: (s.hiddenData || {})[id] || null }));
      (s.added || []).forEach((a) => (suggestions[a.id] = { status: "added", data: a }));
      pendingTitles = s.pendingTitles || {};
    } catch (e) { /* хранилище недоступно */ }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({
        items: marks,
        hiddenSuggestions: Object.keys(suggestions).filter((id) => suggestions[id].status === "hidden"),
        hiddenData: Object.fromEntries(Object.entries(suggestions).filter(([, v]) => v.status === "hidden" && v.data).map(([k, v]) => [k, v.data])),
        added: Object.values(suggestions).filter((s) => s.status === "added").map((s) => s.data),
        pendingTitles,
      }));
    } catch (e) {}
  }

  // ---------- remote mode ----------
  async function loadRemote() {
    if (!user) { marks = {}; suggestions = {}; pendingTitles = {}; return; }
    const [m, s, t] = await Promise.all([
      db.from("marks").select("*"),
      db.from("suggestions").select("*"),
      db.from("manual_titles").select("src,title").eq("processed", false),
    ]);
    marks = Object.fromEntries((m.data || []).map((r) => [r.item_id, r]));
    suggestions = Object.fromEntries((s.data || []).map((r) => [r.id, r]));
    pendingTitles = Object.fromEntries((t.data || []).map((r) => [r.src, r.title]));
  }
  function report(res) {
    if (res?.error) { console.error(res.error); window.dispatchEvent(new CustomEvent("store-error", { detail: res.error.message })); }
  }

  function patchMark(id, fields) {
    marks[id] = { ...(marks[id] || {}), ...fields };
    emit();
    if (!remote) return saveLocal();
    db.from("marks").upsert({ item_id: id, ...fields, updated_at: new Date().toISOString() }).then(report);
  }

  return {
    remote,
    async init() {
      if (!remote) { loadLocal(); return; }
      const { data } = await db.auth.getSession();
      user = data.session?.user || null;
      await loadRemote();
      db.auth.onAuthStateChange(async (event, session) => {
        if (event === "PASSWORD_RECOVERY") setTimeout(() => window.dispatchEvent(new Event("password-recovery")), 300);
        const was = user?.id; user = session?.user || null;
        if (was !== user?.id) { await loadRemote(); emit(); }
      });
      // подтянуть свежие отметки, когда возвращаешься на вкладку
      window.addEventListener("focus", async () => { if (user) { await loadRemote(); emit(); } });
    },
    user: () => user,
    canEdit: () => !remote || !!user,
    async signIn(email, password) {
      const { error } = await db.auth.signInWithPassword({ email, password });
      return error ? error.message : null;
    },
    async signOut() { await db.auth.signOut(); },
    async changePassword(password) {
      const { error } = await db.auth.updateUser({ password });
      return error ? error.message : null;
    },
    async resetPassword(email) {
      const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      return error ? error.message : null;
    },

    get: (id) => marks[id] || {},
    all: () => marks,
    setWatched: (id, watched) => patchMark(id, { watched, watched_at: watched ? new Date().toISOString() : null }),
    setRating: (id, rating) => patchMark(id, { rating }),
    setNote: (id, note) => patchMark(id, { note }),
    setChecked: (id) => patchMark(id, { checked: true }),

    isHidden: (id) => suggestions[id]?.status === "hidden",
    added: () => Object.values(suggestions).filter((s) => s.status === "added").map((s) => s.data),
    hideSuggestion(id) {
      const data = suggestions[id]?.data || null;   // если это было добавленное предложение — помним его
      suggestions[id] = { status: "hidden", data }; emit();
      if (!remote) return saveLocal();
      db.from("suggestions").upsert({ id, status: "hidden", data }).then(report);
    },
    restore(id) {
      const data = suggestions[id]?.data;
      if (data) suggestions[id] = { status: "added", data }; else delete suggestions[id];
      emit();
      if (!remote) return saveLocal();
      (data ? db.from("suggestions").upsert({ id, status: "added", data }) : db.from("suggestions").delete().eq("id", id)).then(report);
    },
    addSuggestion(s) {
      suggestions[s.id] = { status: "added", data: s }; emit();
      if (!remote) return saveLocal();
      db.from("suggestions").upsert({ id: s.id, status: "added", data: s }).then(report);
    },

    pendingTitle: (src) => pendingTitles[src],
    async addTitle(src, title) {
      pendingTitles[src] = title; emit();
      if (!remote) return saveLocal();
      report(await db.from("manual_titles").insert({ src, title }));
    },

    async searchTitles(query) {
      if (!remote || !user) return [];
      const { data, error } = await db.functions.invoke("recommend", { body: { search: query } });
      return error ? [] : data?.results || [];
    },

    async askAi(prompt) {
      const { data, error } = await db.functions.invoke("recommend", { body: { prompt } });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch (e) {}
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data.result;
    },

    async setting(key) {
      if (!remote || !user) return null;
      const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
      return data?.value || null;
    },
    onChange: (fn) => listeners.add(fn),
  };
})();
