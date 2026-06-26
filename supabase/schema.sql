-- ═══════════════════════════════════════════════════════════════════════
-- ESCALES — Schéma Supabase
-- Copie-colle ce fichier dans l'éditeur SQL de Supabase et exécute-le.
-- ═══════════════════════════════════════════════════════════════════════

-- Table des artistes
create table if not exists public.artists (
  id         uuid        default gen_random_uuid() primary key,
  user_id    uuid        references auth.users(id) on delete cascade not null,
  name       text        not null,
  genre      text,
  image_url  text,
  created_at timestamptz default now() not null
);

-- Table des musiques
create table if not exists public.songs (
  id          uuid        default gen_random_uuid() primary key,
  user_id     uuid        references auth.users(id) on delete cascade not null,
  artist_id   uuid        references public.artists(id) on delete set null,
  title       text        not null,
  youtube_url text        not null,
  youtube_id  text,
  created_at  timestamptz default now() not null
);

-- Row Level Security : chaque utilisateur ne voit que ses propres données
alter table public.artists enable row level security;
alter table public.songs   enable row level security;

create policy "Gestion artistes propres" on public.artists
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Gestion musiques propres" on public.songs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Index pour performances
create index if not exists idx_artists_user_id on public.artists(user_id);
create index if not exists idx_songs_user_id   on public.songs(user_id);
create index if not exists idx_songs_artist_id on public.songs(artist_id);
