alter table commerce_events
  add column quantity integer not null default 1 check (quantity >= 0 and quantity <= 100000);
