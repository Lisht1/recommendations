(() => {
  const C = window.CONFIG, S = window.Store;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let catalog = { items: [], unknown: [] };
  let items = [];
  const f = {
    cat: "all", q: "", sort: "added", showWatched: false, onlySoon: false, onlyCheck: false, showRemoved: false,
    minRating: 0, yearFrom: null, yearTo: null, providers: new Set(), genres: new Set(), sources: new Set(),
  };

  // ---------- helpers ----------
  const TYPE_LABEL = { movie: "Фильм", tv: "Сериал" };
  // «Проверить»: название угадано вручную или не нашлось в TMDB
  const needsCheck = (t) => (t.confidence === "check" || (catalog.enriched && !t.matched))
    && !S.get(t.id).checked && !S.pendingTitle("fix:" + t.id);
  function hue(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function posterHtml(t, cls = "") {
    if (t.poster) return `<div class="poster ${cls}"><img loading="lazy" src="${esc(t.poster)}" alt=""></div>`;
    const h = hue(t.title_ru || t.title || "?");
    return `<div class="poster ${cls}"><div class="ph" style="background:linear-gradient(160deg,hsl(${h} 45% 28%),hsl(${(h + 40) % 360} 50% 12%))">${esc(t.title_ru || t.title)}</div></div>`;
  }
  function bestRating(t) {
    const mine = S.get(t.id).rating;
    if (mine) return mine;
    const r = t.ratings || {};
    return r.imdb ?? r.kp ?? r.shiki ?? r.tmdb ?? 0;
  }
  function ratingsHtml(t, big = false) {
    const r = t.ratings || {}, mine = S.get(t.id).rating, out = [];
    const add = (label, val, cls = "") => out.push(`<span class="r ${cls}"><b>${val}</b><i>${label}</i></span>`);
    if (mine) add("МОЯ", mine, "mine");
    if (r.imdb) add("IMDb", r.imdb, r.imdb >= 7.5 ? "hi" : "");
    if (r.kp) add("КП", r.kp, r.kp >= 7.5 ? "hi" : "");
    if (r.shiki) add("Shiki", r.shiki, r.shiki >= 8 ? "hi" : "");
    if (big && r.rt != null) add("RT", r.rt + "%", r.rt >= 85 ? "hi" : "");
    if (big && r.meta != null) add("Meta", r.meta, r.meta >= 75 ? "hi" : "");
    if (!r.imdb && !r.kp && !r.shiki && r.tmdb) add("TMDB", r.tmdb, r.tmdb >= 7.5 ? "hi" : "");
    return out.join("");
  }
  // кто порекомендовал: канал, автор рилса или свои посты
  function sourceName(src) {
    if (!src?.from) return null;
    if (src.from.startsWith("Instagram")) return "Instagram";
    if (src.from.startsWith("Может понравиться") || src.from === "Добавлено на сайте") return "Добавлено на сайте";
    return src.from;
  }
  function sourceLine(t) {
    const names = [...new Set((t.sources || []).map(sourceName).filter(Boolean))];
    if (!names.length) return "";
    return (names[0] === "Свои посты" ? "свой пост" : "от " + names[0]) + (names.length > 1 ? ` и ещё ${names.length - 1}` : "");
  }
  function subline(t) {
    return [t.year, t.type || TYPE_LABEL[t.media], t.countries?.slice(0, 2).join(", ")].filter(Boolean).join(" · ");
  }
  function toast(msg, undo) {
    const el = $("#toast");
    el.innerHTML = esc(msg) + (undo ? ` <button class="toast-undo">Отменить</button>` : "");
    el.hidden = false;
    if (undo) el.querySelector(".toast-undo").onclick = () => { undo(); el.hidden = true; };
    clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), undo ? 5000 : 2200);
  }

  // ---------- filtering ----------
  function matches(t, ignoreCat = false) {
    const st = S.get(t.id);
    if (f.cat === "watched") { if (!ignoreCat && !st.watched) return false; }
    else if (!ignoreCat && f.cat !== "all" && t.category !== f.cat) return false;
    if (f.cat !== "watched" && !f.showWatched && st.watched) return false;
    if (f.showRemoved !== S.isHidden(t.id)) return false;
    if (f.onlySoon && !t.soon) return false;
    if (f.onlyCheck && !needsCheck(t)) return false;
    if (f.minRating && bestRating(t) < f.minRating) return false;
    if (f.yearFrom && (!t.year || t.year < f.yearFrom)) return false;
    if (f.yearTo && (!t.year || t.year > f.yearTo)) return false;
    if (f.providers.size && ![...f.providers].some((p) => t.providers?.[p])) return false;
    if (f.sources.size && !(t.sources || []).some((x) => f.sources.has(sourceName(x)))) return false;
    if (f.genres.size && ![...f.genres].every((g) => t.genres?.includes(g))) return false;
    if (f.q) {
      const hay = [t.title_ru, t.title_en, t.title_orig, t.type, ...(t.genres || []), ...(t.countries || []), ...(t.notes || [])]
        .join(" ").toLowerCase();
      if (!f.q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }
  function sorted(list) {
    const by = {
      added: (a, b) => (b.added || "").localeCompare(a.added || ""),
      rating: (a, b) => bestRating(b) - bestRating(a),
      year: (a, b) => (b.year || 0) - (a.year || 0),
      title: (a, b) => (a.title_ru || "").localeCompare(b.title_ru || "", "ru"),
    }[f.sort];
    if (f.cat === "watched" && f.sort === "added") {
      return [...list].sort((a, b) => (S.get(b.id).watched_at || "").localeCompare(S.get(a.id).watched_at || ""));
    }
    return [...list].sort(by);
  }

  // ---------- rendering ----------
  function renderTabs() {
    const counts = {};
    items.forEach((t) => { if (matches(t, true)) { counts[t.category] = (counts[t.category] || 0) + 1; counts.all = (counts.all || 0) + 1; } });
    $("#tabs").innerHTML = C.categories.map((c) => {
      const n = c.id === "suggest" ? "" : c.id === "watched"
        ? `<span class="n">${items.filter((t) => S.get(t.id).watched).length}</span>`
        : c.id === "unknown"
        ? `<span class="n">${(catalog.unknown || []).filter((u) => !S.pendingTitle(u.src)).length}</span>`
        : `<span class="n">${counts[c.id] || 0}</span>`;
      return `<button class="tab ${f.cat === c.id ? "active" : ""}" data-cat="${c.id}">${c.label}${n}</button>`;
    }).join("");
  }

  function cardHtml(t) {
    const st = S.get(t.id);
    const badges = [
      t.soon && `<span class="badge soon">Скоро</span>`,
      needsCheck(t) && `<span class="badge check">Проверить</span>`,
      st.dropped && `<span class="badge dropped">Брошено</span>`,
    ].filter(Boolean).join("");
    return `<article class="card ${st.watched ? "watched" : ""}" data-id="${esc(t.id)}">
      <div style="position:relative">${posterHtml(t)}
        <div class="badges">${badges}</div>
        ${st.rating ? `<div class="my-rating" title="Ваша оценка">★ ${st.rating}</div>` : ""}
        <div class="quick">${S.isHidden(t.id)
          ? `<button class="restore-btn" data-act="restore" title="Вернуть в список">↩</button>`
          : `<button data-act="remove" title="Удалить из списка">✕</button><button class="seen-btn" data-act="seen" title="${st.watched ? "Вернуть в список" : "Посмотрели"}">✓</button>`}</div>
      </div>
      <div class="card-title">${esc(t.title_ru || t.title_en)}</div>
      <div class="card-sub">${esc(subline(t))}</div>
      ${sourceLine(t) ? `<div class="card-from">${esc(sourceLine(t))}</div>` : ""}
      <div class="ratings">${ratingsHtml(t)}</div>
    </article>`;
  }

  function render() {
    renderTabs();
    if (f.cat === "suggest") return renderSuggestions();
    if (f.cat === "unknown") return renderUnknown();
    $("#grid").classList.toggle("watched-tab", f.cat === "watched");
    const list = sorted(items.filter((t) => matches(t)));
    $("#grid").innerHTML = list.map(cardHtml).join("");
    $("#empty").hidden = list.length > 0;
    const watched = items.filter((t) => S.get(t.id).watched).length;
    $("#count").textContent = `${list.length} из ${items.length}` + (watched ? ` · просмотрено ${watched}` : "");
  }

  function renderFilters() {
    const genres = {}, provs = {}, srcs = {};
    items.forEach((t) => {
      new Set((t.sources || []).map(sourceName).filter(Boolean)).forEach((n) => (srcs[n] = (srcs[n] || 0) + 1));
      (t.genres || []).forEach((g) => (genres[g] = (genres[g] || 0) + 1));
      Object.keys(t.providers || {}).forEach((p) => (provs[p] = (provs[p] || 0) + 1));
    });
    const chip = (kind, name) => `<button class="chip ${f[kind].has(name) ? "on" : ""}" data-kind="${kind}" data-v="${esc(name)}">${esc(name)}</button>`;
    const g = Object.entries(genres).sort((a, b) => b[1] - a[1]).map(([n]) => chip("genres", n));
    const p = Object.entries(provs).sort((a, b) => b[1] - a[1]).map(([n]) => chip("providers", n));
    $("#genreChips").innerHTML = g.join("") || `<span class="muted small">Появятся после подключения TMDB</span>`;
    $("#providerChips").innerHTML = p.join("") || `<span class="muted small">Появятся после подключения TMDB</span>`;
    // частые источники отдельно, редкие авторы рилсов собираем в «Instagram: другие»
    const srcList = Object.entries(srcs).sort((a, b) => b[1] - a[1]);
    const shown = srcList.filter(([n, c]) => c >= 3 || f.sources.has(n)).slice(0, 14);
    $("#sourceChips").innerHTML = shown.map(([n, c]) =>
      `<button class="chip ${f.sources.has(n) ? "on" : ""}" data-kind="sources" data-v="${esc(n)}">${esc(n)} <span class="n">${c}</span></button>`).join("");
  }

  // ---------- suggestions ("может понравиться") ----------
  function suggestions() {
    const have = new Set(items.map((t) => t.id));
    const pool = {};
    items.forEach((t) => {
      const st = S.get(t.id);
      if ((st.rating && st.rating < 6) || st.dropped) return; // похожее на то, что не понравилось, не предлагаем
      const weight = st.rating ? st.rating / 5 : 1;
      (t.similar || []).forEach((s) => {
        if (have.has(s.id) || S.isHidden(s.id)) return;
        const p = (pool[s.id] ||= { ...s, score: 0, because: [] });
        p.score += weight;
        if (p.because.length < 3) p.because.push(t.title_ru);
      });
    });
    return Object.values(pool).filter((p) => p.score >= 1.5 || p.because.length > 1)
      .sort((a, b) => b.score - a.score).slice(0, 60);
  }

  function renderSuggestions() {
    const list = suggestions();
    $("#grid").innerHTML = list.map((s) => `
      <article class="card" data-sugg="${esc(s.id)}">
        ${posterHtml(s)}
        <div class="card-title">${esc(s.title)}</div>
        <div class="card-sub">${esc(s.year || "")}</div>
        <div class="sugg-why">Похоже на: ${esc(s.because.join(", "))}</div>
        <div class="sugg-actions">
          <button class="btn" data-act="add">В список</button>
          <button class="btn" data-act="watched" title="Уже смотрели — добавить в просмотренное и оценить">✓ Видели</button>
          <button class="btn ghost" data-act="hide" title="Не интересно">Скрыть</button>
        </div>
      </article>`).join("");
    $("#empty").hidden = list.length > 0;
    $("#empty").textContent = items.some((t) => t.similar?.length)
      ? "Пока нечего предложить."
      : "Предложения появятся после подключения TMDB: у каждой карточки будет список похожего.";
    $("#count").textContent = list.length ? `${list.length} предложений по вашему списку` : "";
  }

  // ---------- detail modal ----------
  function linksHtml(t) {
    const L = C.links, out = [];
    const a = (cls, label, href) => href && out.push(`<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`);
    a("kinopub", "Кинопаб", L.kinopub(t));
    if (t.providers?.Netflix) a("netflix", "Netflix", L.netflix(t));
    if (t.providers?.["Apple TV+"]) a("", "Apple TV", L.appletv(t));
    if (t.category === "anime") a("", "Yummy Anime", L.yummy(t));
    a("", "Кинопоиск", L.kinopoisk(t));
    a("", "IMDb", L.imdb(t));
    if (t.category === "anime") a("", "Shikimori", L.shikimori(t));
    a("", "TMDB", L.tmdb(t));
    return out.join("");
  }
  function whereHtml(t) {
    const p = t.providers || {};
    if (!Object.keys(p).length) return `<div class="muted">${t.matched ? "Нет данных о стримингах" : "Появится после подключения TMDB"}</div>`;
    return Object.entries(p).map(([name, regions]) => {
      const short = regions.slice(0, 6).join(", ") + (regions.length > 6 ? ` и ещё ${regions.length - 6}` : "");
      return `<div title="${esc(regions.join(", "))}"><b>${esc(name)}</b>: <span class="muted">${esc(short)}</span></div>`;
    }).join("");
  }

  function openDetail(id) {
    const t = items.find((x) => x.id === id);
    if (!t) return;
    const st = S.get(t.id);
    const have = new Set(items.map((x) => x.id));
    const facts = [t.year, t.type, t.countries?.join(", "), t.runtime && `${t.runtime} мин`, t.seasons && `${t.seasons} сез.`, t.genres?.join(", ")].filter(Boolean);
    const sources = (t.sources || []).map((s) =>
      `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.from)}</a>${s.date ? ` · ${esc(s.date)}` : ""}</li>`).join("");
    const similar = (t.similar || []).slice(0, 8).map((s) => have.has(s.id) ? `
      <div class="card" data-id="${esc(s.id)}">${posterHtml(s)}
        <div class="card-title">${esc(s.title)}</div>
        <div class="in-list">уже в списке</div>
      </div>` : `
      <div class="card sim-out">
        <a href="https://www.themoviedb.org/${esc(s.id.replace("-", "/"))}" target="_blank" rel="noopener" title="Открыть на TMDB">${posterHtml(s)}</a>
        <div class="card-title">${esc(s.title)}</div>
        <div class="card-sub">${esc(s.year || "")}</div>
        <button class="btn sim-add" data-sim-add="${esc(s.id)}">+ В список</button>
      </div>`).join("");

    $("#detail").innerHTML = `
      <button class="close" data-close>&times;</button>
      <div class="hero" style="${t.backdrop ? `background-image:url('${esc(t.backdrop)}')` : ""}"></div>
      <div class="detail-head">
        ${posterHtml(t)}
        <div>
          <h2>${esc(t.title_ru || t.title_en)}</h2>
          ${t.title_en && t.title_en !== t.title_ru ? `<div class="orig">${esc(t.title_en)}</div>` : ""}
          <div class="facts">${facts.map((x) => `<span>${esc(x)}</span>`).join("")}</div>
          <div class="big-ratings ratings">${ratingsHtml(t, true)}</div>
        </div>
      </div>
      <div class="detail-main">
        <div>
          ${needsCheck(t) ? `
          <div class="check-box">
            <div><b>${t.matched ? "Точно этот тайтл?" : "Не нашли этот тайтл в базе фильмов"}</b><br>
              <span class="muted small">${t.matched
                ? "Название в посте было неоднозначным, мы угадали. Проверь постер и год."
                : "Возможно, название записано неточно. Впиши правильное — оно подтянется при обновлении."}</span></div>
            <div class="check-actions">
              ${t.matched ? `<button class="btn" data-act="confirm">Всё верно</button>` : ""}
              <form class="fix-form"><input name="title" autocomplete="off" placeholder="Начни писать название или вставь ссылку"><button class="btn">Исправить</button></form>
            </div>
          </div>` : ""}
          ${S.pendingTitle("fix:" + t.id) ? `<div class="pending" style="margin-bottom:14px">✓ Исправление «${esc(S.pendingTitle("fix:" + t.id).replace(/\s*\[tmdb=[^\]]+\]/, ""))}» применится при следующем обновлении</div>` : ""}
          <h4>О чём</h4>
          <p class="overview">${esc(t.overview || "Описание появится после подключения TMDB.")}</p>
          <h4>Смотреть</h4>
          <div class="links">${linksHtml(t)}</div>
          ${similar ? `<h4>Похожее</h4><div class="similar">${similar}</div>` : ""}
        </div>
        <div>
          <div class="mine-box">
            <button class="btn ${st.watched && !st.dropped ? "on" : ""}" data-act="seen">${st.watched && !st.dropped ? "✓ Посмотрели" : "Отметить просмотренным"}</button>
            <button class="btn ghost ${st.dropped ? "on-dropped" : ""}" data-act="drop">${st.dropped ? "✗ Бросили" : "Бросили, не досмотрели"}</button>
            <div class="small muted" style="margin-bottom:6px">Ваша оценка</div>
            <div class="stars">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button class="${st.rating === n ? "on" : ""}" data-rate="${n}">${n}</button>`).join("")}</div>
            <textarea id="note" rows="3" placeholder="Заметка: что понравилось, с кем смотреть…">${esc(st.note || "")}</textarea>
            ${S.isHidden(t.id)
              ? `<button class="btn ghost wide" data-act="restore" style="margin-top:10px">↩ Вернуть в список</button>`
              : `<button class="btn ghost wide danger" data-act="remove" style="margin-top:10px">Удалить из списка</button>`}
          </div>
          <h4>Где доступно</h4>
          <div class="where">${whereHtml(t)}</div>
          <h4>Откуда в списке</h4>
          <div class="sources"><ul>${sources}</ul>${t.notes?.length ? `<p class="muted">${esc(t.notes.join("; "))}</p>` : ""}</div>
        </div>
      </div>`;
    $("#detail").dataset.id = t.id;
    if (!$("#detail").open) $("#detail").showModal();
    $("#detail").scrollTop = 0;
  }

  // ---------- AI prompt ----------
  function tasteSummary() {
    const g = {}, cats = {};
    items.forEach((t) => {
      const w = S.get(t.id).rating ? S.get(t.id).rating / 5 : 1;
      (t.genres || []).forEach((x) => (g[x] = (g[x] || 0) + w));
      cats[t.category] = (cats[t.category] || 0) + 1;
    });
    const top = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n]) => n);
    const catNames = Object.fromEntries(C.categories.map((c) => [c.id, c.label]));
    const mix = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${catNames[c] || c}: ${n}`).join(", ");
    return { top, mix };
  }
  function buildPrompt(query, outside, asJson = false) {
    const line = (t) => `${t.title_ru}${t.title_en && t.title_en !== t.title_ru ? ` / ${t.title_en}` : ""}${t.year ? ` (${t.year})` : ""}`;
    const rated = items.filter((t) => S.get(t.id).watched || S.get(t.id).rating)
      .map((t) => { const s = S.get(t.id); return `- ${line(t)}: ${s.dropped ? "БРОСИЛИ, не смогли досмотреть" : s.rating ? s.rating + "/10" : "посмотрели, без оценки"}${s.note ? ` — «${s.note}»` : ""}`; });
    const todo = items.filter((t) => !S.get(t.id).watched).map((t) => `- ${line(t)} [${t.type || ""}]`);
    const { top, mix } = tasteSummary();
    return [
      "Помоги выбрать, что посмотреть вечером. Мы — пара, смотрим вместе.",
      "",
      `Запрос: ${query || "что-нибудь хорошее под настроение"}`,
      "",
      `Что мы обычно сохраняем: ${mix}. Частые жанры: ${top.join(", ") || "—"}.`,
      "",
      rated.length ? `Уже посмотрели и оценили:\n${rated.join("\n")}` : "Оценок пока нет.",
      "",
      `Наш список «хотим посмотреть» (${todo.length}):\n${todo.join("\n")}`,
      "",
      outside
        ? "Предложи 5 вариантов: сначала из нашего списка, затем 2–3 тайтла, которых в списке нет, но которые нам подойдут. Ничего из просмотренного не предлагай."
        : "Предложи 5 вариантов только из нашего списка. Ничего из просмотренного не предлагай.",
      asJson
        ? [
          "Ответь строго JSON такого вида:",
          '{"intro": "1–2 предложения: как ты понял запрос", "picks": [{"title": "название как в нашем списке или русское название", "title_en": "оригинальное или английское название", "year": 2020, "in_list": true, "why": "одна фраза, почему подходит", "duration": "1 ч 50 мин или 2 сезона по 45 мин"}]}',
          "in_list: true — если тайтл есть в нашем списке «хотим посмотреть», иначе false.",
        ].join("\n")
        : "Для каждого: одна строка, почему подходит под запрос, и длительность (фильм — минуты, сериал — сезоны и длина серии).",
    ].join("\n");
  }

  // ---------- подсказки названий в полях «Исправить» / «Неразобранное» ----------
  // Выбранная подсказка сохраняется с точным id TMDB, поэтому карточка подтянется без ошибок.
  function typedTitle(input) {
    const v = input.value.trim();
    return input.dataset.exact ? `${v} [tmdb=${input.dataset.exact.replace("-", "/")}]` : v;
  }
  let suggestTimer;
  function onTitleInput(input) {
    delete input.dataset.exact;
    clearTimeout(suggestTimer);
    const form = input.closest("form");
    const box = form.querySelector(".suggest-list") || form.appendChild(Object.assign(document.createElement("div"), { className: "suggest-list" }));
    const q = input.value.trim();
    if (q.length < 2 || !S.user()) { box.innerHTML = ""; return; }
    suggestTimer = setTimeout(async () => {
      const results = await S.searchTitles(q);
      if (input.value.trim() !== q) return;
      box.innerHTML = results.map((r) => `
        <button type="button" class="suggest-item" data-pick="${esc(r.id)}" data-label="${esc(`${r.title}${r.year ? ` (${r.year})` : ""}`)}">
          ${r.poster ? `<img src="${esc(r.poster)}" alt="">` : `<span class="noimg"></span>`}
          <span><b>${esc(r.title)}</b> <span class="muted">${esc(r.year)} · ${esc(r.type)}</span>
          ${r.original && r.original !== r.title ? `<br><span class="muted small">${esc(r.original)}</span>` : ""}</span>
        </button>`).join("") || `<div class="muted small" style="padding:6px">Ничего не нашлось — сохрани как есть или вставь ссылку на TMDB / Кинопоиск / IMDb</div>`;
    }, 350);
  }
  document.addEventListener("input", (e) => { if (e.target.matches(".fix-form input, .unknown-form input")) onTitleInput(e.target); });
  document.addEventListener("click", (e) => {
    const pick = e.target.closest(".suggest-item");
    if (!pick) return;
    const form = pick.closest("form"), input = form.querySelector("input[name=title]");
    input.value = pick.dataset.label; input.dataset.exact = pick.dataset.pick;
    form.querySelector(".suggest-list").innerHTML = `<div class="picked small">✓ Выбрано точно: ${esc(pick.dataset.label)}. Нажми «${form.classList.contains("fix-form") ? "Исправить" : "Сохранить"}».</div>`;
  });

  // ---------- встроенный ИИ-подбор ----------
  let aiPicks = [], aiIntro = "", aiLastQuery = "";
  const normTitle = (x) => String(x || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  function findInList(p) {
    const names = [normTitle(p.title), normTitle(p.title_en)].filter(Boolean);
    const cands = items.filter((t) => [t.title_ru, t.title_en, t.title_orig].some((n) => names.includes(normTitle(n))));
    return cands.find((t) => !p.year || !t.year || Math.abs(t.year - p.year) <= 1) || cands[0] || null;
  }
  async function askAi() {
    const btn = $("#aiAsk");
    aiLastQuery = $("#aiQuery").value.trim();
    btn.disabled = true; btn.textContent = "Думаю…";
    $("#aiResult").innerHTML = `<div class="muted">ИИ читает ваш список и оценки, это 10–30 секунд…</div>`;
    try {
      const res = await S.askAi(buildPrompt(aiLastQuery, $("#aiOutside").checked, true));
      aiIntro = res.intro || "";
      aiPicks = (res.picks || []).map((p) => ({ ...p, item: findInList(p) }));
      renderAiResult();
    } catch (err) {
      $("#aiResult").innerHTML = `<div class="error">Не получилось: ${esc(err.message || err)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = "Спросить ИИ";
    }
  }
  function renderAiResult() {
    const have = new Set(items.map((t) => t.id));
    $("#aiResult").innerHTML = (aiIntro ? `<p class="ai-intro">${esc(aiIntro)}</p>` : "") +
      `<div class="ai-picks">${aiPicks.map((p, i) => {
        const t = p.item || (p.tmdb && have.has(p.tmdb.id) ? items.find((x) => x.id === p.tmdb.id) : null);
        const poster = t ? posterHtml(t) : p.tmdb ? posterHtml({ title: p.tmdb.title, poster: p.tmdb.poster }) : posterHtml({ title: p.title });
        const title = t ? (t.title_ru || t.title_en) : p.tmdb?.title || p.title;
        const year = t?.year || p.tmdb?.year || p.year || "";
        const action = t
          ? `<button class="btn" data-ai-open="${esc(t.id)}">Открыть</button>${S.get(t.id).watched ? `<span class="muted small">уже смотрели</span>` : `<span class="in-list">в списке</span>`}`
          : p.tmdb
            ? `<button class="btn primary" data-ai-add="${i}">В список</button><a class="small muted" href="https://www.themoviedb.org/${p.tmdb.id.replace("-", "/")}" target="_blank" rel="noopener">TMDB</a>`
            : `<span class="muted small">не нашли в базе фильмов</span>`;
        return `<div class="ai-pick">
          <div class="ai-poster">${poster}</div>
          <div class="ai-body">
            <div class="card-title">${esc(title)} <span class="muted">${esc(year)}</span></div>
            ${p.duration ? `<div class="card-sub">${esc(p.duration)}</div>` : ""}
            <div class="ai-why">${esc(p.why || "")}</div>
            <div class="ai-actions">${action}</div>
          </div>
        </div>`;
      }).join("")}</div>`;
  }

  // ---------- удаление ----------
  function removeItem(id) {
    const t = items.find((x) => x.id === id);
    if (!confirm(`Удалить «${t?.title_ru || t?.title_en || "тайтл"}» из списка?\n\nЕго можно будет вернуть через фильтр «Удалённые».`)) return;
    S.hideSuggestion(id);
    if ($("#detail").open && $("#detail").dataset.id === id) $("#detail").close();
    render();
    toast(`«${t?.title_ru || t?.title_en || "Тайтл"}» удалён`, () => { S.restore(id); render(); });
  }
  function restoreItem(id) {
    S.restore(id);
    if ($("#detail").open) openDetail(id);
    render(); toast("Вернули в список");
  }

  // ---------- оценка после просмотра ----------
  function markDropped(id) {
    const now = !S.get(id).dropped;
    S.setDropped(id, now);
    if (!now) S.setWatched(id, false);
    if ($("#rate").open) $("#rate").close();
    render(); if ($("#detail").open) openDetail(id);
    toast(now ? "Отмечено как брошенное — похожее больше не будем предлагать" : "Вернули в список");
  }
  function markWatched(id) {
    const now = !S.get(id).watched || S.get(id).dropped;
    S.setWatched(id, now);
    if (!now) { toast("Вернули в список"); return; }
    if (S.get(id).dropped) S.setDropped(id, false);
    if (S.get(id).rating) { toast(`Отмечено как просмотренное (оценка ${S.get(id).rating})`); return; }
    const t = items.find((x) => x.id === id);
    $("#rateTitle").textContent = `Как вам «${t?.title_ru || t?.title_en || ""}»?`;
    $("#rateStars").innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
      `<button class="${S.get(id).rating === n ? "on" : ""}" data-rate="${n}">${n}</button>`).join("");
    $("#rateNote").value = S.get(id).note || "";
    $("#rate").dataset.id = id;
    $("#rate").showModal();
  }

  // ---------- account ----------
  function openAccount(recovery = false) {
    $("#accEmail").textContent = S.user()?.email || "";
    $("#accHint").textContent = recovery ? "Придумай новый пароль." : "";
    $("#accError").textContent = "";
    $("#account-dlg").showModal();
    if (recovery) $("#accPassword").focus();
  }

  // ---------- login ----------
  function requireLogin() {
    if (S.canEdit()) return true;
    $("#login").showModal(); $("#loginEmail").focus();
    return false;
  }
  function renderAccount() {
    const b = $("#account");
    if (!S.remote) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = S.user() ? "Аккаунт" : "Войти";
    b.title = S.user() ? `Вы вошли как ${S.user().email}` : "Войти, чтобы отмечать просмотренное";
  }

  // ---------- refresh (запуск обновления на GitHub) ----------
  const GH = () => `https://api.github.com/repos/${C.githubRepo}/actions/workflows/update.yml`;
  async function ghFetch(path, token, opts = {}) {
    return fetch(GH() + path, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(opts.headers || {}) } });
  }
  async function refresh() {
    if (!S.remote || !C.githubRepo) return toast("Обновление заработает после публикации на GitHub");
    if (!requireLogin()) return;
    const token = await S.setting("github_token");
    if (!token) return toast("Не задан токен GitHub в настройках Supabase");
    const btn = $("#refresh");
    const started = Date.now();
    const r = await ghFetch("/dispatches", token, { method: "POST", body: JSON.stringify({ ref: "main" }) });
    if (!r.ok) return toast(`GitHub не принял запуск (${r.status})`);
    btn.disabled = true; btn.textContent = "Обновляется…";
    toast("Обновление запущено, это займёт 2–4 минуты");
    const poll = setInterval(async () => {
      const runs = await ghFetch("/runs?per_page=1", token).then((x) => x.json()).catch(() => null);
      const run = runs?.workflow_runs?.[0];
      if (!run || new Date(run.created_at).getTime() < started - 60000 || run.status !== "completed") return;
      clearInterval(poll);
      btn.disabled = false; btn.textContent = "Обновить";
      if (run.conclusion !== "success") return toast("Обновление завершилось с ошибкой — подробности на GitHub");
      catalog = await fetch(`data/catalog.json?t=${Date.now()}`, { cache: "no-store" }).then((x) => x.json());
      loadAdded(); renderFilters(); render(); showUpdated();
      toast("Каталог обновлён");
    }, 15000);
  }
  function showUpdated() {
    if (catalog.updated) $("#updated").textContent = "обновлено " + new Date(catalog.updated).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  }

  // ---------- unrecognised posts ----------
  function renderUnknown() {
    const list = (catalog.unknown || []).filter((u) => S.pendingTitle(u.src) !== "!skip");
    $("#grid").innerHTML = `<div class="unknown-list">${list.map((u) => {
      const pending = S.pendingTitle(u.src);
      if (pending === "!skip") return "";
      return `<div class="unknown" data-src="${esc(u.src)}">
        <div class="unknown-head"><a href="${esc(u.url)}" target="_blank" rel="noopener">${esc(u.from || u.src)}</a>
          <span class="muted small">${esc(u.date || "")} · ${esc(u.src)}</span></div>
        ${u.note ? `<div class="unknown-note">${esc(u.note)}</div>` : ""}
        ${pending
          ? `<div class="pending">✓ «${esc(pending.replace(/\s*\[tmdb=[^\]]+\]/, ""))}» — появится после следующего обновления</div>`
          : `<form class="unknown-form"><input name="title" autocomplete="off" placeholder="Начни писать название…"><button class="btn">Сохранить</button>
              <button type="button" class="btn ghost" data-act="skip" title="Пост не про кино — убрать навсегда">Не про кино</button></form>`}
      </div>`;
    }).join("")}</div>`;
    $("#empty").hidden = list.length > 0;
    $("#empty").textContent = "Все посты разобраны.";
    $("#count").textContent = list.length ? `${list.length} постов, где не удалось понять название. Открой пост и впиши, что там.` : "";
  }

  // ---------- events ----------
  function bind() {
    $("#tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat]"); if (!b) return;
      f.cat = b.dataset.cat; render();
    });
    $("#q").addEventListener("input", (e) => { f.q = e.target.value.trim().toLowerCase(); render(); });
    $("#sort").addEventListener("change", (e) => { f.sort = e.target.value; render(); });
    for (const id of ["showWatched", "onlySoon", "onlyCheck", "showRemoved"]) $("#" + id).addEventListener("change", (e) => { f[id] = e.target.checked; render(); });
    $("#minRating").addEventListener("input", (e) => {
      f.minRating = +e.target.value; $("#minRatingVal").textContent = f.minRating ? f.minRating : "любой"; render();
    });
    for (const id of ["yearFrom", "yearTo"]) $("#" + id).addEventListener("input", (e) => { f[id] = +e.target.value || null; render(); });
    $("#filters").addEventListener("click", (e) => {
      const c = e.target.closest(".chip"); if (!c) return;
      const set = f[c.dataset.kind]; set.has(c.dataset.v) ? set.delete(c.dataset.v) : set.add(c.dataset.v);
      renderFilters(); render();
    });
    $("#resetFilters").addEventListener("click", () => {
      Object.assign(f, { showWatched: false, onlySoon: false, onlyCheck: false, showRemoved: false, minRating: 0, yearFrom: null, yearTo: null });
      f.providers.clear(); f.genres.clear(); f.sources.clear();
      for (const id of ["showWatched", "onlySoon", "onlyCheck", "showRemoved"]) $("#" + id).checked = false;
      $("#minRating").value = 0; $("#minRatingVal").textContent = "любой"; $("#yearFrom").value = ""; $("#yearTo").value = "";
      renderFilters(); render();
    });

    $("#grid").addEventListener("click", (e) => {
      const sugg = e.target.closest("[data-sugg]");
      if (sugg) {
        const id = sugg.dataset.sugg, act = e.target.closest("[data-act]")?.dataset.act;
        const s = suggestions().find((x) => x.id === id);
        if (act && !requireLogin()) return;
        if (act === "hide") { S.hideSuggestion(id); render(); }
        if (act === "add" && s) { S.addSuggestion(s); loadAdded(); render(); toast(`«${s.title}» добавлен в список`); }
        if (act === "watched" && s) { S.addSuggestion(s); loadAdded(); markWatched(s.id); render(); }
        if (!act && s) window.open(`https://www.themoviedb.org/${id.replace("-", "/")}`, "_blank");
        return;
      }
      const card = e.target.closest(".card[data-id]"); if (!card) return;
      if (e.target.closest("[data-act=remove]")) { if (requireLogin()) removeItem(card.dataset.id); return; }
      if (e.target.closest("[data-act=restore]")) { if (requireLogin()) restoreItem(card.dataset.id); return; }
      if (e.target.closest("[data-act=seen]")) {
        if (!requireLogin()) return;
        markWatched(card.dataset.id); render();
        return;
      }
      openDetail(card.dataset.id);
    });

    $("#detail").addEventListener("click", (e) => {
      const id = $("#detail").dataset.id;
      if (e.target.closest("[data-close]") || e.target === $("#detail")) return $("#detail").close();
      if (e.target.closest("[data-act=seen]")) { if (!requireLogin()) return; markWatched(id); openDetail(id); render(); return; }
      if (e.target.closest("[data-act=remove]")) { if (requireLogin()) removeItem(id); return; }
      if (e.target.closest("[data-act=restore]")) { if (requireLogin()) restoreItem(id); return; }
      if (e.target.closest("[data-act=drop]")) { if (requireLogin()) markDropped(id); return; }
      const simAdd = e.target.closest("[data-sim-add]");
      if (simAdd) {
        if (!requireLogin()) return;
        const t = items.find((x) => x.id === id), s = (t.similar || []).find((x) => x.id === simAdd.dataset.simAdd);
        S.addSuggestion({ ...s, because: [t.title_ru || t.title_en] });
        loadAdded(); render(); openDetail(id);
        toast(`«${s.title}» добавлен в список — подробности подтянутся при обновлении`);
        return;
      }
      if (e.target.closest("[data-act=confirm]")) { if (!requireLogin()) return; S.setChecked(id); openDetail(id); render(); toast("Отметили как проверенное"); return; }
      const rate = e.target.closest("[data-rate]");
      if (rate) { if (!requireLogin()) return; const n = +rate.dataset.rate; S.setRating(id, S.get(id).rating === n ? null : n); openDetail(id); render(); return; }
      const sim = e.target.closest(".similar .card[data-id]");
      if (sim) openDetail(sim.dataset.id);
    });
    $("#detail").addEventListener("change", (e) => { if (e.target.id === "note" && S.canEdit()) S.setNote($("#detail").dataset.id, e.target.value.trim()); });
    $("#detail").addEventListener("focusin", (e) => { if (e.target.id === "note" && !S.canEdit()) { e.target.blur(); requireLogin(); } });

    $("#grid").addEventListener("click", async (e) => {
      const skip = e.target.closest("[data-act=skip]"); if (!skip) return;
      const box = skip.closest("[data-src]");
      if (!requireLogin()) return;
      await S.addTitle(box.dataset.src, "!skip");
      render(); toast("Пост убран и больше не появится");
    });
    $("#grid").addEventListener("submit", async (e) => {
      e.preventDefault();
      const box = e.target.closest("[data-src]"), title = typedTitle(e.target.title);
      if (!title || !requireLogin()) return;
      await S.addTitle(box.dataset.src, title);
      render(); toast("Сохранено — подтянется при следующем обновлении");
    });

    $("#account").addEventListener("click", async () => {
      if (S.user()) openAccount();
      else { $("#login").showModal(); $("#loginEmail").focus(); }
    });
    $("#login").addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === $("#login")) $("#login").close(); });
    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("#loginError").textContent = "";
      const err = await S.signIn($("#loginEmail").value.trim(), $("#loginPassword").value);
      if (err) { $("#loginError").textContent = err.includes("Invalid") ? "Неверная почта или пароль" : err; return; }
      $("#login").close(); $("#loginPassword").value = "";
      renderAccount(); toast("Вы вошли");
    });
    window.addEventListener("store-error", (e) => toast("Не сохранилось: " + e.detail));

    // исправление тайтла из карточки
    $("#detail").addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = $("#detail").dataset.id, title = typedTitle(e.target.title);
      if (!title || !requireLogin()) return;
      await S.addTitle("fix:" + id, title);
      openDetail(id); render(); toast("Исправление сохранено — применится при обновлении");
    });

    // окно оценки
    $("#rate").addEventListener("click", (e) => {
      const id = $("#rate").dataset.id;
      const b = e.target.closest("[data-rate]");
      if (b) {
        S.setRating(id, +b.dataset.rate);
        const note = $("#rateNote").value.trim(); if (note) S.setNote(id, note);
        $("#rate").close(); render(); if ($("#detail").open) openDetail(id);
        toast(`Оценка ${b.dataset.rate} сохранена`);
        return;
      }
      if (e.target.closest("[data-drop]")) { markDropped(id); return; }
      if (e.target.closest("[data-skip]") || e.target === $("#rate")) {
        const note = $("#rateNote").value.trim(); if (note) S.setNote(id, note);
        $("#rate").close(); render(); toast("Отмечено как просмотренное");
      }
    });

    // аккаунт: смена пароля, выход
    $("#account-dlg").addEventListener("click", async (e) => {
      if (e.target.closest("[data-close]") || e.target === $("#account-dlg")) return $("#account-dlg").close();
      if (e.target.closest("[data-logout]")) { await S.signOut(); $("#account-dlg").close(); renderAccount(); render(); toast("Вы вышли"); }
    });
    $("#accForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const pwd = $("#accPassword").value;
      if (pwd.length < 6) { $("#accError").textContent = "Минимум 6 символов"; return; }
      const err = await S.changePassword(pwd);
      if (err) { $("#accError").textContent = err; return; }
      $("#accPassword").value = ""; $("#account-dlg").close(); toast("Пароль изменён");
    });
    $("#forgot").addEventListener("click", async () => {
      const email = $("#loginEmail").value.trim();
      if (!email) { $("#loginError").textContent = "Сначала впиши почту"; return; }
      const err = await S.resetPassword(email);
      $("#loginError").textContent = err ? err : "";
      if (!err) toast("Письмо со ссылкой для сброса пароля отправлено");
    });
    window.addEventListener("password-recovery", () => openAccount(true));

    $("#aiOpen").addEventListener("click", () => { $("#ai").showModal(); $("#aiQuery").focus(); });
    $("#ai").addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === $("#ai")) $("#ai").close(); });
    $("#aiOpen").addEventListener("click", () => {
      const live = S.remote && S.user();
      $("#aiAsk").hidden = !live;
      $("#aiHint").textContent = live
        ? "«Спросить ИИ» — ответ появится ниже. «Скопировать» — если хочешь спросить Claude или ChatGPT сам."
        : S.remote ? "Войди, чтобы спрашивать ИИ прямо здесь. Или скопируй запрос и вставь в Claude / ChatGPT."
                   : "Вставь скопированный текст в чат Claude или ChatGPT.";
    });
    $("#aiAsk").addEventListener("click", askAi);
    $("#aiQuery").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !$("#aiAsk").hidden) askAi(); });
    $("#aiResult").addEventListener("click", (e) => {
      const add = e.target.closest("[data-ai-add]");
      if (add) {
        const pick = aiPicks[+add.dataset.aiAdd];
        S.addSuggestion({ ...pick.tmdb, because: ["ИИ-подбор: " + (aiLastQuery || "по настроению")] });
        loadAdded(); render(); renderAiResult();
        toast(`«${pick.tmdb.title}» добавлен в список`);
        return;
      }
      const open = e.target.closest("[data-ai-open]");
      if (open) { $("#ai").close(); openDetail(open.dataset.aiOpen); }
    });
    $("#aiCopy").addEventListener("click", async () => {
      const text = buildPrompt($("#aiQuery").value.trim(), $("#aiOutside").checked);
      try { await navigator.clipboard.writeText(text); toast("Запрос скопирован — вставь в Claude или ChatGPT"); }
      catch { $("#aiResult").textContent = text; toast("Не удалось скопировать — текст ниже"); }
    });
    $("#refresh").addEventListener("click", refresh);
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") { e.preventDefault(); $("#q").focus(); }
    });
  }

  // предложения, которые добавили в список вручную
  function loadAdded() {
    const have = new Set(catalog.items.map((t) => t.id));
    const extra = S.added().filter((s) => !have.has(s.id)).map((s) => ({
      id: s.id, media: s.id.split("-")[0], tmdb_id: +s.id.split("-")[1], title_ru: s.title, title_en: "", year: +s.year || null,
      poster: s.poster, type: s.id.startsWith("tv") ? "Сериал" : "Фильм", category: s.id.startsWith("tv") ? "series" : "films",
      matched: true, ratings: {}, genres: [], providers: {}, similar: [],
      sources: [{ from: "Может понравиться" + (s.because?.length ? ": похоже на " + s.because.join(", ") : ""), url: `https://www.themoviedb.org/${s.id.replace("-", "/")}` }],
      added: new Date().toISOString().slice(0, 10), notes: [],
    }));
    items = [...catalog.items, ...extra];
  }

  async function init() {
    try {
      catalog = await fetch("data/catalog.json", { cache: "no-cache" }).then((r) => r.json());
    } catch (e) {
      $("#empty").hidden = false;
      $("#empty").textContent = "Не удалось загрузить каталог. Открой сайт через локальный сервер (см. README).";
      return;
    }
    await S.init();
    loadAdded(); showUpdated();
    bind(); renderAccount(); renderFilters(); render();
    S.onChange(() => { loadAdded(); renderAccount(); render(); });
  }
  init();
})();
