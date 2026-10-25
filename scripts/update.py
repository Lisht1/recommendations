"""Daily update: pull new posts from the Telegram channel, work out which titles they
mention, add titles typed on the site, then rebuild the catalog.

Runs on GitHub Actions (see .github/workflows/update.yml) and also works locally.
Steps:
  1. new channel posts  -> lines in data/manual_titles.txt
  2. titles typed on the site for unrecognised posts (Supabase) -> lines too
  3. build_draft.py + enrich.py -> site/data/catalog.json
"""
import asyncio, base64, json, re, ssl, datetime, urllib.request, urllib.parse
from env import load_env, ROOT

env = load_env()
DATA = ROOT / "data"
SOURCES = DATA / "sources.json"
MANUAL = DATA / "manual_titles.txt"
CHANNEL_ID = 2117114565
GEMINI_MODEL = env.get("GEMINI_MODEL") or "gemini-2.5-flash"

try:
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()


def http_json(url, data=None, headers=None, method=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "RecommendationsBot/1.0", **(headers or {})})
    with urllib.request.urlopen(req, timeout=60, context=SSL) as r:
        raw = r.read().decode("utf-8")
        return json.loads(raw) if raw else None


# ---------- 1. reading the channel ----------

async def fetch_posts(last_id):
    """Return new posts (albums merged) with text, links, author, image bytes and comments."""
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl.types import PeerChannel

    client = TelegramClient(StringSession(env["TELEGRAM_SESSION"]), int(env["TELEGRAM_API_ID"]), env["TELEGRAM_API_HASH"])
    await client.connect()
    if not await client.is_user_authorized():
        raise SystemExit("Telegram-сессия недействительна: запусти scripts/telegram_login.py заново")
    channel = await client.get_entity(PeerChannel(CHANNEL_ID))

    groups = {}
    async for m in client.iter_messages(channel, min_id=last_id, reverse=True):
        key = m.grouped_id or m.id
        g = groups.setdefault(key, {"id": m.id, "date": m.date.date().isoformat(), "text": "", "links": [],
                                    "from": None, "image": None, "comments": [], "msg": m})
        if m.message and not g["text"]:
            g["text"] = m.message
        for ent, txt in (m.get_entities_text() or []):
            url = getattr(ent, "url", None) or (txt if txt.startswith("http") else None)
            if url:
                g["links"].append(url)
        if g["image"] is None and (m.photo or m.video or m.document):
            try:
                g["image"] = await client.download_media(m, bytes, thumb=-1)
            except Exception:
                pass
        if m.fwd_from and not g["from"]:
            try:
                chat = await m.forward.get_chat()
                g["from"] = getattr(chat, "title", None)
            except Exception:
                g["from"] = m.fwd_from.from_name
            # names are often in the comments under the original post (e.g. ШишКИНО)
            post_id = m.fwd_from.channel_post
            if post_id and m.forward and m.forward.chat_id:
                try:
                    async for c in client.iter_messages(m.forward.chat_id, reply_to=post_id, limit=30):
                        if c.message:
                            g["comments"].append(c.message[:300])
                except Exception:
                    pass  # source channel has no comments or they are closed
    await client.disconnect()
    posts = list(groups.values())
    for p in posts:
        p.pop("msg")
    return posts


# ---------- 2. working out titles ----------

PROMPT = """Ты помогаешь вести каталог рекомендаций фильмов, сериалов и аниме.
Ниже пост из Telegram-канала (текст, ссылки, иногда картинка и комментарии под оригинальным постом).
Определи, какие тайтлы в нём рекомендуют или обсуждают. Новости о наградах тоже считаются: добавь упомянутый тайтл.
Если пост вообще не про кино — верни пустой список.

Ответь строго JSON:
{"titles": [{"title_ru": "...", "title_orig": "оригинальное или английское название", "year": 2024,
             "type": "F|S|A|C|D", "confidence": "+|?"}]}
type: F фильм, S сериал, A аниме, C мультфильм/мультсериал, D документальное.
confidence "?" — если угадываешь. year — null, если не уверен.

Пост от: <<AUTHOR>>
Текст:
<<TEXT>>

Ссылки: <<LINKS>>
Комментарии под оригинальным постом:
<<COMMENTS>>"""

def ask_gemini(post):
    prompt = (PROMPT.replace("<<AUTHOR>>", post["from"] or "автор канала")
              .replace("<<TEXT>>", post["text"] or "(без текста)")
              .replace("<<LINKS>>", ", ".join(post["links"]) or "нет")
              .replace("<<COMMENTS>>", "\n".join(post["comments"][:20]) or "нет"))
    parts = [{"text": prompt}]
    if post["image"]:
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(post["image"]).decode()}})
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={env['GEMINI_KEY']}"
    res = http_json(url, {"contents": [{"parts": parts}],
                          "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2}})
    text = res["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text).get("titles", [])

def youtube_title(url):
    try:
        res = http_json("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(url, safe=""))
        title = res["title"]
        return re.split(r"\s*[|—–-]\s*(official|официальн|trailer|трейлер|teaser|тизер)", title, flags=re.I)[0].strip()
    except Exception:
        return None

def guess_without_ai(post):
    """Simple rules for when there is no Gemini key."""
    out = []
    for link in post["links"]:
        m = re.search(r"kinopoisk\.ru/(?:film|series)/(\d+)", link)
        if m:
            out.append({"title_ru": "", "title_orig": f"kp:{m.group(1)}", "year": None, "type": "?", "confidence": "+"})
        elif "youtu" in link:
            t = youtube_title(link)
            if t:
                out.append({"title_ru": t, "title_orig": t, "year": None, "type": "?", "confidence": "?"})
    text = re.sub(r"https?://\S+", "", post["text"] or "").strip()
    lines = [l.strip(" •-—\t") for l in text.splitlines() if l.strip()]
    # a short post with just a name or a short list of names
    if lines and len(text) <= 120 and all(len(l) <= 50 and not l.startswith("#") for l in lines):
        out += [{"title_ru": l, "title_orig": l, "year": None, "type": "?", "confidence": "?"} for l in lines]
    return out

def candidates(post):
    """Names in «quotes» — shown as hints next to an unrecognised post."""
    names = re.findall(r"«([^»]{2,60})»", post["text"] or "")
    return list(dict.fromkeys(names))[:5]

def to_line(src, t, note=""):
    clean = lambda s: str(s or "").replace("|", "/").replace("\n", " ").strip()
    year = t.get("year") if isinstance(t.get("year"), int) else ""
    typ = t.get("type") if t.get("type") in ("F", "S", "A", "C", "D") else "?"
    conf = "+" if t.get("confidence") == "+" else "?"
    return f"{src}|{clean(t.get('title_ru'))}|{clean(t.get('title_orig'))}|{year}|{typ}|{conf}|{clean(note)}"


# ---------- 3. titles typed on the site ----------

def supabase(path, method="GET", data=None):
    url, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        return None
    headers = {"apikey": key, "Prefer": "return=minimal"}
    if not key.startswith("sb_"):  # legacy service_role JWT also goes in Authorization
        headers["Authorization"] = f"Bearer {key}"
    return http_json(f"{url}/rest/v1/{path}", data, method=method, headers=headers)

def parse_typed(text):
    """What a person typed on the site -> (title_ru, title_orig, year, extra note).
    Understands an exact pick '[tmdb=movie/603]' and pasted TMDB / Kinopoisk / IMDb links."""
    text = text.strip()
    m = re.search(r"\[tmdb=(movie|tv)/(\d+)\]", text) or re.search(r"themoviedb\.org/(movie|tv)/(\d+)", text)
    if m:
        name, year = split_title(re.sub(r"\[tmdb=[^\]]+\]|https?://\S+", "", text))
        name = name or f"tmdb {m.group(1)}/{m.group(2)}"  # real title comes from TMDB later
        return name, name, year, f"tmdb={m.group(1)}/{m.group(2)}"
    m = re.search(r"kinopoisk\.ru/(?:film|series)/(\d+)", text)
    if m:
        return "", f"kp:{m.group(1)}", "", ""
    m = re.search(r"imdb\.com/title/(tt\d+)", text) or re.fullmatch(r"(tt\d+)", text)
    if m:
        return m.group(1), m.group(1), "", f"imdb={m.group(1)}"
    name, year = split_title(text)
    return name, name, year, ""

def split_title(title):
    """'Куб 1997' -> ('Куб', 1997)"""
    title = title.strip()
    m = re.search(r"\b(19|20)\d{2}\b", title)
    if not m:
        return title, ""
    return re.sub(r"\(?\b(19|20)\d{2}\b\)?", "", title).strip(" ,.-"), int(m.group(0))

def apply_fix(item_id, title):
    """A card was matched wrongly: rewrite the manual lines that produced it."""
    catalog = json.loads((ROOT / "site" / "data" / "catalog.json").read_text(encoding="utf-8"))
    item = next((i for i in catalog["items"] if i["id"] == item_id), None)
    if not item:
        return 0
    srcs = {x["src"] for x in item["sources"] if x.get("src")}
    drafts = {tuple(d) for d in item.get("draft", [])}
    ru, orig, year, extra = parse_typed(title)
    note = "исправлено на сайте" + (f"; {extra}" if extra else "")
    lines, changed = MANUAL.read_text(encoding="utf-8").splitlines(), 0
    for i, line in enumerate(lines):
        parts = line.split("|")
        if len(parts) >= 7 and parts[0] in srcs and (parts[1], parts[2]) in drafts:
            lines[i] = f"{parts[0]}|{ru}|{orig}|{year}|{parts[4]}|+|{note}"
            changed += 1
    MANUAL.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return changed

def site_titles():
    rows = supabase("manual_titles?processed=eq.false&select=id,src,title") or []
    lines = []
    for r in rows:
        if r["src"].startswith("fix:"):
            n = apply_fix(r["src"][4:], r["title"])
            print(f"  исправление {r['src']} → «{r['title']}»: строк {n}")
            continue
        if r["title"].strip() == "!skip":
            lines.append(f"{r['src']}|!skip|||||убрано на сайте: не про кино")
            continue
        ru, orig, year, extra = parse_typed(r["title"])
        lines.append(f"{r['src']}|{ru}|{orig}|{year}|?|+|вписано на сайте" + (f"; {extra}" if extra else ""))
    if rows:
        ids = ",".join(str(r["id"]) for r in rows)
        supabase(f"manual_titles?id=in.({ids})", "PATCH", {"processed": True})
    return lines


SUGG_DATES = {}

def added_on_site():
    """Titles added with «В список» (from «Может понравиться» or AI picks) become full catalog cards."""
    rows = supabase("suggestions?status=eq.added&select=id,data,created_at") or []
    have = MANUAL.read_text(encoding="utf-8")
    lines = []
    for r in rows:
        src = f"sugg:{r['id']}"
        if src + "|" in have:
            continue
        d = r.get("data") or {}
        title = str(d.get("title") or "").replace("|", "/")
        media, tid = r["id"].split("-", 1)
        SUGG_DATES[r["id"]] = (r.get("created_at") or "")[:10]
        why = "; ".join(d.get("because") or []).replace("|", "/")
        lines.append(f"{src}|{title}|{title}|{d.get('year') or ''}|?|+|tmdb={media}/{tid}; добавлено на сайте{': ' + why if why else ''}")
    return lines


# ---------- main ----------

def main():
    sources = json.loads(SOURCES.read_text(encoding="utf-8"))
    new_lines = []

    if env.get("TELEGRAM_SESSION"):
        posts = asyncio.run(fetch_posts(sources["last_tg_id"]))
        print(f"Новых постов в канале: {len(posts)}")
        for p in posts:
            sources["telegram"][str(p["id"])] = {"date": p["date"], "from": p["from"]}
            try:
                titles = ask_gemini(p) if env.get("GEMINI_KEY") else guess_without_ai(p)
            except Exception as e:
                print(f"  пост {p['id']}: ИИ не ответил ({e}), пробую простые правила")
                titles = guess_without_ai(p)
            src = f"tg:{p['id']}"
            if titles:
                new_lines += [to_line(src, t) for t in titles]
                print(f"  {src}: " + ", ".join(t.get("title_ru") or t.get("title_orig") or "?" for t in titles))
            else:
                snippet = re.sub(r"\s+", " ", p["text"] or "")[:80] or "пост без текста"
                hints = candidates(p)
                if hints:
                    snippet += " — возможно: " + ", ".join(f"«{h}»" for h in hints)
                new_lines.append(f"{src}|!unknown|||||{snippet.replace('|', '/')}")
                print(f"  {src}: не распознан")
        if posts:
            sources["last_tg_id"] = max(p["id"] for p in posts)
    else:
        print("TELEGRAM_SESSION не задан — канал не читаю")

    typed = site_titles() + added_on_site()
    if typed:
        print(f"Названий, вписанных на сайте: {len(typed)}")
    new_lines += typed

    if new_lines:
        with MANUAL.open("a", encoding="utf-8") as f:
            f.write(f"\n# автообновление {datetime.date.today().isoformat()}\n" + "\n".join(new_lines) + "\n")
    sources.setdefault("sugg", {}).update({k: {"date": v} for k, v in SUGG_DATES.items()})
    SOURCES.write_text(json.dumps(sources, ensure_ascii=False, indent=0), encoding="utf-8")

    import build_draft  # noqa: F401  (runs on import)
    import enrich
    enrich.main()

if __name__ == "__main__":
    main()
