# One-time Google setup for Drive sync

Family Health stores your family's records in a hidden "app folder" inside your
own Google Drive. For the app to be allowed to do that, Google requires you to
create a free "OAuth client" once. It takes about five minutes and nothing is
billed. Do these steps signed in to the Google account whose Drive should hold
the data (everyone who should see the family's records will sign in with this
same account inside the app).

## 1. Create a project

1. Open https://console.cloud.google.com/ and accept the terms if asked.
2. Click the project drop-down at the top (it may say "Select a project"), then
   **New project**.
3. Name it `Family Health` and click **Create**. Wait for the notification, then
   select the new project.

## 2. Turn on the Google Drive API

1. In the left menu choose **APIs & Services → Library**.
2. Search for **Google Drive API**, open it, click **Enable**.

## 3. Set up the sign-in screen

1. Left menu → **Google Auth Platform** (older consoles call this
   **APIs & Services → OAuth consent screen**). Click **Get started** if offered.
2. **App information:** App name `Family Health`, user support email: your
   address. Next.
3. **Audience:** choose **External**. Next.
4. **Contact information:** your address. Next. Agree and **Create**.
5. Open **Data access** (or **Scopes**) → **Add or remove scopes**. In the
   filter box paste `drive.appdata`, tick
   `https://www.googleapis.com/auth/drive.appdata` ("See, create, and delete its
   own configuration data in your Google Drive"), click **Update**, then **Save**.
   This is the only permission the app asks for. It cannot see your other Drive
   files.
6. Open **Audience** again and click **Publish app**, confirm. (If you leave it
   in Testing mode, sign-ins expire every seven days and only listed test users
   can sign in.) Because this scope is not a sensitive one, no Google review is
   needed.

## 4. Create the client ID

1. Left menu → **Google Auth Platform → Clients** (or **APIs & Services →
   Credentials → Create credentials → OAuth client ID**).
2. Click **Create client**. Application type **Web application**. Name
   `Family Health web`.
3. Under **Authorized JavaScript origins** click **Add URI** and add these two,
   exactly, one per line:
   - `https://cjoaoyl.github.io`
   - `http://localhost:8080`
4. Leave "Authorized redirect URIs" empty. Click **Create**.
5. Copy the **Client ID**. It looks like
   `123456789012-abc...xyz.apps.googleusercontent.com`. The client secret is not
   needed; you can close that box.

## 5. Put the client ID into the app

Either paste it to Claude so it can be committed as the default, or do it
yourself: open https://cjoaoyl.github.io/family-health/#/settings, find
**Google Drive sync**, paste the Client ID into the field and press **Save**.
Then click **Connect Google Drive**, pick your account, and allow the single
permission. The status pill in the top bar changes to "Drive: synced".

## Using it on another device

Open the same link, go to Settings, click **Connect Google Drive**, sign in with
the same Google account. The records appear after the first sync. From then on
every save on any device syncs automatically.

## If something goes wrong

- "Error 400: redirect_uri_mismatch" or "origin_mismatch": the origin in step 4
  is wrong. It must be `https://cjoaoyl.github.io` with no path and no trailing
  slash.
- "Access blocked: this app has not been verified": the app is still in Testing
  mode and you are not listed as a test user. Publish it (step 3.6) or add your
  address under Audience → Test users.
- The sync pill says "offline": the device has no internet. Changes are kept
  locally and sync on the next connection.
- To see what is stored, Google Drive itself does not show the app folder. Use
  Settings → Export backup in the app instead.

## Removing access later

Google Account → Security → Third-party apps & services → Family Health →
Remove access. Or in the app, Settings → Disconnect. The data in the hidden
folder can be deleted from the app with "Disconnect and erase Drive data".
