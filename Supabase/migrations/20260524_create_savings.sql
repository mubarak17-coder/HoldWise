-- savings_lockbox: one row per user — stores balance and goal
create table if not exists savings_lockbox (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  balance     numeric(12,2) not null default 0,
  goal        numeric(12,2) not null default 5000,
  updated_at  timestamptz not null default now()
);

alter table savings_lockbox enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'savings_lockbox' and policyname = 'Users can manage their own lockbox') then
    create policy "Users can manage their own lockbox"
      on savings_lockbox for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

drop trigger if exists savings_lockbox_updated_at on savings_lockbox;
create trigger savings_lockbox_updated_at
  before update on savings_lockbox
  for each row execute function update_updated_at();

-- savings_goals: multiple goals per user
create table if not exists savings_goals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  icon            text not null default '🎯',
  current_amount  numeric(12,2) not null default 0,
  target_amount   numeric(12,2) not null,
  color           text not null default '#6C5CE7',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_savings_goals_user_id on savings_goals(user_id);

alter table savings_goals enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'savings_goals' and policyname = 'Users can manage their own goals') then
    create policy "Users can manage their own goals"
      on savings_goals for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

drop trigger if exists savings_goals_updated_at on savings_goals;
create trigger savings_goals_updated_at
  before update on savings_goals
  for each row execute function update_updated_at();
