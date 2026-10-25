"""Turn data/draft.json into site/data/catalog.json.

For every title: find it on TMDB (poster, overview, genres, where to watch, similar titles),
then add ratings from OMDb (IMDb, Rotten Tomatoes), Kinopoisk and Shikimori (anime).
Every API answer is cached in data/cache/, so re-runs are fast and cheap.
Without keys it still writes a catalog straight from the draft, just without posters.
"""
import json, re, sys, ssl, time, hashlib, datetime, urllib.request, urllib.parse, urllib.error
from pathlib import Path
from env import load_env, ROOT

env = load_env()
TMDB = env.get("TMDB_TOKEN", "")
OMDB = env.get("OMDB_KEY", "")
KP = env.get("KINOPOISK_KEY", "")
STATE = {"omdb_http": False}  # flips to True after the first certificate error

DATA = ROOT / "data"
CACHE = DATA / "cache"
OUT = ROOT / "site" / "data" / "catalog.json"
IMG = "https://image.tmdb.org/t/p/"
TODAY = datetime.date.today().isoformat()
try:  # fresh root certificates; the system ones can be outdated
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()

ASIA = {"KR", "JP", "CN", "TW", "HK", "TH", "IN", "ID", "PH", "VN", "MY", "SG"}
# provider ids on TMDB -> name shown on the site
PROVIDERS = {8: "Netflix", 1796: "Netflix", 350: "Apple TV+", 2: "Apple TV+", 9: "Prime Video", 119: "Prime Video",
             337: "Disney+", 1899: "Max", 384: "Max", 283: "Crunchyroll", 15: "Hulu"}


# ---------- http with cache ----------

def fetch(url, headers=None, cache_days=30):
    CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.md5(url.encode()).hexdigest()
    path = CACHE / f"{key}.json"
    if path.exists() and time.time() - path.stat().st_mtime < cache_days * 86400:
        return json.loads(path.read_text(encoding="utf-8"))
    req = urllib.request.Request(url, headers={"User-Agent": "RecommendationsBot/1.0", **(headers or {})})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20, context=SSL) as r:
                data = json.loads(r.read().decode("utf-8"))
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 + attempt * 3); continue
            if e.code in (401, 403):
                raise
            return None
        except urllib.error.URLError as e:
            if "CERTIFICATE" in str(e.reason):
                return None  # no point retrying a certificate problem
            time.sleep(1 + attempt)
        except Exception:
            time.sleep(1 + attempt)
    return None

def tmdb(path, **params):
    q = urllib.parse.urlencode(params)
    return fetch(f"https://api.themoviedb.org/3{path}?{q}", {"Authorization": f"Bearer {TMDB}", "accept": "application/json"})


# ---------- matching ----------

def norm(s):
    return re.sub(r"[^\w]+", " ", (s or "").lower()).strip()

def is_latin(s):
    return bool(re.search(r"[a-zA-Z]", s or "")) and not re.search(r"[а-яА-Я]", s or "")

def year_ok(result, item):
    date = result.get("release_date") or result.get("first_air_date") or ""
    return not item["year"] or not date[:4].isdigit() or abs(int(date[:4]) - item["year"]) <= 1


def score(result, item):
    names = {norm(result.get(k)) for k in ("title", "name", "original_title", "original_name")}
    want = {norm(item["title_orig"]), norm(item["title_ru"])} - {""}
    s = 0.0
    if names & want:
        s += 10
    elif any(len(w) >= 8 and w in n for w in want for n in names if n) and year_ok(result, item):
        s += 6  # the post gives a short form of the full title: "The Rings of Power" in "The Lord of the Rings: The Rings of Power"
    elif any(w and (w in n or n in w) for w in want for n in names if n):
        s += 4
    date = result.get("release_date") or result.get("first_air_date") or ""
    if item["year"] and date[:4].isdigit():
        diff = abs(int(date[:4]) - item["year"])
        s += 6 if diff == 0 else 3 if diff == 1 else -3 if diff > 3 else 0
    want_media = {"Фильм": "movie", "Сериал": "tv"}.get(item["type"])
    if want_media and result.get("media_type") == want_media:
        s += 3
    s += min(result.get("popularity", 0), 100) / 50
    return s

def find_tmdb(item):
    """Return (media, id) for the best TMDB match, or None."""
    queries = []
    if item["title_orig"] and not item["title_orig"].startswith("kp:"):
        queries.append((item["title_orig"], "en-US"))
    if item["title_ru"] and item["title_ru"] != item["title_orig"]:
        queries.append((item["title_ru"], "ru-RU"))
    best, best_score = None, 0
    for query, lang in queries:
        res = tmdb("/search/multi", query=query, language=lang, include_adult="false") or {}
        for r in res.get("results", [])[:8]:
            if r.get("media_type") not in ("movie", "tv"):
                continue
            s = score(r, item)
            if s > best_score:
                best, best_score = r, s
        if best_score >= 14:
            break
    return (best["media_type"], best["id"]) if best and best_score >= 7 else None

def kp_lookup(kp_id):
    if not KP:
        return None
    try:
        return fetch(f"https://api.kinopoisk.dev/v1.4/movie/{kp_id}", {"X-API-KEY": KP})
    except urllib.error.HTTPError:
        return None

def kp_by_tmdb(tmdb_id):
    if not KP:
        return None
    try:
        res = fetch(f"https://api.kinopoisk.dev/v1.4/movie?externalId.tmdb={tmdb_id}&limit=1", {"X-API-KEY": KP})
    except urllib.error.HTTPError:
        return None  # daily limit reached; will be filled on a later run
    docs = (res or {}).get("docs") or []
    return docs[0] if docs else None

def shikimori(item, year):
    for host in ("https://shikimori.io", "https://shikimori.one"):
        q = urllib.parse.quote(item["title_en"] or item["title_orig"])
        res = fetch(f"{host}/api/animes?search={q}&limit=5")
        if res is None:
            continue
        time.sleep(0.3)
        best = None
        for r in res:
            y = (r.get("aired_on") or "")[:4]
            if year and y.isdigit() and abs(int(y) - year) > 1:
                continue
            best = r
            break
        if best:
            return {"score": float(best["score"]) if best.get("score") not in (None, "0.0") else None,
                    "url": host + best["url"]}
        return None
    return None


# ---------- building one catalog entry ----------

def seasons_of(info):
    """Regular seasons (no specials): number, year, air date, episode count."""
    out = []
    for x in info.get("seasons") or []:
        if not x.get("season_number"):
            continue  # season 0 = specials
        out.append({"n": x["season_number"], "air_date": x.get("air_date"), "episodes": x.get("episode_count") or 0})
    return out

def next_season_of(info):
    """Premiere date of an announced next season, if TMDB knows it."""
    nxt = info.get("next_episode_to_air") or {}
    if nxt.get("episode_number") == 1 and nxt.get("air_date"):
        return {"n": nxt.get("season_number"), "air_date": nxt["air_date"]}
    future = [x for x in info.get("seasons") or [] if x.get("season_number") and x.get("air_date") and x["air_date"] > TODAY]
    if future:
        return {"n": future[0]["season_number"], "air_date": future[0]["air_date"]}
    return None


def recommended_seasons(notes):
    """'2 сезон', 'season 3', 'второй сезон' in the notes -> [2, 3]"""
    words = {"перв": 1, "втор": 2, "трет": 3, "четв": 4, "пят": 5, "шест": 6}
    found = set()
    for n in notes:
        for m in re.finditer(r"(\d+)\s*(?:-?й\s*)?сезон|season\s*(\d+)", n, flags=re.I):
            found.add(int(m.group(1) or m.group(2)))
        for m in re.finditer(r"(перв|втор|трет|четв|пят|шест)\w*\s+сезон", n, flags=re.I):
            found.add(words[m.group(1).lower()])
    return sorted(found)


def pick_trailer(videos):
    """YouTube key of the best trailer: Russian first, then official English, then any teaser."""
    yt = [v for v in videos if v.get("site") == "YouTube" and v.get("key")]
    def rank(v):
        return (v.get("type") != "Trailer", v.get("iso_639_1") != "ru", not v.get("official"),
                v.get("type") not in ("Trailer", "Teaser"), -(v.get("size") or 0))
    best = sorted(yt, key=rank)
    return best[0]["key"] if best else None


def category(entry):
    genres = entry["genre_ids"]
    asian = bool(set(entry["countries"]) & ASIA)
    if entry["type"] == "Аниме" or (16 in genres and asian):
        return "anime"
    if 16 in genres or entry["type"] == "Мультфильм":
        return "cartoons"
    if asian:
        return "asian"
    return "series" if entry["media"] == "tv" else "films"

def providers(block):
    out = {}
    for region, info in (block or {}).get("results", {}).items():
        for p in info.get("flatrate", []) + info.get("free", []):
            name = PROVIDERS.get(p["provider_id"])
            if name:
                out.setdefault(name, set()).add(region)
    return {k: sorted(v) for k, v in out.items()}

def from_draft(d):
    dates = [s["date"] for s in d["sources"] if s["date"]]
    return {
        "id": "draft-" + hashlib.md5((d["title_orig"] or d["title_ru"]).encode()).hexdigest()[:10],
        "tmdb_id": None, "media": "tv" if d["type"] == "Сериал" else "movie",
        "title_ru": d["title_ru"], "title_en": d["title_orig"] if is_latin(d["title_orig"]) else "",
        "title_orig": d["title_orig"], "year": d["year"], "release_date": None, "soon": False,
        "type": d["type"], "genres": [], "genre_ids": [], "countries": [], "overview": "", "overview_en": "",
        "poster": None, "backdrop": None, "runtime": None, "seasons": None,
        "ratings": {}, "imdb_id": None, "kp_id": d["kp_id"], "shiki_url": None,
        "providers": {}, "similar": [], "sources": d["sources"], "notes": d["notes"],
        "added": min(dates) if dates else None, "matched": False, "confidence": d["confidence"],
        "draft": [[d["title_ru"], d["title_orig"]]],
    }

def enrich(d):
    e = from_draft(d)
    if not TMDB:
        e["category"] = category(e)
        return e

    override = next((n.split("=", 1)[1] for n in d["notes"] if n.startswith("tmdb=")), None)
    e["notes"] = [n for n in e["notes"] if not n.startswith("tmdb=")]
    if override == "none":
        e["category"] = category(e)
        return e
    found = tuple(override.split("/")) if override else None
    if found:
        found = (found[0], int(found[1]))
    imdb = next((n.split("=", 1)[1] for n in d["notes"] if n.startswith("imdb=")), None)
    e["notes"] = [n for n in e["notes"] if not n.startswith("imdb=")]
    if imdb and not found:
        res = tmdb(f"/find/{imdb}", external_source="imdb_id") or {}
        hit = (res.get("movie_results") or []) + (res.get("tv_results") or [])
        if hit:
            found = ("tv" if res.get("tv_results") and not res.get("movie_results") else "movie", hit[0]["id"])
    if not found and d["kp_id"]:
        kp = kp_lookup(d["kp_id"])
        if kp:
            e["title_ru"] = kp.get("name") or e["title_ru"]
            e["title_orig"] = kp.get("enName") or kp.get("alternativeName") or e["title_orig"]
            e["year"] = kp.get("year") or e["year"]
            tid = (kp.get("externalId") or {}).get("tmdb")
            if tid:
                found = ("tv" if kp.get("isSeries") else "movie", tid)
    found = found or find_tmdb(e)
    if not found:
        e["category"] = category(e)
        return e

    media, tid = found
    info = tmdb(f"/{media}/{tid}", language="ru-RU",
                append_to_response="external_ids,watch/providers,recommendations,translations,videos",
                include_video_language="ru,en,null")
    if not info:
        e["category"] = category(e)
        return e

    trans = [t for t in info.get("translations", {}).get("translations", []) if t["iso_639_1"] == "en"]
    trans.sort(key=lambda t: t.get("iso_3166_1") != "US")  # American English first
    en = trans[0]["data"] if trans else {}
    date = info.get("release_date") or info.get("first_air_date") or ""
    e.update({
        "id": f"{media}-{tid}", "tmdb_id": tid, "media": media, "matched": True,
        "title_ru": info.get("title") or info.get("name") or e["title_ru"],
        "title_en": en.get("title") or en.get("name") or e["title_en"],
        "title_orig": info.get("original_title") or info.get("original_name") or e["title_orig"],
        "year": int(date[:4]) if date[:4].isdigit() else e["year"],
        "release_date": date or None,
        "soon": bool(date and date > TODAY) or info.get("status") in ("Planned", "In Production", "Post Production"),
        "genres": [g["name"] for g in info.get("genres", [])],
        "genre_ids": [g["id"] for g in info.get("genres", [])],
        "countries": info.get("origin_country") or [c["iso_3166_1"] for c in info.get("production_countries", [])],
        "overview": info.get("overview") or en.get("overview") or "",
        "overview_en": en.get("overview") or "",
        "poster": IMG + "w342" + info["poster_path"] if info.get("poster_path") else None,
        "backdrop": IMG + "w780" + info["backdrop_path"] if info.get("backdrop_path") else None,
        "runtime": info.get("runtime") or (info.get("episode_run_time") or [None])[0],
        "imdb_id": (info.get("external_ids") or {}).get("imdb_id") or info.get("imdb_id"),
        "providers": providers(info.get("watch/providers")),
        "trailer": pick_trailer((info.get("videos") or {}).get("results", [])),
        "seasons": seasons_of(info) if media == "tv" else None,
        "next_season": next_season_of(info) if media == "tv" else None,
        "similar": [{"id": f"{r.get('media_type', media)}-{r['id']}", "title": r.get("title") or r.get("name"),
                     "year": (r.get("release_date") or r.get("first_air_date") or "")[:4],
                     "poster": IMG + "w185" + r["poster_path"] if r.get("poster_path") else None}
                    for r in (info.get("recommendations") or {}).get("results", [])[:10]],
    })
    if info.get("vote_count", 0) > 20:
        e["ratings"]["tmdb"] = round(info["vote_average"], 1)

    if OMDB and e["imdb_id"]:
        om = None if STATE["omdb_http"] else fetch(f"https://www.omdbapi.com/?i={e['imdb_id']}&apikey={OMDB}")
        if om is None:  # on some PCs Python's certificates are outdated; OMDb also works over http
            STATE["omdb_http"] = True
            om = fetch(f"http://www.omdbapi.com/?i={e['imdb_id']}&apikey={OMDB}")
        om = om or {}
        if om.get("imdbRating", "N/A") != "N/A":
            e["ratings"]["imdb"] = float(om["imdbRating"])
        for r in om.get("Ratings", []):
            if r["Source"] == "Rotten Tomatoes":
                e["ratings"]["rt"] = int(r["Value"].rstrip("%"))
        if om.get("Metascore", "N/A") != "N/A":
            e["ratings"]["meta"] = int(om["Metascore"])

    kp = kp_lookup(e["kp_id"]) if e["kp_id"] else kp_by_tmdb(tid)
    if kp:
        e["kp_id"] = e["kp_id"] or kp.get("id")
        if (kp.get("rating") or {}).get("kp"):
            e["ratings"]["kp"] = round(kp["rating"]["kp"], 1)

    if media == "tv":
        e["rec_seasons"] = recommended_seasons(e["notes"])
    e["category"] = category(e)
    if e["type"] in ("?", ""):  # type unknown in the post — take it from TMDB
        e["type"] = {"anime": "Аниме", "cartoons": "Мультфильм"}.get(e["category"]) or ("Сериал" if media == "tv" else "Фильм")
    if e["category"] == "anime":
        sh = shikimori(e, e["year"])
        if sh:
            e["shiki_url"] = sh["url"]
            if sh["score"]:
                e["ratings"]["shiki"] = sh["score"]
    return e


def keep_previous(e, prev_by_id, prev_by_draft):
    """If a service was down or out of quota this time, keep what we found before."""
    if not e["matched"]:
        for d in e["draft"]:
            old = prev_by_draft.get(tuple(d))
            if old and old.get("matched"):
                return {**old, "sources": e["sources"], "notes": e["notes"], "draft": e["draft"],
                        "confidence": e["confidence"], "added": e["added"]}
        return e
    old = prev_by_id.get(e["id"])
    if old:
        for k, v in (old.get("ratings") or {}).items():
            e["ratings"].setdefault(k, v)
        for k in ("kp_id", "shiki_url", "imdb_id", "trailer"):
            e[k] = e.get(k) or old.get(k)
    return e


def main():
    draft = json.loads((DATA / "draft.json").read_text(encoding="utf-8"))
    prev_items = json.loads(OUT.read_text(encoding="utf-8")).get("items", []) if OUT.exists() else []
    prev_by_id = {p["id"]: p for p in prev_items}
    prev_by_draft = {tuple(d): p for p in prev_items for d in p.get("draft", [])}
    items, by_id = [], {}
    total = len(draft["titles"])
    for n, d in enumerate(draft["titles"], 1):
        try:
            e = enrich(d)
        except urllib.error.HTTPError as err:
            sys.exit(f"Ключ не подошёл ({err.code} на {err.url.split('?')[0]}). Проверь .env")
        e = keep_previous(e, prev_by_id, prev_by_draft)
        # two draft rows can resolve to the same TMDB title: merge their sources
        if e["id"] in by_id:
            old = by_id[e["id"]]
            old["sources"] += [s for s in e["sources"] if s["url"] not in {x["url"] for x in old["sources"]}]
            old["notes"] += [x for x in e["notes"] if x not in old["notes"]]
            old["draft"] += [x for x in e["draft"] if x not in old["draft"]]
        else:
            by_id[e["id"]] = e
            items.append(e)
        if TMDB and n % 20 == 0:
            print(f"  {n}/{total}")
    for e in items:
        e.pop("genre_ids", None)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    catalog = {"updated": datetime.datetime.now().isoformat(timespec="minutes"), "enriched": bool(TMDB),
               "items": items, "unknown": draft["unknown"]}
    OUT.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    matched = sum(1 for e in items if e["matched"])
    print(f"{len(items)} titles -> {OUT}  (found on TMDB: {matched}{'' if TMDB else ', no TMDB key yet'})")

if __name__ == "__main__":
    main()
