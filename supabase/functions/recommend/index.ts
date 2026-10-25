// ИИ-подбор для сайта: принимает готовый запрос от сайта, спрашивает Gemini, возвращает JSON.
// Работает на серверах Supabase, поэтому доступен и там, где Gemini заблокирован.
// Отвечает только вошедшим пользователям сайта.

const GEMINI_KEY = Deno.env.get("GEMINI_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const TMDB_TOKEN = Deno.env.get("TMDB_TOKEN") ?? "";
const IMG = "https://image.tmdb.org/t/p/w342";

type Pick = { title?: string; title_en?: string; year?: number; in_list?: boolean; tmdb?: unknown };

// Для тайтлов не из списка — найти их в TMDB, чтобы на сайте был постер и кнопка «В список»
async function findOnTmdb(p: Pick) {
  if (!TMDB_TOKEN) return null;
  for (const query of [p.title_en, p.title].filter(Boolean) as string[]) {
    const url = `https://api.themoviedb.org/3/search/multi?language=ru-RU&query=${encodeURIComponent(query)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } });
    if (!r.ok) continue;
    const results = ((await r.json()).results ?? []).filter((x: { media_type: string }) => x.media_type === "movie" || x.media_type === "tv");
    if (!results.length) continue;
    const yearOf = (x: { release_date?: string; first_air_date?: string }) => Number((x.release_date || x.first_air_date || "").slice(0, 4));
    const best = results.find((x: never) => p.year && Math.abs(yearOf(x) - p.year) <= 1) ?? results[0];
    return {
      id: `${best.media_type}-${best.id}`,
      title: best.title ?? best.name,
      year: yearOf(best) || null,
      poster: best.poster_path ? IMG + best.poster_path : null,
      overview: best.overview ?? "",
    };
  }
  return null;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function signedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SUPABASE_ANON_KEY },
  });
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Только POST" }, 405);
  if (!(await signedIn(req))) return reply({ error: "Нужно войти на сайт" }, 401);

  try {
    const body = await req.json();

    // Подсказки названий для полей «Исправить» и «Неразобранное»
    if (typeof body.search === "string") {
      if (!TMDB_TOKEN || body.search.trim().length < 2) return reply({ results: [] });
      const url = `https://api.themoviedb.org/3/search/multi?language=ru-RU&query=${encodeURIComponent(body.search.trim())}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } });
      const found = r.ok ? (await r.json()).results ?? [] : [];
      const results = found
        .filter((x: { media_type: string }) => x.media_type === "movie" || x.media_type === "tv")
        .slice(0, 6)
        .map((x: Record<string, string>) => ({
          id: `${x.media_type}-${x.id}`,
          title: x.title ?? x.name,
          original: x.original_title ?? x.original_name,
          year: (x.release_date || x.first_air_date || "").slice(0, 4),
          type: x.media_type === "tv" ? "сериал" : "фильм",
          poster: x.poster_path ? "https://image.tmdb.org/t/p/w92" + x.poster_path : null,
        }));
      return reply({ results });
    }

    if (!GEMINI_KEY) return reply({ error: "На сервере не задан GEMINI_KEY" }, 500);
    const { prompt } = body;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 300_000) {
      return reply({ error: "Пустой или слишком длинный запрос" }, 400);
    }
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
        }),
      },
    );
    const data = await r.json();
    if (!r.ok) return reply({ error: data?.error?.message ?? `Gemini ответил ${r.status}` }, 502);
    const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    const result = JSON.parse(text);
    const picks: Pick[] = Array.isArray(result?.picks) ? result.picks : [];
    await Promise.all(picks.map(async (p) => { if (!p.in_list) p.tmdb = await findOnTmdb(p); }));
    return reply({ result });
  } catch (e) {
    return reply({ error: String(e) }, 500);
  }
});
