// Настройки сайта. Ссылки на сервисы собраны здесь, чтобы их было легко поправить.
window.CONFIG = {
  // Заполним, когда подключим Supabase (вход и общие отметки «посмотрел»)
  supabaseUrl: "https://aitbjeuukxxkvxjcwzhd.supabase.co",
  supabaseKey: "sb_publishable_J-0rWRojs7Y17SoS4vCh9A_GMATjvop",   // публичный anon-ключ: его можно хранить в открытом виде

  // Репозиторий на GitHub — для кнопки «Обновить»
  githubRepo: "Lisht1/recommendations",

  // ?local=1 в адресе — тестовый режим: отметки только в этом браузере, общая база не трогается
  localMode: new URLSearchParams(location.search).has("local"),

  categories: [
    { id: "all", label: "Все" },
    { id: "films", label: "Фильмы" },
    { id: "series", label: "Сериалы" },
    { id: "anime", label: "Аниме" },
    { id: "cartoons", label: "Мультфильмы" },
    { id: "asian", label: "Корейская дичь" },
    { id: "suggest", label: "Может понравиться" },
    { id: "watched", label: "Просмотренное" },
    { id: "unknown", label: "Неразобранное" },
  ],

  // Ссылки на сервисы. t — карточка из каталога.
  links: {
    kinopub: (t) => `https://kino.watch/item/search?query=${encodeURIComponent(t.title_en || t.title_ru)}`,
    yummy: (t) => `https://yummy-anime.ru/search?word=${encodeURIComponent(t.title_ru || t.title_en)}`,
    // стриминги: кнопка показывается, только если по данным TMDB тайтл там есть (в какой-то стране)
    streaming: {
      "Netflix": (t) => `https://www.netflix.com/search?q=${encodeURIComponent(t.title_en || t.title_orig)}`,
      "Apple TV+": (t) => `https://tv.apple.com/search?term=${encodeURIComponent(t.title_en || t.title_orig)}`,
      "Prime Video": (t) => `https://www.primevideo.com/search/ref=atv_nb_sug?phrase=${encodeURIComponent(t.title_en || t.title_orig)}`,
      "Max": (t) => `https://play.max.com/search?q=${encodeURIComponent(t.title_en || t.title_orig)}`,
      "Disney+": (t) => `https://www.disneyplus.com/search?q=${encodeURIComponent(t.title_en || t.title_orig)}`,
      "Crunchyroll": (t) => `https://www.crunchyroll.com/search?q=${encodeURIComponent(t.title_en || t.title_orig)}`,
      "Hulu": (t) => `https://www.hulu.com/search?q=${encodeURIComponent(t.title_en || t.title_orig)}`,
    },
    kinopoisk: (t) => t.kp_id
      ? `https://www.kinopoisk.ru/film/${t.kp_id}/`
      : `https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(t.title_ru)}`,
    imdb: (t) => t.imdb_id ? `https://www.imdb.com/title/${t.imdb_id}/` : null,
    tmdb: (t) => t.tmdb_id ? `https://www.themoviedb.org/${t.media}/${t.tmdb_id}` : null,
    shikimori: (t) => t.shiki_url || null,
  },
};
