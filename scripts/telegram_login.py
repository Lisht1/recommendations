"""One-time Telegram login by QR code (like linking Telegram Desktop).
Shows a QR image: scan it in the Telegram app on your phone.
Then saves a session string into .env so scripts can read the channel."""
import asyncio, os, getpass, tempfile
import qrcode
from telethon import TelegramClient, errors
from telethon.sessions import StringSession
from env import load_env, set_env_value

env = load_env()

async def main():
    client = TelegramClient(StringSession(), int(env["TELEGRAM_API_ID"]), env["TELEGRAM_API_HASH"])
    await client.connect()
    qr_path = os.path.join(tempfile.gettempdir(), "telegram_login_qr.png")
    while True:
        qr = await client.qr_login()
        qrcode.make(qr.url).save(qr_path)
        os.startfile(qr_path)
        print("\nОткрылась картинка с QR-кодом. На телефоне в Telegram:")
        print("  Настройки → Устройства → Подключить устройство → наведи камеру на QR\n")
        try:
            await qr.wait(timeout=60)
            break
        except asyncio.TimeoutError:
            print("QR устарел, показываю новый...")
        except errors.SessionPasswordNeededError:
            pwd = getpass.getpass("Включена двухфакторная защита. Введи облачный пароль (символы не видны): ")
            await client.sign_in(password=pwd)
            break
    me = await client.get_me()
    set_env_value("TELEGRAM_SESSION", client.session.save())
    print(f"\nГотово: вошли как {me.first_name}. Сессия сохранена в .env")
    try:
        os.remove(qr_path)
    except OSError:
        pass
    await client.disconnect()

asyncio.run(main())
