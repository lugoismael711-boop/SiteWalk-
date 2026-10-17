# Turn on cloud sync (same login on phone + desktop)

SiteWalk works fully offline with no account. To link your phone and desktop
under **one login** so they share the same tours, connect it to a free
**Firebase** project. These are public keys — access is protected by the
security rules below, not by hiding the keys.

Takes about 10 minutes, once.

## 1. Create a Firebase project
1. Go to <https://console.firebase.google.com> and **Add project** (any name,
   e.g. "sitewalk"). You can turn Google Analytics off.

## 2. Add a Web app
1. In the project, click the **</>** (Web) icon to "Add app".
2. Give it a nickname, **Register app**.
3. Firebase shows a `firebaseConfig` object. Copy the values.

## 3. Paste the config into SiteWalk
Edit **`js/firebase-config.js`** and fill in the five fields from step 2:

```js
export const FIREBASE_CONFIG = {
  apiKey: 'AIza…',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.appspot.com',
  appId: '1:…:web:…',
};
```

Commit & push (or just save locally). A **Sign in** button appears in the top
bar once these are set.

## 4. Enable sign-in
Firebase console → **Build → Authentication → Get started**:
- Enable **Email/Password**.
- (Optional) Enable **Google** for one-tap "Continue with Google".
- On the **Settings → Authorized domains** tab, make sure your app's domain is
  listed (add `lugoismael711-boop.github.io` and `localhost`). The Electron
  desktop app loads that same domain, so no extra entry is needed.

## 5. Create the databases
- **Build → Firestore Database → Create database** → Production mode → pick a region.
- **Build → Storage → Get started** → Production mode → same region.

## 6. Lock the data to each account (security rules)
Paste these so every user can only read/write **their own** data.

**Firestore** (Firestore → Rules):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

**Storage** (Storage → Rules):
```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```
Click **Publish** on each.

## 6b. (Recommended) Host on Firebase so "Sign in with Google" works

The app is also set up to deploy to **Firebase Hosting** at
`https://sitewalk-462ee.web.app`. Serving from that domain makes Google
sign-in work with a normal button (no cross-domain popup error). One-time:

1. Firebase console → ⚙ **Project settings → Service accounts** →
   **Generate new private key** → it downloads a `.json` file.
2. GitHub → your repo → **Settings → Secrets and variables → Actions →
   New repository secret**:
   - **Name:** `FIREBASE_SERVICE_ACCOUNT`
   - **Secret:** paste the **entire contents** of that `.json` file.
3. (If the first deploy complains Hosting isn't set up) Firebase console →
   **Build → Hosting → Get started** once to provision the default site.

Every push to `main` then deploys to `https://sitewalk-462ee.web.app`. Use
that URL on phone + desktop going forward (add it to your home screen).

## 7. Use it
- Open SiteWalk on your **desktop**, click **Sign in**, create an account.
- Open SiteWalk on your **phone**, **Sign in** with the same email/password.
- Tours and photos now sync both ways automatically (every ~20 s and whenever
  the app regains focus; "Sync now" is in the account menu).

## Good to know
- **Photos are large.** Firebase's free "Spark" plan includes ~5 GB of Storage
  and ~1 GB/day download — plenty to start. A big, long‑running account may
  eventually need the pay‑as‑you‑go plan (a few dollars/month at most for one
  user). You can watch usage in the Firebase console.
- **Privacy:** with sync on, your tours and photos are stored in *your* Firebase
  project (your Google account), not on any SiteWalk server. Signed out, nothing
  leaves the device.
- **Conflicts:** sync is last‑write‑wins per tour by last‑edited time. Editing
  the *same* tour on two devices while both are offline, then reconnecting,
  keeps the most recently saved version.
- **Deletes (v1 limitation):** deleting a tour on one device does **not** yet
  delete it on the other — it can re‑sync back. Delete on both, or use the
  account's "Sync now" after removing it everywhere. (Tombstone‑based delete
  sync is a planned improvement.)
