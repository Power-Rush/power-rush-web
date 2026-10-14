create table if not exists ab_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  test       text not null,
  grp        text not null,
  visitor    text not null,
  session    text,
  event      text not null,
  path       text,
  flavor     text,
  qty        int,
  value      numeric(12,2),
  order_id   text,
  detail     text,
  source     text,
  medium     text,
  campaign   text,
  device     text,
  country    text,
  excluded   text
);
create index if not exists ab_events_test_grp_event on ab_events (test, grp, event);
create index if not exists ab_events_test_visitor on ab_events (test, visitor);

create table if not exists ab_orders (
  order_id       text primary key,
  order_name     text,
  created_at     timestamptz not null,
  updated_at     timestamptz not null default now(),
  test           text not null,
  grp            text not null,
  visitor        text,
  inferred       boolean not null default false,
  qa             boolean not null default false,
  units          int not null,
  subtotal       numeric(12,2) not null,
  discounts      numeric(12,2) not null,
  total          numeric(12,2) not null,
  discount_codes text[],
  status         text not null
);
create index if not exists ab_orders_test_grp on ab_orders (test, grp);
