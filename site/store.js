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
      (s.hiddenSuggestions || []).forEach((id) => (suggestions[id] = { status: "hidden" }));
      (s.added || []).forEach((a) => (suggestions[a.id] = { status: "added", data: a }));
      pendingTitles = s.pendingTitles || {};
    } catch (e) { /* хранилище недоступно */ }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({
        items: marks,
        hiddenSuggestions: Object.keys(suggestions).filter((id) => suggestions[id].status === "hidden"),
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
      db.auth.onAuthStateChange(async (_e, session) => {
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

    get: (id) => marks[id] || {},
    all: () => marks,
    setWatched: (id, watched) => patchMark(id, { watched, watched_at: watched ? new Date().toISOString() : null }),
    setRating: (id, rating) => patchMark(id, { rating }),
    setNote: (id, note) => patchMark(id, { note }),

    isHidden: (id) => suggestions[id]?.status === "hidden",
    added: () => Object.values(suggestions).filter((s) => s.status === "added").map((s) => s.data),
    hideSuggestion(id) {
      suggestions[id] = { status: "hidden" }; emit();
      if (!remote) return saveLocal();
      db.from("suggestions").upsert({ id, status: "hidden" }).then(report);
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

    async setting(key) {
      if (!remote || !user) return null;
      const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
      return data?.value || null;
    },
    onChange: (fn) => listeners.add(fn),
  };
})();
