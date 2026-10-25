"""Merge the manual title list with post metadata, drop duplicates, write draft files."""
import json, re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
data = root / "data"
CHANNEL_ID = 2117114565
TYPES = {"F": "Фильм", "S": "Сериал", "A": "Аниме", "C": "Мультфильм", "D": "Документальное", "?": "?"}

# minimal post metadata (date, author) — safe to publish, unlike the raw exports
sources = json.loads((data / "sources.json").read_text(encoding="utf-8"))
tg = sources["telegram"]
ig = sources["instagram"]

def source_info(src):
    kind, num = src.split(":")
    if kind == "tg":
        post = tg.get(num, {})
        return {"src": src, "date": post.get("date"), "url": f"https://t.me/c/{CHANNEL_ID}/{num}",
                "from": post.get("from") or "свой пост"}
    item = ig[int(num)]
    return {"src": src, "date": None, "url": item["url"], "from": "Instagram: " + item["collection"]}

titles, unknown, skipped = {}, [], []
for line in (data / "manual_titles.txt").read_text(encoding="utf-8").splitlines():
    if not line.strip() or line.startswith("#"):
        continue
    src, ru, orig, year, typ, conf, note = (line.split("|") + [""] * 7)[:7]
    info = source_info(src)
    if ru == "!skip":
        skipped.append({**info, "note": note}); continue
    if ru == "!unknown":
        unknown.append({**info, "note": note}); continue
    key = orig.lower().strip() or ru.lower().strip()
    key = re.sub(r"[^\w:]+", " ", key).strip()
    if key not in titles:
        titles[key] = {"title_ru": ru, "title_orig": orig, "year": int(year) if year.isdigit() else None,
                       "type": TYPES.get(typ, typ), "confidence": "high" if conf == "+" else "check",
                       "kp_id": orig[3:] if orig.startswith("kp:") else None,
                       "notes": [], "sources": []}
    t = titles[key]
    for n in filter(None, (x.strip() for x in note.split(";"))):
        if n not in t["notes"]:
            t["notes"].append(n)
    if conf != "+":
        t["confidence"] = "check"
    if info["url"] not in [s["url"] for s in t["sources"]]:
        t["sources"].append(info)

items = list(titles.values())
# a post that later got a title (typed on the site) is no longer "unknown"
known = {s["src"] for t in items for s in t["sources"]} | {s["src"] for s in skipped}
unknown = [u for u in unknown if u["src"] not in known]
(data / "draft.json").write_text(json.dumps({"titles": items, "unknown": unknown, "skipped": skipped},
                                            ensure_ascii=False, indent=1), encoding="utf-8")

def row(t):
    name = t["title_ru"] or "—"
    if t["title_orig"] and t["title_orig"] != t["title_ru"] and not t["kp_id"]:
        name += f" / {t['title_orig']}"
    if t["year"]:
        name += f" ({t['year']})"
    links = ", ".join(f"[{s['src']}]({s['url']})" for s in t["sources"])
    note = "; ".join(t["notes"])
    return f"| {name} | {links} | {note} |"

md = ["# Черновой список рекомендаций", "",
      f"Найдено **{len(items)}** уникальных названий, из них проверить: "
      f"**{sum(1 for t in items if t['confidence']=='check' and not t['kp_id'])}**, "
      f"ссылок на Кинопоиск без названия: **{sum(1 for t in items if t['kp_id'])}**. "
      f"Не распознано постов: **{len(unknown)}**, пропущено (не про кино): **{len(skipped)}**.", "",
      "Как поправить: напиши в чат номер источника и правильное название, например `tg:89 — Куб (1997)`.", ""]

check = [t for t in items if t["confidence"] == "check" and not t["kp_id"]]
md += ["## Проверить (название угадано)", "", "| Название | Источник | Заметка |", "|---|---|---|"]
md += [row(t) for t in check] + [""]

for typ in ["Фильм", "Сериал", "Аниме", "Мультфильм", "Документальное"]:
    group = sorted([t for t in items if t["type"] == typ and t not in check and not t["kp_id"]],
                   key=lambda t: t["title_ru"].lower())
    md += [f"## {typ} ({len(group)})", "", "| Название | Источник | Заметка |", "|---|---|---|"]
    md += [row(t) for t in group] + [""]

md += ["## Ссылки на Кинопоиск (названия подтянутся автоматически)", ""]
md += [f"- [kp {t['kp_id']}](https://www.kinopoisk.ru/film/{t['kp_id']}/) — {t['sources'][0]['src']}" for t in items if t["kp_id"]] + [""]

md += ["## Неразобранное", "", "Если помнишь, что там, напиши название.", ""]
md += [f"- [{u['src']}]({u['url']}) {u['note']}" for u in unknown] + [""]
(data / "draft.md").write_text("\n".join(md), encoding="utf-8")

print(len(items), "unique titles;", len(check), "to check;",
      sum(1 for t in items if t["kp_id"]), "kp links;", len(unknown), "unknown;", len(skipped), "skipped")
print("dupes merged:", sum(len(t["sources"]) - 1 for t in items))
