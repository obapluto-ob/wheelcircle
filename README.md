# THE WHEEL

A savings circle for young Kenyans. Everyone puts the same amount in, each
seat carries a posted price, and the seat gets the pot the moment the circle
is whole. We are the record keeper, not a lender. No interest, no loans, no
"we'll pay you back later".

The app is a plain ES-module SPA. No framework, no bundler. The backend is one
`routes.mjs` file served at `/functions/v1/app`. Local dev runs on sqlite at
`dev/wheel.db`.

## Run it

Use PowerShell or Git Bash. Not WSL — sqlite's WAL mode fails on `/mnt/c`
with a disk I/O error.

```
cd C:\Users\dell\Documents\Qoder\2026-11-16\ce6f368a
npm run dev        # everything simulated: checkout, STK, webhook. Safe to click.
npm run dev:live   # same app, but payments go out to the Paysasa sandbox
```

Open http://localhost:8099. That's it.

`npm run dev` is the one to use when you just want to move through the app
fast. `npm run dev:live` is for when you're testing the real payment rail.

## Logging in as someone

Dev sign-in is a special link, not a password:

- http://localhost:8099/dev/login?phone=0700000001 → Amina Wanjiru, the admin
- `0700000002` … `0700000005` → normal members
- `0700000099` → spare account

After the first successful sign-in you can also register a passkey and sign in
with your face/fingerprint from then on.

## Dev helpers

These only exist on the dev server and only from loopback (or through a tunnel
if you start it with `DEV_TOKEN`):

- `POST /dev/reset` → wipe the sqlite ledger, start fresh
- `GET /dev/state` → dump what's in the db
- `POST /dev/pay?contribution=<id>` → mark a contribution paid
- `POST /dev/pay-all?cycle=<id>` → fill a whole turn
- `GET /dev/checkout?id=<session>` → mark a simulated checkout paid
- `POST /dev/cancel?id=<session>` → cancel a simulated checkout
- `POST /dev/advance?group=<id>&step=<member|start|next|fund|settle|renew>` → move the circle forward
- `POST /dev/close-auction?cycle=<id>` → force a turn window closed

## The operator console

Sign in as `0700000001`, open Account, tap **Operator console → Open**, then
press and hold the latch for about a second. Different door, different room.

Inside you get the typed-ID queue (approve / return with a note), the audit
trail, the test-approval switch for sandbox top-ups, and the payment rail
check. It's walled off server-side — being an admin is a server fact, not a
hidden button.

## Payments (Paysasa)

All keys live in `dev/paysasa.local.env`. That file is gitignored and is never
served, logged, or bundled. The browser never sees them.

- `PAYSASA_API_KEY` → sandbox key
- `PAYSASA_BUSINESS_ID` → must be a business that the key can actually access
- `PAYSASA_WEBHOOK_SECRET` → must match the secret on the Paysasa webhook page
- `PAYSASA_SANDBOX=1` → declares the rail as sandbox, and only then does the
  operator test-approval switch open. With a live key it stays closed.

Webhook URL to register on Paysasa:

```
https://<your-origin>/functions/v1/app/payments/paysasa/webhook
```

Node needs `--use-system-ca` on this machine (the `dev:live` script already
has it), otherwise the corporate TLS interception makes Paysasa responses
unreadable.

Status right now: the latest sandbox key answers **403 "API key cannot access
this business"**, so live checkout is down until the matching Business ID is
pasted in. Simulated mode is unaffected and works fully.

## ID and phone checks (Kora)

Identity verification runs through Kora: national-ID lookup with name + date
of birth, then a phone-owner check. Add `KORA_SECRET_KEY=...` to
`dev/paysasa.local.env` to go live. Without a key the server runs a simulated
register:

| ID number | Name | Notes |
|---|---|---|
| 12345678 | Amina Wanjiru | |
| 23456789 | Brian Ochieng Otieno | |
| 34567890 | Cynthia Akinyi Achieng | |
| 45678901 | David Mbugua Kimani | DOB 1995-02-18, phone 254700000004 |
| 56789012 | Esther Wambui Njeri | |
| 67890123 | Faith Nyambura Muthoni | |
| 25219766 | Josephine Mary Okunmu | |

Anything else comes back "no record" and goes to the admin queue, which is the
correct behaviour — the register just doesn't know that person.

## Tunnel (for testing on a phone)

Download cloudflared once (or `winget install --id Cloudflare.cloudflared`),
then keep it running in its own terminal:

```
C:\Users\dell\AppData\Local\Temp\cloudflared.exe tunnel --url http://localhost:8099
```

Or, if installed properly:

```
cloudflared tunnel --url http://localhost:8099
```

It prints an `https://something.trycloudflare.com` URL. Every start gives a
new URL. When you get a new one:

1. copy it into `dev/paysasa.local.env` as `TRUSTED_ORIGINS=https://...`
2. restart **only the app server** (`npm run dev:live`) — leave cloudflared
   running, the URL stays the same while the process lives
3. open the tunnel URL on the phone; passkeys bind to that origin

To use the `/dev/*` helpers through the tunnel, start the server with a token:
`DEV_TOKEN=some-random-string npm run dev:live` and open
`/dev/login?token=some-random-string` once on the phone.

Quick tunnels have no uptime promise, and the free URL can die ("Tunnel not
found"). For a stable URL you need a named tunnel with a token from the
Cloudflare dashboard.

## Checks

```
npm test               # 71 tests, all the money paths
npm run check          # syntax check the server files
npm run build          # rebuild web/dist (22 assets)
npm run test:practice-ui   # headless browser pass on practice mode
```

`test:practice-ui` drives a whole six-turn practice circle in the isolated
headless test browser (CDP on port 9333) and writes its screenshots to
`dev/`. Those PNGs are generated evidence, not shipped assets.

## Design direction

No generic dashboard. It's a machine you operate: copper cuts, latches, servo
sounds, NURU the guide speaking plainly. Everything is built at 320px first
and scales up, with big touch targets and no hover-only actions. The operator
room is steel and quiet; the member side is warm. If a screen would look
identical as a white card in a Bootstrap template, it gets redrawn.

Three pre-rendered plates ship in `web/assets/studio/`: the machine hall behind
the landing wheel, the pot-light behind the round recap, and the chamber core.
The chamber is reused as the face of the landing wheel, inside the funding
engine, behind the circle seatwheel and behind the practice wheel. CSS moves
them (slow drift, breathing light, pistons and iris tied to how much of the pot
is funded), and `prefers-reduced-motion` or the engine's own pause switch stops
all of it. They are generated ahead of time, never at runtime — no API keys in
the browser. To swap in a Higgsfield (or any) render, replace the JPGs with the
same names and roughly the same crop; nothing else changes.

### The landing wheel

The hero is the same machine in miniature, and it is live:

- One brass seat coin per circle seat (5–12) orbits the rim. Adding a seat adds
  a coin; a bolder sealed bid spins the ring faster.
- The chamber plate inside the wheel brightens as the previewed pot grows, so
  seats and contribution change the light, not just the number.
- The sealed-bid card, patience-share card and funded-pot card are bound to the
  same settlement math as the receipt and the waterfall. A meter under the bid
  fills as the discount rises. Values flash when they change.
- The brand mark rotates as a low-contrast seal inside the hub, ringed by
  mechanical tick marks.
- On a fine pointer the whole stage tilts toward the cursor. Reduced motion
  stops every layer.

Because the preview and the backend share the same rules, changing seats,
contribution or bid updates the hero, the guided receipt and the settlement
waterfall together — there is no second set of numbers to maintain.

## Known limits (honest list)

- Paysasa live checkout is blocked until the Business ID matches the key.
- ID checks answer from the simulated register until `KORA_SECRET_KEY` is set.
- Payouts to M-PESA stay blocked until payout terms are verified
  (`payout_terms_unverified`). The sandbox can record them; it won't send.
- Cloud publishing is quota-blocked for now. Local + tunnel only.
