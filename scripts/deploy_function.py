"""Upload the AI/search function (supabase/functions/recommend) to Supabase and give it
the Gemini and TMDB keys. Uses the Supabase Management API, so no CLI or Docker is needed.
Needs SUPABASE_ACCESS_TOKEN in .env (supabase.com/dashboard/account/tokens). Prints no secrets."""
import json, re, ssl, sys, uuid, urllib.request, urllib.error
from env import load_env, ROOT

env = load_env()
try:
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()

token = env.get("SUPABASE_ACCESS_TOKEN", "").strip()
url = env.get("SUPABASE_URL", "")
if not token:
    sys.exit("В .env нет SUPABASE_ACCESS_TOKEN")
ref = re.match(r"https://([a-z0-9]+)\.supabase\.co", url).group(1)
API = f"https://api.supabase.com/v1/projects/{ref}"

def call(path, data=None, method="POST", content_type="application/json"):
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": content_type,
                                          "User-Agent": "RecommendationsDeploy/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60, context=SSL) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

# 1. function code
source = (ROOT / "supabase/functions/recommend/index.ts").read_bytes()
boundary = uuid.uuid4().hex
meta = json.dumps({"entrypoint_path": "index.ts", "name": "recommend", "verify_jwt": False}).encode()
body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n").encode() + meta + \
       (f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"index.ts\"\r\n"
        f"Content-Type: application/typescript\r\n\r\n").encode() + source + f"\r\n--{boundary}--\r\n".encode()
status, text = call("/functions/deploy?slug=recommend", body, content_type=f"multipart/form-data; boundary={boundary}")
print(("✓ функция recommend загружена" if status < 300 else f"✗ загрузка функции: {status} {text[:300]}"))
if status >= 300:
    sys.exit(1)

# 2. keys for the function
if not env.get("ADMIN_KEY", "").strip():  # служебный ключ для скрипта разбора видео
    import secrets as _s
    from env import set_env_value
    set_env_value("ADMIN_KEY", _s.token_urlsafe(32))
    env = load_env()
    env["ADMIN_KEY"] = (ROOT / ".env").read_text(encoding="utf-8").split("ADMIN_KEY=")[1].splitlines()[0]
secrets = [{"name": k, "value": env[k].strip()} for k in ("GEMINI_KEY", "TMDB_TOKEN", "ADMIN_KEY") if env.get(k, "").strip()]
status, text = call("/secrets", json.dumps(secrets).encode())
print(("✓ ключи переданы функции: " + ", ".join(s["name"] for s in secrets)) if status < 300 else f"✗ ключи: {status} {text[:300]}")
