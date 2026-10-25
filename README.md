# Что посмотреть

Каталог рекомендаций фильмов, сериалов и аниме из Telegram-канала и сохранёнок Instagram.

## Как устроено

| Папка / файл | Что это |
|---|---|
| `site/` | Сам сайт: обычный HTML и JS, без сборки |
| `site/data/catalog.json` | Готовый каталог, который показывает сайт |
| `data/manual_titles.txt` | Ручной разбор постов, по строке на название |
| `data/draft.json` | Список названий после объединения дубликатов |
| `scripts/extract_telegram.py` | Экспорт Telegram Desktop → `data/telegram_posts.json` |
| `scripts/extract_instagram.py` | Архив Instagram → `data/instagram_items.json` |
| `scripts/build_draft.py` | `manual_titles.txt` → `draft.json` и `draft.md` для проверки |
| `scripts/enrich.py` | `draft.json` → `catalog.json`: постеры, оценки, где смотреть |
| `KEYS.md` | Где взять ключи и куда их вписать |

## Посмотреть сайт локально

```
python -m http.server 8765 --directory site
```

Затем открыть http://localhost:8765. Если просто открыть `index.html` двойным кликом, каталог не загрузится: браузер не даёт странице читать файлы с диска.

## Обновить каталог после правок

```
python scripts/build_draft.py
python scripts/enrich.py
```
