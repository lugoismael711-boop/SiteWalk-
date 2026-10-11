/* ============================================================
   firebase-config.js — YOUR Firebase project config
   ------------------------------------------------------------
   Paste the web-app config from the Firebase console here to turn
   on accounts + cloud sync (phone and desktop share one login).
   Leave the values blank to keep SiteWalk fully local, with no
   accounts and nothing leaving the device.

   These keys are PUBLIC (safe to commit) — access is controlled by
   the Firestore/Storage security rules, not by hiding the keys.

   Setup steps are in SETUP-SYNC.md.
   ============================================================ */

export const FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  appId: '',
};

/* Which Firebase JS SDK version to load from Google's CDN. */
export const FIREBASE_SDK_VERSION = '10.12.0';

export function firebaseEnabled() {
  return !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.appId);
}
