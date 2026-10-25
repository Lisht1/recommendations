"""Turn the Telegram Desktop export into a compact list of posts."""
import json, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = root / "chat_export" / "Telegram" / "result.json"
out = root / "data" / "telegram_posts.json"

def text_of(msg):
    t = msg.get("text", "")
    if isinstance(t, list):
        t = "".join(p if isinstance(p, str) else p.get("text", "") for p in t)
    return t.strip()

def links_of(msg):
    res = []
    for e in msg.get("text_entities", []):
        if e.get("type") == "text_link":
            res.append(e.get("href"))
        elif e.get("type") == "link":
            res.append(e.get("text"))
    return res

data = json.loads(src.read_text(encoding="utf-8"))
posts = []
for m in data["messages"]:
    if m.get("type") != "message":
        continue
    posts.append({
        "id": m["id"],
        "date": m["date"][:10],
        "from": m.get("forwarded_from"),
        "text": text_of(m),
        "links": links_of(m),
        "photo": m.get("photo") if m.get("photo") and "not included" not in m.get("photo") else None,
        "thumb": m.get("thumbnail"),
        "media": m.get("media_type"),
        "file": m.get("file_name"),
    })
out.write_text(json.dumps(posts, ensure_ascii=False, indent=1), encoding="utf-8")
print(len(posts), "posts ->", out)
