# Skywalkers Backend

Express + TypeScript API that powers the consultation forms on the DigitizeBiz and CitizenEase
pages, plus the `/admin` dashboard in the frontend.

## Setup

```bash
cd backend
npm install
cp .env.example .env
# Temporary: the hash-password script was removed for this trial run (to be re-added later).
# Generate the hash inline instead — run from inside backend/, after npm install:
node --input-type=commonjs -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" "choose-a-strong-password"
# Paste the printed hash into .env as ADMIN_PASSWORD_HASH
# also set JWT_SECRET in .env to any long random string, e.g.:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run dev
```

The API starts on `http://localhost:4000` by default. The frontend's `VITE_API_URL` should point
here in development (see the frontend `.env.example`).

## Notifications

Every new consultation triggers up to four notifications, each independent and best-effort — if
one channel isn't configured or fails, the others still send and the consultation is still saved
either way:

| Channel | Recipient | Purpose |
|---|---|---|
| Email | Admin (`ADMIN_NOTIFY_EMAIL`) | "New consultation from X" alert |
| Email | Client (if `contact` looks like an email) | "We've received your request" confirmation |
| WhatsApp | Admin (`ADMIN_WHATSAPP_NUMBER`) | Same alert, via WhatsApp |
| WhatsApp | Client (if `contact` looks like a Kenyan phone number) | Same confirmation, via WhatsApp |

This logic lives in `src/lib/notify.ts`, called once from the `POST /api/consultations` route
after the record is saved. Any channel left unconfigured (missing env vars) is skipped with a
console warning rather than failing the request — so you can turn these on one at a time.

### Email setup (Gmail SMTP)

Gmail requires an **App Password** for SMTP access — your normal Gmail password won't work, and
this requires 2-Step Verification to be turned on for the account first.

1. Turn on 2-Step Verification if it isn't already: [myaccount.google.com/security](https://myaccount.google.com/security).
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Create a new App Password (name it something like "Skywalkers backend"). Google shows you a
   16-character password once — copy it immediately.
4. Set in `.env`:
   ```
   GMAIL_USER=mutwiriphillips@gmail.com
   GMAIL_APP_PASSWORD=<the 16-character app password, no spaces>
   ```
5. Restart the backend. Submit a test consultation from the site and confirm both the admin alert
   and (if you used an email as the contact) the client confirmation arrive.

Gmail SMTP has sending limits intended for personal/small-scale use (roughly 500 emails/day). If
consultation volume ever outgrows that, swap in a transactional provider (Resend, SendGrid,
Postmark) — only `src/lib/notify.ts` would need to change, nothing else.

### WhatsApp setup (Meta WhatsApp Cloud API)

This is the more involved one, and worth understanding before you start: **both of these messages
are business-initiated** (the admin alert and the client confirmation are both sent before the
recipient has messaged your business number), and WhatsApp requires business-initiated messages to
use a **pre-approved message template** — free-form text only works within 24 hours of the
recipient messaging you first. There's no way around this; it's a WhatsApp platform rule, not a
limitation of this code.

**1. Create the Meta app and test number**

1. Go to [developers.facebook.com](https://developers.facebook.com) → create a Meta Business
   account if you don't have one → **My Apps → Create App → Business** type.
2. Add the **WhatsApp** product to the app. Meta gives you a free test phone number and a
   temporary access token immediately — enough to test with before applying for a permanent token
   or your own business phone number.
3. From the WhatsApp → API Setup page, note down:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **Temporary access token** → `WHATSAPP_ACCESS_TOKEN` (this expires in 24h during testing;
     under **System Users** in Business Settings you can generate a permanent token once you're
     ready for production)

**2. Create the two message templates**

WhatsApp Manager (inside Meta Business Suite) → **Account tools → Message templates → Create
template**. Create both of these as **Utility** category templates:

- `skywalkers_admin_alert` — body text:
  > New consultation from {{1}} via {{2}}. Contact: {{3}}.
- `skywalkers_client_confirmation` — body text:
  > Hi {{1}}, thanks for reaching out to {{2}} at Skywalkers Ltd. We've received your request and will get back to you shortly.

Submit both for review. Utility-category templates are usually approved within a few minutes to a
few hours; you'll be notified in Meta Business Suite either way.

**3. Configure and test**

```
WHATSAPP_ACCESS_TOKEN=<from step 1>
WHATSAPP_PHONE_NUMBER_ID=<from step 1>
ADMIN_WHATSAPP_NUMBER=254791994833
```

During testing with the free test number, Meta restricts you to sending to a short list of
verified "test recipient" numbers (add yours under WhatsApp → API Setup → "To" field). This
restriction lifts once you move to a real business phone number and complete Meta's business
verification — required for production use regardless of this codebase.

**Client-side phone number matching:** `sendClientWhatsApp` only sends when `contact` parses as a
Kenyan number (`07XX...`/`01XX...` or already in `2547XX.../2541XX...` format) — matching this
business's market. If a client submits an email instead of a phone number, they get the email
confirmation instead, not a WhatsApp message; that's intentional, not a bug.

## Storage

Consultations are stored via `src/lib/store.ts`, which picks one of two backends automatically —
nothing to configure by hand:

- **File store** (`src/lib/fileStore.ts`) — a dependency-free JSON file at
  `backend/data/consultations.json`. Used whenever `UPSTASH_REDIS_REST_URL` /
  `UPSTASH_REDIS_REST_TOKEN` aren't set. This is the path for Render, local dev, a VPS, or any
  host with a writable persistent filesystem.
- **Upstash Redis store** (`src/lib/kvStore.ts`) — used automatically when those env vars *are*
  set, which Vercel does for you once you connect an Upstash Redis integration (see "Deploying to
  Vercel" in the root README). This path exists because Vercel functions are stateless — there's
  no local disk to persist a JSON file to.

Both implement the same `ConsultationStore` interface (see `src/types.ts`), so the routes never
know or care which one is active.

## App structure

- `src/app.ts` — builds and returns the configured Express app (middleware + routes), but never
  calls `.listen()`.
- `src/server.ts` — the standalone entry point: imports `createApp()` and calls `.listen()`. Used
  by `npm run dev` / `npm start`, i.e. Render, local dev, or any plain Node host.
- The repo root's `api/[...path].ts` is the *other* entry point — it imports the same
  `createApp()` and hands it directly to Vercel as a serverless function, instead of calling
  `.listen()`. This is what lets the exact same routes/middleware run on either a long-lived Node
  process or a stateless serverless function.

## API

| Method | Path                        | Auth  | Purpose                                  |
|--------|-----------------------------|-------|-------------------------------------------|
| GET    | `/api/health`               | —     | Liveness check                            |
| POST   | `/api/auth/login`           | —     | `{ password }` → `{ token }`              |
| POST   | `/api/consultations`        | —     | Create a consultation (used by contact forms) |
| GET    | `/api/consultations`        | Admin | List, optional `?division=` `&status=`   |
| PATCH  | `/api/consultations/:id`    | Admin | `{ status }` — update status              |
| DELETE | `/api/consultations/:id`    | Admin | Remove a consultation                     |

Admin routes require `Authorization: Bearer <token>` from `/api/auth/login`.

### Consultation shape

```json
{
  "id": "uuid",
  "name": "string",
  "contact": "phone or email",
  "division": "digitizebiz | citizenease",
  "message": "string",
  "status": "new | contacted | in_progress | closed",
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

## Security notes

- **Single admin account.** Password is never stored in plaintext — only a bcrypt hash in
  `ADMIN_PASSWORD_HASH`. There's no user database or self-registration by design (this is a
  one-person or small-team admin panel).
- **JWT** issued on login, 12h expiry, verified on every admin request. If `JWT_SECRET` or
  `ADMIN_PASSWORD_HASH` are unset, admin routes fail closed (500), not open.
- **Rate limiting**: the public submission endpoint allows 1 request per 30s per IP; login allows
  10 attempts per 15 minutes per IP.
- **Honeypot field** (`website`) on the public submission endpoint silently drops obvious bot
  submissions.
- **CORS** is locked to `FRONTEND_ORIGIN` — update it per environment (see deployment below).
- **Helmet** sets standard security headers.
- Input is validated with `zod` on every write endpoint; nothing from the request body reaches the
  store unvalidated.

## Build & run in production

```bash
npm run build
npm start
```

## Deployment

This runs two ways, and the code is identical either way:

- **As a standalone Node process** (Render, Railway, Fly.io, a VPS) via `src/server.ts`. For a
  ready-made setup, see **"Deploying to Render"** in the repo root README — `render.yaml`
  deploys this on Render's free tier by default (no disk, so `consultations.json` resets on
  redeploy/restart — see that section for how to add a disk once you're ready to upgrade).
- **As a Vercel serverless function** via the repo root's `api/[...path].ts`, in the same Vercel
  project as the frontend. See **"Deploying to Vercel"** in the repo root README — this path uses
  the Upstash-backed store instead of the file store, since Vercel functions can't write to a
  persistent local disk.

For any other plain-Node host, the general steps are the same:

1. Set `FRONTEND_ORIGIN`, `ADMIN_PASSWORD_HASH`, `JWT_SECRET` as environment variables on the host
   (never commit `.env`). `PORT` is usually injected by the platform — the app already reads
   `process.env.PORT` with a local fallback of 4000.
2. `npm install && npm run build && npm start`.
3. Point the frontend's `VITE_API_URL` at this service's public URL, and rebuild the frontend.
4. Give `backend/data` persistent storage (a mounted volume/disk) so
   `consultations.json` survives deploys and restarts — otherwise it resets every time the
   container is rebuilt. (Not applicable if you're on the Upstash-backed path instead.)
