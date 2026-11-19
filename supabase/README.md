# Byte Bistro account setup

Create separate Supabase projects for staging and production. Run the SQL in
`migrations/202611100001_player_saves.sql` in each project. In Auth, enable
email/password sign-in and email confirmation, configure custom SMTP, and set the
site URL and allowed redirects to the exact HTTPS Pages URLs for each environment.
Allow http://localhost:5173/ only on the staging project when needed.

Copy .env.example to .env.local and supply VITE_SUPABASE_URL and
VITE_SUPABASE_ANON_KEY (the publishable or legacy anon key). Vite embeds these
public values during the build. Keep secret keys and SMTP credentials out of
Vite and configure SMTP in the Supabase dashboard.

Verify signup confirmation, recovery and logout with staging accounts. With two
accounts, verify one account cannot read or update the other account's row.
Verify guest import, saves from two browser profiles, offline reconnection and
retention of locally created maps. The loading screen and guest play remain
available when authentication is disabled.
