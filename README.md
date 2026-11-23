# TableServe

TableServe is a QR ordering and restaurant operations app built with Next.js, React, TypeScript and Firebase. The browser talks directly to Firebase Authentication and Cloud Firestore. Dish photos are cropped in the browser and uploaded directly to Cloudinary through an unsigned upload preset; this flow does not use Firebase Functions.

## What is included

- Email/password registration, email verification, sign-in and password reset.
- Restaurant onboarding, workspace selection and owner/manager/kitchen/waiter access.
- Public table QR menus, guest orders, ticket tracking, kitchen queue, waiter assignments and order history.
- Menu management with per-dish photo upload from a device or direct image link, square crop, and Cloudinary storage at `RestaurantName/RestaurantID/DishName/Image-*.jpg`.
- Served-order print bills with ticket QR, pay-at-restaurant or restaurant-configured direct UPI, guest served feedback, and bill sharing by WhatsApp or email.
- Restaurant settings, staff invitations and platform administration.
- A single free workspace plan. Payment checkout and paid subscriptions are disabled.

## Run locally

Requirements: Node.js 24.12 or later, npm, and the Firebase CLI for deployment or emulators.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and add the Firebase Web App values from **Firebase Console → Project settings → Your apps**.
3. Enable Email/Password in Firebase Authentication and create the Firestore database.
4. Run `npm run dev` and open `http://localhost:3000`.

To use local Firebase emulators, start `npm run emulators` in one terminal, then set `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true` in `.env.local` and restart the app. Auth, Firestore, Storage and Hosting emulators are configured in `firebase.json`. Cloudinary uploads still go directly to Cloudinary while the app uses Firebase emulators.

## Firebase data and access

- `lib/firebase.ts` initializes the Firebase client SDK and local emulator connections.
- `lib/firebase-actions.ts` contains direct client reads, writes and transactions for restaurant workflows.
- `firestore.rules` scopes restaurant data to the user's active membership and role. Guest QR reads use the small public projections in `publicRestaurants` and `restaurants/{shopId}/publicTables`.
- `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` and `NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET` configure direct dish photo uploads from the browser.
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

For Cloudinary, create an **unsigned** upload preset and set its name and cloud name in `.env.local` using the two `NEXT_PUBLIC_CLOUDINARY_*` variables from `.env.example`. Leave the preset's folder unset and allow public IDs so the app can place each photo under the restaurant and dish folder. Restrict the preset to JPG, PNG, and WebP images with a 5 MB maximum. Unsigned uploads cannot overwrite existing assets, so each replacement photo receives a unique `Image-*` public ID inside the same dish folder.

Image links must point directly to a public image file that Cloudinary can retrieve. The browser no longer downloads the linked image itself, so the source host's CORS policy does not block cropping. If Cloudinary cannot retrieve a link, use the device upload option.

## WhatsApp bill sharing

Guests provide a phone number with their order and can optionally enter an email for their bill. After serving, **WhatsApp Bill** opens a prefilled chat in WhatsApp Web on the PC using that order's phone number, itemized bill, total and ticket tracking link. Staff reviews the message and presses **Send**. **Email Bill** uses `mailto:` to open the system's default email app with a personalized itemized message and tracking link. Both are staff-reviewed drafts; no email or WhatsApp API credentials are needed.

Restaurant owners configure payment methods in **Restaurant Settings**. Pay at restaurant is enabled by default. Owners can also enable direct UPI by entering a VPA and payee name; guests see a bill-specific UPI QR and a button to open their UPI app. The payment goes directly to the restaurant. UPI has no automatic payment callback in this flow, so guests confirm they paid and restaurant staff verifies the credit in its UPI account before marking the order paid. No gateway or Firebase Functions are used.

## Order totals

The app checks current QR, table, restaurant, payment settings and menu records in a Firestore transaction before creating an order. Order creation and displayed totals are handled by the browser client; Firestore Security Rules cannot fully recalculate arbitrary item arrays or guarantee that a modified client submitted the menu price. Restaurant staff should confirm displayed items, totals and any direct UPI credit before preparing an order. A trusted payment backend would be required for automatic payment verification or server-authoritative pricing.
