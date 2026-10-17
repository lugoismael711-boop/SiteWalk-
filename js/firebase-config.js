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
  apiKey: 'AIzaSyDh2y5xnbTBpiQ4o78cu0UaO1XI9n8X-Bo',
  // Match the Firebase Hosting domain so Google sign-in is same-origin (popup works).
  authDomain: 'sitewalk-462ee.web.app',
  projectId: 'sitewalk-462ee',
  storageBucket: 'sitewalk-462ee.firebasestorage.app',
  messagingSenderId: '343698105733',
  appId: '1:343698105733:web:715067df583896844150ec',
};

/* Which Firebase JS SDK version to load from Google's CDN. */
export const FIREBASE_SDK_VERSION = '10.12.0';

/* OAuth Web client ID for "Continue with Google" via Google Identity Services.
   Get it in Firebase → Authentication → Sign-in method → Google →
   "Web SDK configuration" → Web client ID. Leave blank to hide the button.
   The site's origin must also be added to that client's Authorized JavaScript
   origins in Google Cloud Console (see SETUP-SYNC.md). */
export const GOOGLE_CLIENT_ID = '';

export function firebaseEnabled() {
  return !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.appId);
}
