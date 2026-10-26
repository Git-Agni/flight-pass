-- flight-pass leads table. Run once in the Supabase SQL editor, then set
-- SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
create table if not exists public.flight_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  email text not null,
  building text,
  host text not null,
  event text not null,
  pass_url text,
  user_agent text,
  unique (email, event)
);

-- Deny everything to anon and authenticated users. Only the service role key
-- (server side) reads or writes.
alter table public.flight_leads enable row level security;
