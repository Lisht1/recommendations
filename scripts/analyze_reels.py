"""Watch unrecognised Instagram reels with Gemini (video + sound) and pull out the titles.

Runs on your computer: downloads each reel (Instagram works fine from home), puts it into a
temporary private Supabase bucket, and the cloud function shows it to Gemini (which is not
reachable from Belarus directly). The video is deleted right after.

Usage:
  python scripts/analyze_reels.py            # all unrecognised reels
  python scripts/analyze_reels.py ig:46 ig:7 # only these
Then: python scripts/build_draft.py && python scripts/enrich.py
"""
import json, re, ssl, sys, time, urllib.request, urllib.error
from pathlib import Path
from env import load_env, ROOT

env = load_env()
try:
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()

URL = env["SUPABASE_URL"].rstrip("/")
KEY = env["SUPABASE_SERVICE_KEY"].strip()
ADMIN = env.get("ADMIN_KEY", "").strip()
DATA = ROOT / "data"
MANUAL = DATA / "manual_titles.txt"
TMP = DATA / "cache" / "reels"
BUCKET = "reels"


def request(url, data=None, method=None, headers=None, timeout=60, raw=False):
    body = data if isinstance(data, (bytes, type(None))) else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method=method, headers={
        "apikey": KEY, "Authorization": f"Bearer {KEY}",
        **({} if raw else {"Content-Type": "application/json"}), **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL) as r:
            text = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, text


def download(url, name):
    import yt_dlp
    TMP.mkdir(parents=True, exist_ok=True)
    out = TMP / f"{name}.mp4"
    opts = {"format": "b[ext=mp4][filesize<15M]/b[ext=mp4]/b", "outtmpl": str(out), "quiet": True,
            "no_warnings": True, "noprogress": True, "overwrites": True}
    with yt_dlp.YoutubeDL(opts) as y:
        y.download([url])
    return out


def analyse_carousel(url, caption, author):
    """Photo carousel: send all pictures to the cloud function in one request."""
    import base64, yt_dlp
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "ignore_no_formats_error": True}) as y:
        info = y.extract_info(url, download=False)
    images = []
    for entry in (info.get("entries") or [info])[:10]:
        thumbs = entry.get("thumbnails") or []
        link = thumbs[-1]["url"] if thumbs else entry.get("thumbnail")
        if link:
            req = urllib.request.Request(link, headers={"User-Agent": "Mozilla/5.0"})
            images.append(base64.b64encode(urllib.request.urlopen(req, timeout=30, context=SSL).read()).decode())
    if not images:
        raise RuntimeError("в посте нет ни видео, ни картинок")
    st, res = request(f"{URL}/functions/v1/recommend", {"images": images, "caption": caption, "author": author},
                      "POST", {"x-admin-key": ADMIN}, timeout=300)
    if st >= 300:
        raise RuntimeError(res.get("error") if isinstance(res, dict) else res)
    return res["result"]


def analyse(src, url, caption, author):
    name = src.replace(":", "_")
    try:
        path = download(url, name)
    except Exception as e:
        if "No video formats" in str(e) and "/p/" in url:
            return analyse_carousel(url, caption, author)
        raise
    size = path.stat().st_size
    if size > 15_000_000:
        path.unlink()
        raise RuntimeError(f"видео {size // 1_000_000} МБ — слишком большое")
    st, res = request(f"{URL}/storage/v1/object/{BUCKET}/{name}.mp4", path.read_bytes(), "POST",
                      {"Content-Type": "video/mp4", "x-upsert": "true"}, raw=True, timeout=120)
    path.unlink()
    if st >= 300:
        raise RuntimeError(f"не загрузилось в хранилище: {st} {res}")
    try:
        st, signed = request(f"{URL}/storage/v1/object/sign/{BUCKET}/{name}.mp4", {"expiresIn": 600}, "POST")
        video_url = f"{URL}/storage/v1{signed['signedURL']}"
        st, res = request(f"{URL}/functions/v1/recommend", {"video_url": video_url, "caption": caption, "author": author},
                          "POST", {"x-admin-key": ADMIN}, timeout=300)
        if st >= 300:
            raise RuntimeError(res.get("error") if isinstance(res, dict) else res)
        return res["result"]
    finally:
        request(f"{URL}/storage/v1/object/{BUCKET}/{name}.mp4", method="DELETE")


def to_line(src, t, note):
    clean = lambda s: str(s or "").replace("|", "/").replace("\n", " ").strip()
    year = t.get("year") if isinstance(t.get("year"), int) else ""
    typ = t.get("type") if t.get("type") in ("F", "S", "A", "C", "D") else "?"
    conf = "+" if t.get("confidence") == "+" else "?"
    return f"{src}|{clean(t.get('title_ru'))}|{clean(t.get('title_orig'))}|{year}|{typ}|{conf}|{clean(note)}"


def main():
    if not ADMIN:
        sys.exit("Нет ADMIN_KEY в .env — сначала запусти scripts/deploy_function.py")
    request(f"{URL}/storage/v1/bucket", {"id": BUCKET, "name": BUCKET, "public": False}, "POST")  # 409 если уже есть

    sources = json.loads((DATA / "sources.json").read_text(encoding="utf-8"))["instagram"]
    captions_file = DATA / "instagram_items.json"
    captions = json.loads(captions_file.read_text(encoding="utf-8")) if captions_file.exists() else []
    catalog = json.loads((ROOT / "site/data/catalog.json").read_text(encoding="utf-8"))
    wanted = set(sys.argv[1:])
    todo = [u for u in catalog["unknown"] if u["src"].startswith("ig:") and (not wanted or u["src"] in wanted)]
    print(f"Роликов к разбору: {len(todo)}")

    found_total = 0
    for n, u in enumerate(todo, 1):
        i = int(u["src"].split(":")[1])
        caption = captions[i]["caption"][:2000] if i < len(captions) else ""
        author = sources[i].get("author", "")
        try:
            result = analyse(u["src"], u["url"], caption, author)
        except Exception as e:
            print(f"[{n}/{len(todo)}] {u['src']}: ✗ {e}")
            continue
        titles = [t for t in result.get("titles", []) if t.get("title_ru") or t.get("title_orig")]
        summary = re.sub(r"\s+", " ", result.get("summary", "")).strip()[:150]
        lines = MANUAL.read_text(encoding="utf-8").splitlines()
        new = ([to_line(u["src"], t, f"из видео: {summary}") for t in titles] if titles
               else [f"{u['src']}|!unknown|||||в ролике: {summary or 'названий не нашлось'}".replace("\n", " ")])
        out, replaced = [], False
        for line in lines:
            if line.startswith(u["src"] + "|!unknown|"):
                if not replaced:
                    out += new
                    replaced = True
                continue
            out.append(line)
        if not replaced:
            out += new
        MANUAL.write_text("\n".join(out) + "\n", encoding="utf-8")
        found_total += len(titles)
        names = ", ".join(t.get("title_ru") or t.get("title_orig") for t in titles) or "—"
        print(f"[{n}/{len(todo)}] {u['src']} ({summary[:60]}): {names}")
        time.sleep(8)  # бесплатный тариф Gemini: несколько запросов в минуту
    print(f"\nГотово: найдено названий — {found_total}. Дальше: python scripts/build_draft.py && python scripts/enrich.py")


if __name__ == "__main__":
    main()
