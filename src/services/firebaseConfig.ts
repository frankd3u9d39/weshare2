/*
 * Firebase project used for anonymous transfer stats and the admin console.
 *
 * These values are public by design (Firebase "web app" config): they identify the project,
 * they don't grant access. What anyone can do is decided by firestore.rules: apps may only
 * add stats records, and only accounts listed in the `admins` collection may read them.
 *
 * Fill in apiKey from Firebase console -> Project settings -> Your apps -> Web app.
 * While apiKey is empty, stats stay queued on each computer and nothing is sent.
 */
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD7NA0TlavIftqqD62vTgcJeVs8VTWt54U',
  projectId: 'weshare-83260'
};

export const TELEMETRY_COLLECTION = 'transfers_telemetry';

export const isFirebaseConfigured = () => !!FIREBASE_CONFIG.apiKey && !!FIREBASE_CONFIG.projectId;

export const firestoreDocumentsUrl = () =>
  `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_CONFIG.projectId)}/databases/(default)/documents`;
