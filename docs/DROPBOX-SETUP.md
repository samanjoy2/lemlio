# Dropbox setup (one time, for whoever builds or ships Lemlio)

The same steps are shown inside Lemlio: **Settings → Backup → Advanced: use my own Dropbox app**. That guide opens the App Console, lists the exact permissions and redirect URIs (with Copy buttons), and checks the key you paste.

Lemlio signs in with OAuth **PKCE** and **no client secret**, so the Dropbox app key is a public identifier. Nothing secret is built into the app.

## Create the Dropbox app

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) and choose **Create app**.
2. Choose **Scoped access**, then **App folder** (least privilege: Lemlio sees only `Apps/<app name>`).
3. Name the app (the folder is created with this name in every user's Dropbox).
4. **Permissions** tab: enable `account_info.read` (shows your name in Lemlio), `files.metadata.read`, `files.metadata.write`, `files.content.read`, `files.content.write`, then **Submit**.
5. **Settings** tab: turn on **Allow public clients (Implicit Grant & PKCE)**.
6. **Settings → OAuth 2 → Redirect URIs**: add all four loopback addresses Lemlio tries, in this order:
   - `http://127.0.0.1:53682`
   - `http://127.0.0.1:53683`
   - `http://127.0.0.1:53684`
   - `http://127.0.0.1:53685`

   Dropbox does not document whether loopback redirects are accepted for every app. If sign-in through the browser does not return to Lemlio, users can press **Use a code instead**: that path sends no redirect and works without these URIs.
7. Copy the **App key** (not the app secret).

## Give the key to Lemlio

- **Release builds:** set the environment variable `LEMLIO_DROPBOX_APP_KEY` to the app key when compiling (`LEMLIO_DROPBOX_APP_KEY=abc123 pnpm tauri build`). It is read at compile time.
- **Any build:** Settings → Backup → Advanced → **Dropbox app key** accepts a key at run time and overrides the built-in one.

If no key is present, the Connect Dropbox button is disabled and says so.

## Limits to plan for

- A new app is in **development** status and can be linked by up to 500 users. When 50 users have linked it, Dropbox asks you to request **production** approval within two weeks (this needs an app icon and description).
- Files over 150 MB use Dropbox upload sessions; Lemlio does this automatically in 8 MB chunks.
- Each user's free Dropbox plan includes 2 GB; every backup adds a revision.
