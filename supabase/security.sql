-- Weshare: database hardening. Run once in the Supabase SQL editor.
-- The desktop app ships with the public anon key, so these rules are what stop
-- anyone who has that key from publishing a fake update.
--
-- IMPORTANT: also turn off public sign-ups (Authentication -> Providers -> Email ->
-- "Allow new users to sign up" = off). Otherwise anyone could create an account
-- and count as "authenticated" below.

-- 1. Checksum columns used by the updater (it refuses releases without one).
alter table app_releases add column if not exists sha256_windows text;
alter table app_releases add column if not exists sha256_macos   text;
alter table app_releases add column if not exists sha256_linux   text;

-- 2. Releases: everyone may read; only signed-in admins may write.
alter table app_releases enable row level security;
drop policy if exists "releases readable by all" on app_releases;
drop policy if exists "releases written by admins" on app_releases;
create policy "releases readable by all" on app_releases
  for select to anon, authenticated using (true);
create policy "releases written by admins" on app_releases
  for all to authenticated using (true) with check (true);

-- 3. Telemetry: apps may only add rows; only admins may read them.
alter table transfers_telemetry enable row level security;
drop policy if exists "telemetry insert by app" on transfers_telemetry;
drop policy if exists "telemetry read by admins" on transfers_telemetry;
create policy "telemetry insert by app" on transfers_telemetry
  for insert to anon, authenticated with check (true);
create policy "telemetry read by admins" on transfers_telemetry
  for select to authenticated using (true);

-- 4. Installer storage bucket: public downloads, admin-only uploads.
drop policy if exists "installer upload by admins" on storage.objects;
drop policy if exists "installer change by admins" on storage.objects;
drop policy if exists "installer delete by admins" on storage.objects;
create policy "installer upload by admins" on storage.objects
  for insert to authenticated with check (bucket_id = 'installer');
create policy "installer change by admins" on storage.objects
  for update to authenticated using (bucket_id = 'installer');
create policy "installer delete by admins" on storage.objects
  for delete to authenticated using (bucket_id = 'installer');
