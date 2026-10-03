# Community robot preview

The optional `/pet` room is walletless. One community robot shares needs,
favorites, room props, and a scrapbook across visitors. It has no personal XP,
payments, token rewards, donations, competition, or AI chat. Existing local pet
saves and Hide/Pin preferences are preserved when switching modes.

## Flags and rollout

Both flags default off:

- Frontend build: `VITE_CHAINPAY_SHARED_PET=on` enables the shared companion and
  lazy `/pet` route. `VITE_CHAINPAY_PET=off` disables the floating companion.
- Axum **and the target Convex deployment**: `CHAINPAY_SHARED_PET=on` enables
  anonymous pet operations. Axum must use the existing Convex storage adapter.
  Unsupported storage or a disabled flag returns 503.

Keep the Convex service credential server-only. The browser talks to the
existing Axum `VITE_CHAINPAY_BACKEND_URL`; it never calls Convex directly.
Enabling a preview requires an explicitly chosen development deployment with
the updated schema/functions and flags, followed by the existing Axum/frontend
preview workflow. No deployment, push, financial action, or production cutover
was performed during this implementation. Disable the frontend flag to return
to the preserved local pet. Disable both backend flags to close shared writes.

Human usability acceptance and production rollout remain pending. Before
rollout, verify trusted edge peer configuration, session/rate limits, CORS,
actual preview persistence after restarting Axum, and the operator's intended
retention/privacy treatment. The tests below are local regression evidence,
not a deployed persistence or live-traffic acceptance claim.

## Anonymous API

| Method/path | Request | Response |
| --- | --- | --- |
| GET `/v1/pet/state` | none | `PetState` |
| POST `/v1/pet/visitors` | `{}` | `{token, expiresAt}` |
| POST `/v1/pet/act` | pet bearer token; `{commandId, action}` | `{state, outcome, replayed}` |
| GET `/v1/pet/memories` | optional `limit` (1–50), `before` cursor | `{memories, nextBefore, aggregates}` |

The contract is [shared/pet.ts](../../shared/pet.ts). Action intents are
`charge`, `play`, `polish`, `pat`, `ball`, `collect`, `coin`, `game`, `secret`,
and `wake`. Command IDs are UUID v4. Unknown fields, including supplied needs,
rewards or time, are rejected. A pet token is not a wallet or payment credential.
Tokens and trusted peer identities are SHA-256 hashed before persistence.
No raw token or peer identity appears in state, memories, or exported photos.
Sessions last 30 days. Visitor creation is limited to 20/minute and 200/day per
trusted peer, plus a global ceiling; actions have session and peer limits.
Public state and memory reads share a 600/minute trusted-peer limit. Rejections
return a bounded Retry-After interval based on the actual rate window.

The session is retained locally in the browser. Uncertain commands are retained
per tab in sessionStorage, with the exact original token and UUID. Manual retry
reuses them. The client never automatically replaces an uncertain command or
rewinds a newer confirmed snapshot with an old replay result. Expired sessions
reject old retries rather than reapply them; durable dedupe remains through the
session lifetime. Axum transport performs no automatic request retries.

## Shared behavior

Needs start at 80; hourly decay is battery 1, joy 1.5, cleanliness 0.75, with a
floor of 10. Charge/play/polish restore 50 up to 100, once per visitor and need
per 30 seconds. Ball and Allowance share the play cooldown. Full/cooldown results
still allow local affection and play, with explicit copy that no care was saved.

Server time controls decay and the 10-minute nap after each four awake hours.
Naps apply 0.3 decay; wake gently starts a fresh awake interval. Low-power starts
when any need is below 15 and ends only after every need exceeds 35. Simulation
is analytic across long absences and does not require an active browser.

Favorites use the preceding seven complete UTC days and require activity on two
different days. A visitor contributes at most once per activity per UTC day.
Daily evaluation retains the current favorite on ties and changes at most once.
Favorites affect ball placement, treasure inspection and visor presentation.
Routine care becomes daily aggregates; firsts, discoveries, favorite changes,
and recovery become truthful memories. Collected props are persisted; local
animations never lock other visitors out.

The room polls every five seconds; the quiet companion every 30 seconds (five
while its panel is open). Hidden tabs pause polling; returning focus refreshes.
The room retains its last confirmed snapshot when disconnected. WebGL failure
uses the illustrated room with the same controls, labels, and scrapbook.
Reduced motion preserves interactions without rolling/bouncing effects. Photo
export is explicit and includes only the current scene and optional caption.

## Verification

From the repository root:

```sh
npm run test:convex
npx tsc --noEmit -p convex/tsconfig.json
npm --prefix sdk run build
npm --prefix frontend test
npm --prefix frontend run build
cargo test --workspace
cargo +stable fmt --all -- --check
```

For shared browser regression, start Vite with the shared flag on at port 5191,
then run `npm --prefix frontend run test:community-pet-browser`. The suite mocks
only the narrow pet API and checks 390/768/1440px, 200% zoom, keyboard care,
non-WebGL and reduced-motion rendering, photo export, uncertain retries, hidden
polling, focus refresh, concurrent tabs, and scrapbook pagination races. It saves screenshots/PNG photos under `/private/tmp`.
Use `PET_BROWSER_BASE` for a different preview port. Existing legacy browser
checks use the default flag-off server on port 5189. Legacy cross-tab writes use
Web Locks where available; browsers without Web Locks reread before writes but
cannot guarantee atomic simultaneous legacy updates. Shared mode remains
server-atomic on every browser.
