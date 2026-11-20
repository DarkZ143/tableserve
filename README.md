# TableServe

TableServe is a QR ordering and restaurant operations app built with Next.js, React, TypeScript and Firebase. The browser talks directly to Firebase Authentication, Cloud Firestore and Cloud Storage. Restaurant actions use Firestore transactions and security rules; this app does not deploy or call Cloud Functions.

## What is included

- Email/password registration, email verification, sign-in and password reset.
- Restaurant onboarding, workspace selection and owner/manager/kitchen/waiter access.
- Public table QR menus, guest orders, ticket tracking, kitchen queue, waiter assignments and order history.
- Menu, restaurant settings, staff invitations and platform administration.
- A single free workspace plan. Payment checkout and paid subscriptions are disabled.

## Run locally

Requirements: Node.js 24.12 or later, npm, and the Firebase CLI for deployment or emulators.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and add the Firebase Web App values from **Firebase Console → Project settings → Your apps**.
3. Enable Email/Password in Firebase Authentication and create the Firestore database and Storage bucket.
4. Run `npm run dev` and open `http://localhost:3000`.

To use local Firebase emulators, start `npm run emulators` in one terminal, then set `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true` in `.env.local` and restart the app. Auth, Firestore, Storage and Hosting emulators are configured in `firebase.json`.

## Firebase data and access

- `lib/firebase.ts` initializes the Firebase client SDK and local emulator connections.
- `lib/firebase-actions.ts` contains direct client reads, writes and transactions for restaurant workflows.
- `firestore.rules` scopes restaurant data to the user's active membership and role. Guest QR reads use the small public projections in `publicRestaurants` and `restaurants/{shopId}/publicTables`.
- `storage.rules` restricts menu image uploads to restaurant owners and managers.
- Staff assignment writes a Firestore invitation. The invited person claims it after verifying their email and signing in.
- Grant Master Admin access by adding `masterAdmins/{firebaseAuthUid}` in Firestore with `{ "email": "...", "active": true, "role": "MasterAdmin" }`. The document ID must be the Firebase Authentication UID. Only a project owner should create this record.

On the first owner visit, existing restaurant records are moved to the free Firebase plan and the public QR projections are synchronized. Existing menu, staff and order documents remain in place.

## Build and deploy

```sh
npm run typecheck
npm run lint
npm run build
firebase deploy --project YOUR_FIREBASE_PROJECT_ID --only hosting,firestore:rules,firestore:indexes,storage
```

`npm run build` exports the browser app to `dist`. `vercel.json` selects the static Other framework preset, builds to `dist`, and rewrites deep links to the SPA entry; `firebase.json` does the same for Firebase Hosting. Replace `YOUR_FIREBASE_PROJECT_ID` with the ID from `.env.local`; the repository does not assume a Firebase CLI project alias.

## Order totals

The app checks current QR, table, restaurant and menu records in a Firestore transaction before creating an order. Order creation and displayed totals are handled by the browser client; Firestore Security Rules cannot fully recalculate arbitrary item arrays or guarantee that a modified client submitted the menu price. Orders are placed for payment at the restaurant; staff should confirm the displayed items and total against the menu before preparing them. A trusted order backend would be required for secure online payment or server-authoritative pricing.
