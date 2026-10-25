"""Desktop shortcut target: start the local web server if needed, then open the site."""
import socket, subprocess, sys, time, webbrowser
from pathlib import Path

PORT = 8765
SITE = Path(__file__).resolve().parent.parent / "site"

def running():
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", PORT)) == 0

if not running():
    flags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
    subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", str(SITE)],
                     creationflags=flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        if running():
            break
        time.sleep(0.1)
webbrowser.open(f"http://localhost:{PORT}")
