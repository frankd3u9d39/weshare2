# Weekly payments: setup

Weshare charges **₦1,000 for 7 days** through Paystack. New accounts get **3 free days**, then the
desktop app shows only the pay screen until they pay. One account works on any computer it signs in to.

Until step 5 is done, payments stay **off** and Weshare works without an account, exactly as before.

## How it fits together

```
Desktop app ──sign in──▶ Firebase Auth (email + password)
     │
     ├──▶ Vercel /api/access        3-day trial for new accounts, returns a signed access pass
     ├──▶ Vercel /api/pay/start     starts a ₦1,000 Paystack payment
     │        └── Paystack checkout window (card / bank / USSD typed on Paystack, never in Weshare)
     └──▶ Vercel /api/pay/verify    asks Paystack if it was paid, adds 7 days
Paystack ──▶ Vercel /api/paystack-webhook   adds the 7 days even if the app was closed mid-payment

Vercel keeps each account's dates in Firestore: users/{uid}, payments/{reference}, machines/{id}.
```

The access pass is signed on the server and checked by the app, so a café PC keeps working for the
whole paid week even when the internet is down, and editing files on the PC can't extend it.
While the week is over, phones and other computers can't connect to that PC; they're told to ask
the staff to renew. The owner's PC (the one with the `admin-device` file) never needs to pay.

## 1. Paystack

1. Paystack dashboard → **Settings → API Keys & Webhooks**.
2. Copy the **Test Secret Key** (`sk_test_…`). You'll paste it into Vercel in step 3.
   Don't put it anywhere else: not in the app, not in chat, not in the repo.

## 2. Firebase

1. **Authentication → Sign-in method**: make sure **Email/Password** is turned on.
2. **Project settings → Service accounts → Generate new private key**. A `.json` file downloads.
   Keep it private: it can read and write the whole database.

No Firestore rules change is needed. `users`, `payments` and `machines` are already closed to the
public by the "everything else closed" rule; only the Vercel server (with the service account) uses them.

## 3. Vercel

In your Vercel project → **Settings → Environment Variables**, add these:

| Name | Value |
| --- | --- |
| `PAYSTACK_SECRET_KEY` | the `sk_test_…` key from step 1 |
| `FIREBASE_SERVICE_ACCOUNT` | the **whole contents** of the `.json` file from step 2 |
| `LICENSE_PRIVATE_KEY` | the whole contents of `.secrets/license-private-key.pem` in this folder (including the BEGIN/END lines) |
| `SITE_URL` | your Vercel address, e.g. `https://weshare.vercel.app` |

Then deploy this repo (push to GitHub if Vercel is connected to it, or press **Redeploy**). The
`api/` folder becomes the payment server automatically.

`.secrets/` is git-ignored on purpose. Keep a backup of `license-private-key.pem` somewhere safe:
if it's lost, a new key pair has to be made and every app updated.

## 4. Paystack webhook

Paystack → **Settings → API Keys & Webhooks → Test Webhook URL**:

```
https://YOUR-SITE.vercel.app/api/paystack-webhook
```

## 5. Turn it on in the app

In `src/services/billingConfig.ts`, set your address:

```ts
export const BILLING_API_URL = process.env.WESHARE_BILLING_URL || 'https://YOUR-SITE.vercel.app';
```

Then build (`npm run build`) and restart Weshare.

## 6. Test with Paystack's test card

1. In Weshare: create an account. The header shows **Free trial · 3 days left**.
2. Click the badge → **Pay ₦1,000 now**. Paystack opens. Use Paystack's test card:
   `4084 0840 8408 4081`, any future expiry, CVV `408`, PIN `0000`, OTP `123456`.
3. The window closes and the badge shows the new end date (7 days after the trial ends).
4. In Firebase → Firestore you'll see `users/…` and `payments/…`.

## 7. Going live

1. Finish Paystack **Compliance** (profile, contact, owner, account, service agreement).
2. Swap `PAYSTACK_SECRET_KEY` in Vercel for the **Live** secret key (`sk_live_…`) and set the
   **Live Webhook URL** in Paystack to the same `/api/paystack-webhook` address.
3. Redeploy on Vercel. Nothing changes in the app.
