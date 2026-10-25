"""After creating the Supabase project: check the tables exist, store the GitHub token
for the "Обновить" button, and put the public Supabase address and key into site/config.js.
Reads everything from .env, prints no secrets."""
import json, re, ssl, sys, urllib.request, urllib.error
from env import load_env, ROOT

env = load_env()
try:
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()

url = env.get("SUPABASE_URL", "").rstrip("/")
service = env.get("SUPABASE_SERVICE_KEY", "")
anon = env.get("SUPABASE_ANON_KEY", "")
repo = env.get("GITHUB_REPO", "")
token = env.get("GITHUB_DISPATCH_TOKEN", "")

missing = [k for k, v in {"SUPABASE_URL": url, "SUPABASE_SERVICE_KEY": service, "SUPABASE_ANON_KEY": anon}.items() if not v]
if missing:
    sys.exit("В .env не заполнены: " + ", ".join(missing))

def call(path, method="GET", data=None, extra=None):
    headers = {"apikey": service, "Content-Type": "application/json", **(extra or {})}
    if not service.startswith("sb_"):
        headers["Authorization"] = f"Bearer {service}"
    req = urllib.request.Request(f"{url}/rest/v1/{path}", method=method, headers=headers,
                                 data=json.dumps(data).encode() if data is not None else None)
    with urllib.request.urlopen(req, timeout=30, context=SSL) as r:
        return r.status

ok = True
for table in ("marks", "suggestions", "manual_titles", "settings"):
    try:
        call(f"{table}?select=*&limit=1")
        print(f"✓ таблица {table}")
    except urllib.error.HTTPError as e:
        ok = False
        print(f"✗ таблица {table}: {e.code} — выполни supabase/schema.sql в SQL Editor")
if not ok:
    sys.exit(1)

if token:
    call("settings", "POST", {"key": "github_token", "value": token},
         {"Prefer": "resolution=merge-duplicates,return=minimal"})
    print("✓ токен для кнопки «Обновить» сохранён в Supabase")
else:
    print("· GITHUB_DISPATCH_TOKEN не задан — кнопка «Обновить» пока не заработает")

cfg = ROOT / "site" / "config.js"
s = cfg.read_text(encoding="utf-8")
s = re.sub(r'supabaseUrl: "[^"]*"', f'supabaseUrl: "{url}"', s)
s = re.sub(r'supabaseKey: "[^"]*"', f'supabaseKey: "{anon}"', s)
if repo:
    s = re.sub(r'githubRepo: "[^"]*"', f'githubRepo: "{repo}"', s)
cfg.write_text(s, encoding="utf-8")
print("✓ адрес и публичный ключ Supabase записаны в site/config.js")
