"""Pull the 'movies' and 'anime' collections out of the Instagram export."""
import json, zipfile, glob
from pathlib import Path

root = Path(__file__).resolve().parent.parent
zpath = glob.glob(str(root / "chat_export" / "Instagram" / "*.zip"))[0]
out = root / "data" / "instagram_items.json"
WANTED = {"Посмотреть фильмы": "movies", "Anime": "anime"}

def fix(s):
    # Instagram exports UTF-8 text double-encoded as Latin-1
    try:
        return s.encode("latin1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s

with zipfile.ZipFile(zpath) as z:
    cols = json.loads(z.read("your_instagram_activity/saved/saved_collections.json"))

items, seen = [], set()
for c in cols:
    lv = c["label_values"]
    name = fix(lv[0]["value"]).strip()
    if name not in WANTED:
        continue
    for block in lv:
        for entry in block.get("dict", []):
            f = {x.get("label"): x for x in entry.get("dict", [])}
            url = f.get("URL", {}).get("value")
            if not url or url in seen:
                continue
            seen.add(url)
            items.append({
                "url": url,
                "collection": WANTED[name],
                "caption": fix(f.get("Caption", {}).get("value", "")).strip(),
                "owner": fix(f.get("Username", {}).get("value", "") or f.get("Owner", {}).get("value", "")),
            })
out.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
print(len(items), "items ->", out)
