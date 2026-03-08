-- ═══════════════════════════════════════════════════════
--  QuestAcademy — Supabase Schema
--  Run this entire file in SQL Editor → New Query
-- ═══════════════════════════════════════════════════════

-- ── PLAYERS ──────────────────────────────────────────
create table if not exists players (
  id               uuid primary key default gen_random_uuid(),
  username         text unique not null,
  password_hash    text not null,        -- SHA-256 hex (client-side, no PII)
  gold             integer default 0,
  xp               integer default 0,
  level            integer default 1,
  hp               integer default 20,
  max_hp           integer default 20,
  equipped_cards   jsonb default '["Stab","Paper Toss","Eraser Block","Sticky Note"]'::jsonb,
  unlocked_masteries jsonb default '[]'::jsonb,
  items            jsonb default '[]'::jsonb,   -- ["dash","jetpack",...]
  worlds_done      jsonb default '[]'::jsonb,   -- [0,1,2,...]
  seen_intros      jsonb default '[]'::jsonb,
  current_world    integer default 0,
  party_id         uuid references parties(id) on delete set null,
  last_seen        timestamptz default now(),
  created_at       timestamptz default now()
);

-- ── PARTIES ──────────────────────────────────────────
create table if not exists parties (
  id          uuid primary key default gen_random_uuid(),
  leader      text not null,                           -- username
  members     jsonb default '[]'::jsonb,               -- [username, ...]  max 4
  status      text default 'idle',                     -- idle | in-battle | in-cutscene
  world_id    integer default 0,
  created_at  timestamptz default now()
);

-- Add FK after parties exists
alter table players add column if not exists party_id uuid references parties(id) on delete set null;

-- ── PRESENCE ─────────────────────────────────────────
create table if not exists presence (
  username    text primary key,
  world_id    integer default -1,         -- -1 = hub/spawn
  pos_x       float default 0,
  pos_z       float default 8,
  activity    text default 'idle',        -- idle | in-battle | in-cutscene | pvp
  party_id    uuid,
  hp          integer default 20,
  max_hp      integer default 20,
  avatar_col  text default '#00aaff',     -- player dot color
  updated_at  timestamptz default now()
);

-- ── BATTLES ──────────────────────────────────────────
create table if not exists battles (
  id              uuid primary key default gen_random_uuid(),
  type            text default 'pve',        -- pve | pvp
  world_id        integer default 0,
  participants    jsonb default '[]'::jsonb, -- [{username, hp, maxHp, turnDone}]
  enemies         jsonb default '[]'::jsonb, -- enemy config array (from zone)
  rewards         jsonb default '{}'::jsonb,
  turn_index      integer default 0,         -- which participant's turn (0-based)
  round           integer default 1,
  phase           text default 'player',     -- player | enemy | result
  battle_log      jsonb default '[]'::jsonb, -- [{actor, action, value, ts}]
  is_void         boolean default false,
  world_config    jsonb default '{}'::jsonb, -- bg/gnd/gline
  cutscene_ready  jsonb default '[]'::jsonb, -- usernames who finished cutscene
  cutscene_timer  timestamptz,               -- set when first person finishes cutscene
  started_at      timestamptz default now(),
  ended_at        timestamptz,
  winner          text                       -- username or 'enemies' or 'draw'
);

-- ── PARTY INVITES ────────────────────────────────────
create table if not exists party_invites (
  id          uuid primary key default gen_random_uuid(),
  from_user   text not null,
  to_user     text not null,
  party_id    uuid references parties(id) on delete cascade,
  status      text default 'pending',    -- pending | accepted | declined | expired
  created_at  timestamptz default now()
);

-- ── ROW LEVEL SECURITY ───────────────────────────────
alter table players enable row level security;
alter table parties enable row level security;
alter table presence enable row level security;
alter table battles enable row level security;
alter table party_invites enable row level security;

-- Players: open read, insert for register, anyone can update (we validate in app)
create policy "players_select" on players for select using (true);
create policy "players_insert" on players for insert with check (true);
create policy "players_update" on players for update using (true);

-- Parties: open
create policy "parties_all" on parties for all using (true) with check (true);

-- Presence: open
create policy "presence_all" on presence for all using (true) with check (true);

-- Battles: open
create policy "battles_all" on battles for all using (true) with check (true);

-- Invites: open
create policy "invites_all" on party_invites for all using (true) with check (true);

-- ── REALTIME ─────────────────────────────────────────
-- Enable realtime on presence and battles (the hot tables)
alter publication supabase_realtime add table presence;
alter publication supabase_realtime add table battles;
alter publication supabase_realtime add table party_invites;

-- ── CLEANUP FUNCTION ─────────────────────────────────
-- Auto-remove stale presence (players gone > 2 min)
create or replace function cleanup_stale_presence()
returns void language sql as $$
  delete from presence where updated_at < now() - interval '2 minutes';
$$;

-- ── INDEXES ──────────────────────────────────────────
create index if not exists idx_presence_world on presence(world_id);
create index if not exists idx_battles_participants on battles using gin(participants);
create index if not exists idx_party_invites_to on party_invites(to_user, status);
create index if not exists idx_players_username on players(username);

-- ── PATCH: add battle_id to presence (run if table already exists) ──
alter table presence add column if not exists battle_id uuid;
alter table battles add column if not exists is_boss boolean default false;
alter table battles add column if not exists cutscene_timer timestamptz;
alter table battles add column if not exists battle_log jsonb default '[]'::jsonb;
