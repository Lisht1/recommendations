# Публикация: что сделать тебе

Три шага, примерно 15 минут. После каждого напиши в чат, остальное я сделаю сам.

## Шаг 1. Вход в GitHub из терминала (2 минуты)

В терминале выполни:

```
& "$env:LOCALAPPDATA\Microsoft\WinGet\Links\gh.exe" auth login
```

Ответы на вопросы (стрелки и Enter):
- **Where do you use GitHub?** → GitHub.com
- **Preferred protocol** → HTTPS
- **Authenticate Git with your GitHub credentials?** → Yes
- **How would you like to authenticate?** → Login with a web browser

Скрипт покажет код из 8 символов и откроет браузер. Вставь код, нажми **Authorize**. В терминале появится «Logged in as Lisht1».

👉 Напиши «гитхаб готов». Я создам репозиторий, загружу код, добавлю ключи в секреты и включу публикацию сайта.

## Шаг 2. Supabase: вход и общие отметки (10 минут)

1. Открой https://supabase.com → **Start your project** → войти проще всего через **Continue with GitHub**.
2. **New project**:
   - Name: `recommendations`
   - Database Password: нажми **Generate a password** и сохрани его куда-нибудь (мне не нужен);
   - Region: **Central EU (Frankfurt)**;
   - **Create new project**, подожди минуту-две.
3. Слева **SQL Editor** → **New query** → вставь всё содержимое файла `supabase/schema.sql` → **Run**. Должно быть «Success. No rows returned».
4. Слева **Authentication** → **Users** → **Add user** → **Create new user**:
   - почта и пароль для тебя, галочка **Auto Confirm User**;
   - то же самое для девушки.
5. **Authentication** → **Sign In / Providers** (или **Settings**) → выключи **Allow new users to sign up**, чтобы никто чужой не зарегистрировался. Сохрани.
6. **Project Settings** (шестерёнка) → **API Keys** (или **Data API**). Скопируй в `.env`:
   - **Project URL** → `SUPABASE_URL=`, вида `https://xxxx.supabase.co`;
   - **anon / public** или **publishable** ключ → `SUPABASE_ANON_KEY=`;
   - **service_role** или **secret** ключ → `SUPABASE_SERVICE_KEY=`. Это главный ключ к базе: только в `.env`, никому не показывать.

   Если там есть вкладки **Legacy API keys** и **API keys**, бери ключи с любой из них, только оба с одной.

## Шаг 3. Токен для кнопки «Обновить» (3 минуты)

Делается **после** шага 1, когда репозиторий уже создан.

1. Открой https://github.com/settings/personal-access-tokens/new
2. Token name: `recommendations-refresh`; Expiration: **No expiration** (или год).
3. **Repository access** → **Only select repositories** → `Lisht1/recommendations`.
4. **Permissions** → **Repository permissions** → **Actions** → **Read and write**. Больше ничего не трогай.
5. **Generate token**, скопируй и впиши в `.env`: `GITHUB_DISPATCH_TOKEN=...`

Этот токен умеет только запускать обновление каталога в этом репозитории. Он хранится в Supabase, и прочитать его могут только вошедшие пользователи.

👉 Напиши «supabase готов». Я проверю базу, подключу сайт и запущу первое обновление.

---

## (По желанию) Gemini: умный разбор новых постов

Без него в каталог автоматически попадают только простые посты: голое название, ссылка на Кинопоиск, трейлер. Остальное уходит в «Неразобранное».
Как получить ключ, описано в `KEYS.md`, раздел 4 (нужен VPN один раз). Ключ впиши в `.env` как `GEMINI_KEY=`, а я добавлю его в секреты GitHub.
