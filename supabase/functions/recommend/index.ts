// ИИ-подбор для сайта: принимает готовый запрос от сайта, спрашивает Gemini, возвращает JSON.
// Работает на серверах Supabase, поэтому доступен и там, где Gemini заблокирован.
// Отвечает только вошедшим пользователям сайта.

const GEMINI_KEY = Deno.env.get("GEMINI_KEY") ?? "";
let models: string[] = Deno.env.get("GEMINI_MODEL") ? [Deno.env.get("GEMINI_MODEL")!] : [];

// Google периодически выводит модели из оборота — берём свежие Flash из доступных ключу,
// lite-версии оставляем запасным вариантом на случай перегрузки
async function pickModels(): Promise<string[]> {
  if (models.length) return models;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GEMINI_KEY}`);
    const list: { name: string; supportedGenerationMethods?: string[] }[] = (await r.json()).models ?? [];
    const version = (n: string) => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? 0);
    const names = list
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace("models/", ""))
      .filter((n) => /flash/.test(n) && !/preview|exp|image|tts|live|audio|thinking/.test(n))
      .sort((a, b) => Number(/lite/.test(a)) - Number(/lite/.test(b)) || version(b) - version(a));
    models = names.slice(0, 4);
  } catch { /* ниже запасной вариант */ }
  if (!models.length) models = ["gemini-flash-latest", "gemini-flash-lite-latest"];
  return models;
}

async function gemini(prompt: string) {
  let last = "";
  for (const m of await pickModels()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
        }),
      });
      const data = await r.json();
      if (r.ok) return data;
      last = data?.error?.message ?? `Gemini ответил ${r.status}`;
      if (r.status === 503 || r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
      if (/model|not found|no longer available/i.test(last)) { models = []; break; }
      throw new Error(last);
    }
  }
  throw new Error(last.includes("demand") ? "Gemini сейчас перегружен, попробуй через минуту" : last);
}

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
    const norm = (t?: string) => (t ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
    const wanted = [p.title, p.title_en].map(norm).filter(Boolean);
    // точное совпадение названия и года важнее всего, популярность — чтобы не взять малоизвестный однофамилец
    const score = (x: Record<string, never>) => {
      const names = [x.title, x.name, x.original_title, x.original_name].map((n) => norm(n));
      const diff = p.year ? Math.abs(yearOf(x) - p.year) : 5;
      return (names.some((n) => wanted.includes(n)) ? 10 : 0) + (diff === 0 ? 6 : diff === 1 ? 3 : 0)
        + Math.min(Number(x.popularity) || 0, 100) / 25;
    };
    const best = [...results].sort((a, b) => score(b) - score(a))[0];
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
    const data = await gemini(prompt);
    const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    const result = JSON.parse(text);
    const picks: Pick[] = Array.isArray(result?.picks) ? result.picks : [];
    await Promise.all(picks.map(async (p) => { if (!p.in_list) p.tmdb = await findOnTmdb(p); }));
    return reply({ result });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
