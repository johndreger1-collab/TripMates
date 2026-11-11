# One-time setup (all free)

Most of this is already done for Level UP. Reuse what you can; the notes say where.

## 1. GitHub repository

1. Create a new **public** repository, e.g. `tripmates`. (GitHub Pages on the
   free plan needs a public repo. Nothing secret goes in it: the Sheet holds
   the data, and the OAuth client ID and API URL are public by design.)
2. Settings → Pages → Source: **GitHub Actions** (or the branch/folder Level UP uses).
3. In Claude Code, clone it and copy this doc pack into it.

## 2. Google Cloud OAuth client (for sign-in)

Level UP already has a Google Cloud project. You can add a second OAuth client
there or create a new project; either is free and needs no billing account.

1. Google Cloud console → APIs & Services → OAuth consent screen: External,
   app name "Tripmates", your email. Add both of your Google accounts as test
   users while the app is in testing mode.
2. Credentials → Create credentials → OAuth client ID → Web application.
3. Authorised JavaScript origins: `https://<your-github-username>.github.io`
   and `http://localhost:5173` (or the port Level UP's dev server uses).
4. Copy the client ID. It goes in `web/public/config.js` and in the Apps Script
   Script Property `OAUTH_CLIENT_ID`.

## 3. clasp (Apps Script from the terminal)

1. Visit `https://script.google.com/home/usersettings` and switch **Google Apps
   Script API** on.
2. `npm install -g @google/clasp` (or use `npx clasp`), then `clasp login`.
   The login file `~/.clasprc.json` stays on your computer; never commit it.
3. The scripts are **bound to the database spreadsheet**. Open the spreadsheet →
   Extensions → Apps Script → Project Settings (gear icon) → copy the
   **Script ID**. (The spreadsheet ID in the Sheet's URL is a different ID.)
   Keep the spreadsheet URL and ID out of the public repo. If the API ever needs
   them, store them in Script Properties.
4. In the repo: `cd apps-script && clasp clone <scriptId>` (Phase R0).

## 4. Apps Script deployment for the API (Phase R2)

Follow the result of spike S12:

- **Same project:** Deploy → New deployment → Web app → Execute as **Me**,
  Who has access **Anyone**. Copy the `/exec` URL into `web/public/config.js`.
  Leave the old "User accessing" deployment alone until cutover.
- **Standalone project:** `clasp create --type standalone --title "Tripmates API"`
  in a separate folder, push the same server files, set Script Property
  `SHEET_ID` to the spreadsheet's id, then deploy as above.

Script Properties (Project Settings → Script properties): `OAUTH_CLIENT_ID`,
and `SHEET_ID` if standalone.

Each later server change: `clasp push`, then Deploy → Manage deployments →
edit the API deployment → New version. The URL stays the same.

## 5. After cutover (Phase R9)

Share the spreadsheet with nobody but yourself. Members are managed only in the
app's Members tab.

## 6. Two-phone test kit

- iPhone (Safari) and Android (Chrome), both signed in to the Google accounts in
  the Members tab.
- Test once in the browser and once installed to the home screen.
- Location permission allowed for the Pages site.
