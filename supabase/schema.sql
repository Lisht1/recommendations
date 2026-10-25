-- База для сайта «Что посмотреть».
-- Вставь весь файл в Supabase → SQL Editor → New query и нажми Run.
-- Читать и менять данные могут только вошедшие пользователи (вы двое).

-- Отметки по тайтлам: общие на двоих
create table if not exists marks (
  item_id     text primary key,          -- id из каталога, например movie-603
  watched     boolean not null default false,
  watched_at  timestamptz,
  rating      smallint check (rating between 1 and 10),
  note        text,
  checked     boolean not null default false,   -- «Всё верно» для угаданных тайтлов
  dropped     boolean not null default false,   -- «Бросили, не досмотрели»
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- Предложения из «Может понравиться»: скрытые и добавленные в список
create table if not exists suggestions (
  id          text primary key,          -- id тайтла TMDB, например tv-1399
  status      text not null check (status in ('hidden', 'added')),
  data        jsonb,                      -- название, год, постер — для добавленных
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

-- Названия, вписанные на сайте для нераспознанных постов. Скрипт обновления их забирает.
create table if not exists manual_titles (
  id          bigint generated always as identity primary key,
  src         text not null,              -- tg:123 или ig:45
  title       text not null,
  processed   boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

-- Настройки сайта, например токен для кнопки «Обновить»
create table if not exists settings (
  key   text primary key,
  value text
);

alter table marks add column if not exists checked boolean not null default false;
alter table marks add column if not exists dropped boolean not null default false;  -- «Бросили, не досмотрели»

alter table marks         enable row level security;
alter table suggestions   enable row level security;
alter table manual_titles enable row level security;
alter table settings      enable row level security;

drop policy if exists "signed in" on marks;
drop policy if exists "signed in" on suggestions;
drop policy if exists "signed in" on manual_titles;
drop policy if exists "signed in read" on settings;

create policy "signed in" on marks         for all to authenticated using (true) with check (true);
create policy "signed in" on suggestions   for all to authenticated using (true) with check (true);
create policy "signed in" on manual_titles for all to authenticated using (true) with check (true);
create policy "signed in read" on settings for select to authenticated using (true);
