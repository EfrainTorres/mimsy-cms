# Phase 5 — Auth & User Management

## Delivery Slices

Implement in 3 independent slices to keep blast radius small:

- **Slice A — Core auth (local mode)**: users.json (with roles section), PBKDF2, sessions, login page, setup page, middleware gate, logout
- **Slice B — RBAC enforcement**: permission resolution from role in middleware for both local and GitHub modes; AdminLayout sidebar + UI filtering
- **Slice C — User management UI**: UserManager.svelte island (users + roles tabs), users/roles API routes, settings page, AdminLayout "Settings" link

Each slice is independently shippable and testable. Build and verify A before starting B, B before C.

---

## Context

MimsyCMS currently has zero auth in local mode — anyone who reaches `/admin` has full access. GitHub mode has OAuth but no per-user roles. This phase adds username/password auth for local mode, role-based collection permissions for both modes, and an admin UI for managing users.

**Decisions:**
- Both modes get role/permissions (GitHub mode: look up GitHub login in users.json after OAuth; not found = 403)
- `admin` is a reserved role name — always full access + user/role management; cannot be customized or deleted
- All other roles are custom: admin creates named roles ("writer", "designer", etc.) with per-flag permissions
- Per-user `collections` overrides the role's `defaultCollections`; null = all collections
- Middleware resolves the full permission set from the user's role at request time

---

## Architecture

### Storage: `src/.mimsy-users.json` (committed to repo)

Accessed via adapter's `getProjectFile()` / `writeProjectFile()` — works identically in local mode (filesystem) and GitHub mode (GitHub API). Safe to commit because only PBKDF2 hashes are stored, not plaintext passwords.

```json
{
  "roles": {
    "writer": {
      "displayName": "Writer",
      "canDelete": false,
      "canMedia": false,
      "canPages": false,
      "canPublish": false,
      "defaultCollections": null
    },
    "editor": {
      "displayName": "Editor",
      "canDelete": true,
      "canMedia": true,
      "canPages": true,
      "canPublish": true,
      "defaultCollections": null
    }
  },
  "users": [
    { "username": "dev", "displayName": "Dev", "role": "admin", "sessionVersion": 1, "hash": "pbkdf2$...", "createdAt": "..." },
    { "username": "alice", "role": "writer", "collections": ["blog"], "sessionVersion": 1, "hash": "pbkdf2$...", "createdAt": "..." }
  ]
}
```

**Permission flags on custom roles:**
| Flag | Description |
|------|-------------|
| `canDelete` | Delete entries and media files |
| `canMedia` | Access media library (upload, browse, delete) |
| `canPages` | Access page editor (`.astro` text fields) |
| `canPublish` | Toggle draft ↔ published status |
| `defaultCollections` | `null` = all collections; `string[]` = specific ones (overridden per-user) |

`admin` role always has all permissions + user/role management. It is not stored in the `roles` map — it is resolved from the reserved role name.

### Password hashing: Web Crypto PBKDF2

No external dependencies. Works on Node.js, Cloudflare Workers, browsers. Format: `pbkdf2$100000$<base64-salt>$<base64-hash>`. Constant-time comparison via `crypto.subtle`.

### Sessions: HMAC-SHA256 signed cookie

No external dependencies. Cookie value: `base64url(JSON.stringify(payload)).<hmac-sha256-hex>`. Cookie name: `mimsy_session`. Flags: `httpOnly; Path=/; SameSite=Strict` (+ `Secure` in production). Expiry: 7 days. Secret from `MIMSY_SESSION_SECRET` env var.

Session payload includes `sessionVersion` for revocation — bumped in StoredUser on password reset or role **reassignment** (user's role field changed). Middleware rejects sessions where payload version doesn't match stored version. Permission flag changes on the role itself do NOT bump sessionVersion — flags are resolved fresh from users.json on every request.

Session payload (slim — no permissions in cookie, resolved fresh each request):
```ts
{ username: string; role: string; sessionVersion: number; exp: number; }
```

**CSRF protection**: `SameSite=Strict` on the session cookie significantly mitigates CSRF for all browser-initiated requests. As additional depth-of-defense, most `POST` and `PUT` data API routes additionally check `Content-Type: application/json`. `DELETE` routes are NOT checked for Content-Type — they have no body, and `SameSite=Strict` is sufficient coverage. See Slice B for the explicit exclusion list.

### Brute-force protection

Use a two-layer approach:

1. **Primary (production, recommended): Cloudflare edge rate limit** on `POST /api/mimsy/auth/local-login` (IP-based). This is the main control for Worker/multi-instance deployments.
2. **App-level fallback (all environments):** in-memory `Map<"username:ip", { count: number; lockedUntil?: number; lastFailAt: number }>` keyed by `username + ":" + ip` to prevent account-lock DoS (username-only keying lets an attacker lock out any account remotely). IP extracted from `X-Forwarded-For` header (Cloudflare/Vercel) with fallback to connection IP.

Thresholds (consistent throughout): After 5 consecutive failures, start exponential backoff delay before responding using `delaySeconds = min(2^(count - 5), 30)`. After 10 total failures for the same key, apply a hard 15-min lockout (`lockedUntil = Date.now() + 15*60*1000`). A failure streak is considered stale and reset if `lastFailAt` is older than 30 minutes before the next failure. Per-process storage resets on restart and is not shared across instances (acceptable as fallback because Cloudflare edge limiting is primary in production).

**Bounded memory**: Cap map at **10,000 entries**. On insert, prune stale entries first (`lastFailAt` older than 24h, or expired locks with `count < 5`), then evict oldest entries if still over cap. This keeps memory bounded without extra infra.

**Honeypot**: Not part of core auth flow. It can reduce basic bot noise, but it does not replace rate limiting or lockout and should remain optional.

### `MimsyUser` extension (types.ts)

Middleware resolves the full permission set from the user's role at request time and stores it in `locals.mimsyUser`:

```ts
interface MimsyUser {
  login: string;           // username (local mode) or GitHub login
  name: string;            // display name; fallback: login
  email?: string;          // absent for local-mode users
  avatar?: string;         // absent for local-mode users (AdminLayout shows initials fallback)
  // Resolved at request time from role lookup:
  role: string;            // e.g. 'admin', 'writer', 'editor'
  isAdmin: boolean;        // true only when role === 'admin'
  collections?: string[];  // undefined = all; resolved: user.collections ?? role.defaultCollections ?? undefined
  canDelete: boolean;
  canMedia: boolean;
  canPages: boolean;
  canPublish: boolean;
}
```

**AdminLayout avatar fallback**: When `user.avatar` is absent (local-mode users), render a CSS-only initials avatar using the first letter of `user.name` or `user.login`. No external image request.

Add new storage types:
```ts
interface StoredRole {
  displayName: string;
  canDelete: boolean;
  canMedia: boolean;
  canPages: boolean;
  canPublish: boolean;
  defaultCollections: string[] | null;  // null = all
}

interface StoredUser {
  username: string;
  displayName?: string;
  role: string;                  // references key in roles map, or 'admin'
  collections?: string[] | null; // overrides role.defaultCollections; null = all
  hash: string;
  sessionVersion: number;        // Bumped on password reset or role change
  createdAt: string;
}

interface UsersFile {
  roles: Record<string, StoredRole>;
  users: StoredUser[];
}
```

Note: role/permission flags are NOT stored in the session cookie — they're resolved from users.json on each authenticated request. This means role permission flag changes (canDelete, canMedia, etc.) take effect immediately without re-login. Only role reassignment (changing a user's `role` field) and password reset bump sessionVersion and force re-login.

---

## Permission Matrix

Permissions are resolved from the user's role at request time. `isAdmin` = reserved `admin` role.

All `{basePath}` references use `config.basePath` (not hardcoded `/admin`).

| Route pattern | Admin | Custom role (gate) | Unauthenticated |
|---|---|---|---|
| `GET {basePath}/login` | pass | pass | pass |
| `GET {basePath}/setup` | pass only when no users.json (first-run); otherwise → `{basePath}/login` | pass only when no users.json (first-run); otherwise → `{basePath}/login` | pass only when no users.json (first-run); otherwise → `{basePath}/login` |
| `GET {basePath}` (dashboard) | ✓ | ✓ (sidebar filtered) | → login |
| `GET {basePath}/{col}` or `{basePath}/{col}/*` | ✓ | ✓ if collection allowed | → login |
| `GET {basePath}/_page/*` | ✓ | ✓ if `canPages` | → login |
| `GET {basePath}/media` | ✓ | ✓ if `canMedia` | → login |
| `GET {basePath}/settings/*` | ✓ | → {basePath} | → login |
| `GET /api/mimsy/content/{col}*` | ✓ | ✓ if collection allowed | 401 |
| `POST/PUT /api/mimsy/content/{col}*` | ✓ | ✓ if collection allowed | 401 |
| `DELETE /api/mimsy/content/{col}*` | ✓ | ✓ if collection allowed AND `canDelete` | 401 |
| `PUT .../[slug]` (draft toggle) | ✓ | ✓ if `canPublish` (for draft field) | 401 |
| `GET /api/mimsy/collections` | ✓ (all) | ✓ filtered to allowed collections | 401 |
| `GET/PUT /api/mimsy/page-text/*` | ✓ | ✓ if `canPages` | 401 |
| `GET /api/mimsy/history` | ✓ | ✓ if collection allowed (from `?collection=` param) | 401 |
| `GET /api/mimsy/history/diff` | ✓ | ✓ if collection allowed (from `?collection=` param) | 401 |
| `POST /api/mimsy/deploy` | ✓ | ✓ if `canPublish` | 401 |
| `POST /api/mimsy/upload` | ✓ | ✓ if `canMedia` | 401 |
| `GET/DELETE /api/mimsy/media` | ✓ | GET: ✓ if `canMedia`; DELETE: ✓ if `canMedia` AND `canDelete` | 401 |
| `POST /api/mimsy/users` (first-run) | pass | pass | pass — **local mode only** (`!MIMSY_GITHUB_REPO` AND no users.json) |
| `GET /api/mimsy/users` | ✓ | 403 | 401 |
| `POST /api/mimsy/users` (normal) | ✓ | 403 | 401 |
| `PUT/DELETE /api/mimsy/users/{u}` | ✓ | 403 | 401 |
| `GET/POST /api/mimsy/roles` | ✓ | 403 | 401 |
| `PUT/DELETE /api/mimsy/roles/{id}` | ✓ | 403 | 401 |

**`canPublish` gate detail**: The draft toggle is a `PUT` to the entry update route (`[...slug].ts`). The route handler reads the body, compares **normalized booleans** (`Boolean(existing.frontmatter?.draft)` vs `Boolean(next.frontmatter?.draft)`), and returns 403 if changed and user lacks `canPublish`. All other field updates are allowed regardless of `canPublish`. This is intentionally in the route handler, not middleware — middleware must not buffer the request body.

**Collections filter**: `GET /api/mimsy/collections` reads `locals.mimsyUser.collections` and filters `listCollections()` results if the list is non-null. The command palette (AdminLayout) then only fetches entries for collections the user can see.

**`page-text` and `history` gates**: These are checked in middleware (path pattern matching on `/api/mimsy/page-text/` and `/api/mimsy/history`). The `collection` parameter in query string is validated against the user's allowed collections for `history` routes.

---

## Files

| File | Action | Slice | Purpose |
|------|--------|-------|---------|
| `src/auth/users.ts` | **CREATE** | A | loadUsers, saveUsers, resolvePermissions, hashPassword, verifyPassword, generatePassword, brute-force counter |
| `src/auth/session.ts` | **CREATE** | A | signSession, verifySession, SESSION_COOKIE constant |
| `src/pages/admin/login.astro` | **CREATE** | A | Login form page |
| `src/pages/admin/setup.astro` | **CREATE** | A | First-run setup (create first admin) |
| `src/api/auth/local-login.ts` | **CREATE** | A | POST — verify credentials, set session |
| `src/api/auth/local-logout.ts` | **CREATE** | A | POST — clear session cookie |
| `src/types.ts` | **MODIFY** | A | Extend MimsyUser (`email` + `avatar` required → optional; add `role`, `isAdmin`, `collections`, `canDelete`, `canMedia`, `canPages`, `canPublish`); add StoredUser, StoredRole, UsersFile |
| `src/middleware.ts` | **MODIFY** | A+B | Local mode auth gate (A) + full permission enforcement (B) |
| `src/pages/layouts/AdminLayout.astro` | **MODIFY** | A+B+C | Logout (A), sidebar/UI filtering by perms (B), Settings link (C) |
| `src/integration.ts` | **MODIFY** | A+C | Inject new routes |
| `src/pages/admin/settings/users.astro` | **CREATE** | C | Users & Roles management page (admin only) |
| `src/components/UserManager.svelte` | **CREATE** | C | Users + Roles tabs island |
| `src/api/mimsy/users/index.ts` | **CREATE** | C | GET list users, POST create user (admin only) |
| `src/api/mimsy/users/[username].ts` | **CREATE** | C | PUT update, DELETE, reset-password (admin only) |
| `src/api/mimsy/roles/index.ts` | **CREATE** | C | GET list roles, POST create role (admin only) |
| `src/api/mimsy/roles/[roleId].ts` | **CREATE** | C | PUT update role permissions, DELETE (admin only) |

---

## Slice A — Core Auth

### Step A1 — `auth/users.ts`

Key exports:
- `loadUsersFile(adapter)` — reads `src/.mimsy-users.json`. Throws if file exists but is malformed (fail closed). Uses a 60s in-memory cache, invalidated immediately by `saveUsersFile()`.
- `saveUsersFile(adapter, file)` — writes + invalidates the in-memory users cache so changes take effect on the next request
- `resolvePermissions(usersFile, storedUser)` — looks up the user's role in `usersFile.roles`. If role is `'admin'` → full admin permissions. If role not found in roles map → **throws `RoleNotFoundError`** (middleware returns 403 "Role no longer exists — contact your administrator"). Never silently upgrades to admin.
- `hashPassword(password)` — PBKDF2, format: `pbkdf2$100000$<base64-salt>$<base64-hash>`
- `verifyPassword(password, hash)` — re-derives, compares raw bytes (constant-time via `crypto.subtle`)
- `generatePassword()` — 16-char random alphanumeric
- `usersFileExists(adapter)` — boolean check (does not parse)
- `checkBruteForce(username, ip)` — returns `{ locked: boolean; delay?: number }`. Key: `${username.toLowerCase()}:${ip}`. After 5 failures: `delaySeconds = min(2^(count - 5), 30)`. After 10 failures: hard 15-min lockout. If `lastFailAt` is older than 30 minutes, the streak resets before applying thresholds.
- `recordFailure(username, ip)` / `clearFailures(username, ip)` — in-memory counters keyed by `username:ip`
- Usernames are **normalized to lowercase** on creation and comparison. GitHub login lookup is always case-insensitive (`storedUser.username.toLowerCase() === ghLogin.toLowerCase()`)

### Step A2 — `auth/session.ts`

```ts
export const SESSION_COOKIE = 'mimsy_session';
export async function signSession(data: SessionPayload, secret: string): Promise<string>
export async function verifySession(value: string, secret: string): Promise<SessionPayload | null>
```

HMAC-SHA256 via `crypto.subtle`. Returns null if signature invalid, malformed, or expired. After verifying signature + expiry, middleware additionally checks `payload.sessionVersion === storedUser.sessionVersion` to catch revoked sessions.

### Step A3 — Middleware (auth gate only, no RBAC yet)

Insert **before** the existing GitHub OAuth block. All redirect URLs use `basePath` variable (from `config.basePath`), never hardcoded `/admin`. Local mode check:

```
Is local mode (no MIMSY_GITHUB_REPO)?
  Path under {basePath}/* or /api/mimsy/*?
    users.json exists?
      No:
        POST /api/mimsy/users (first-run only, local mode only, body parsed in route) → pass through
        GET {basePath}/setup → pass through
        GET {basePath}/login → redirect to {basePath}/setup (avoid dead-end login before setup)
        {basePath}/* → redirect to {basePath}/setup
        /api/mimsy/* → 401
      Yes:
        Parse users.json
          parse fails → 500 "Auth config corrupted — check src/.mimsy-users.json"
        GET {basePath}/setup → redirect to {basePath}/login
        Public routes (login, local-login, local-logout) → pass through
        verify mimsy_session cookie
          Invalid/missing/revoked → /api/mimsy/* → 401; {basePath}/* → redirect {basePath}/login?next=...
          Valid → load users.json (cached), look up StoredUser by username
            User not found or sessionVersion mismatch → 401 (session revoked)
            resolvePermissions() → if role not found → 403; else set locals.mimsyUser
```

**Local-login is a form POST** (`application/x-www-form-urlencoded`). The Content-Type JSON check must NOT apply to `/api/mimsy/auth/local-login` or `/api/mimsy/auth/local-logout`. It applies only to data-mutation API routes.

**Setup page first-run POST**: The setup page (`{basePath}/setup`) is a plain HTML form (no JS) that POSTs to `/api/mimsy/users`. The `/api/mimsy/users` POST handler detects first-run (no users.json exists **AND** `!MIMSY_GITHUB_REPO`) and parses `application/x-www-form-urlencoded`. In GitHub mode, the first-run path is never reached — if users.json is missing, GitHub mode returns 403 unconditionally. When called via UserManager (admin creating a user), it always sends `application/json` and requires authentication.

**GitHub mode auth + role resolution** — two separate caches to prevent bypass:
1. **Token/identity cache** (`auth-cache.ts`, 5 min TTL): validates GitHub token → returns `{ login, name, email, avatar }`. Can be cached because it's a network validation.
2. **Users file cache** (`auth/users.ts`, 60s TTL, invalidated by `saveUsersFile()`): loads roles/permissions.

Middleware flow for GitHub mode:
```
Get GitHub identity (from token cache or live GitHub API)
  → invalid/expired → 401 or redirect to login
Load users.json via loadUsersFile() (60s cache, always executes — not short-circuited by token cache)
  → file missing → 403 "Not authorized" (GitHub mode requires explicit provisioning)
  → malformed → 500
Find stored user by GitHub login (case-insensitive)
  → not found → 403 "Not authorized"
resolvePermissions(usersFile, storedUser) → if role not found → 403
Merge GitHub identity + permissions → set locals.mimsyUser
```

The current code (middleware.ts line 74-79) short-circuits on `getCachedUser()` before doing users.json lookup. **This must change**: GitHub identity can be cached but role/permission resolution must always execute separately.

**GitHub push-permission check (middleware.ts lines 107-121)**: **KEEP** this check — it serves a complementary purpose. The push-permission check (calling the GitHub API to verify the authenticated user can push to the repo) is a repository-access gate independent of users.json provisioning. The two-layer flow is: (1) token cache validates GitHub identity → (2) push-permission check confirms repo write access → (3) users.json lookup confirms the user is provisioned with a role. All three must pass. Do not remove the push-permission check.

**GitHub mode bootstrap path** (documented, not code): before first GitHub deployment, the developer must:
1. Run the playground locally (`npx astro dev`) without `MIMSY_GITHUB_REPO` set (local mode)
2. Visit `{basePath}/setup` (default: `/admin/setup`) and create first admin user using your **exact GitHub login** as username (case-insensitive match at runtime) → this writes `src/.mimsy-users.json`
3. Commit and push `src/.mimsy-users.json` to the repo
4. Add `MIMSY_GITHUB_REPO` (and other env vars) to deployment — now GitHub OAuth works

This is the required sequence. It must be documented in README, and when GitHub mode sees missing users.json it should return a clear 403 page/message with these exact setup steps (not a generic forbidden error).

### Step A4 — Login page (`pages/admin/login.astro`)

Plain HTML form (no client JS): username + password fields. POST to `/api/mimsy/auth/local-login`. Error shown via `?error=1` query param (generic "Invalid credentials" — no hint about username vs password). Supports `?next=` redirect param — the login form preserves the `?next=` value as a hidden input so the POST handler can read it.

### Step A5 — Setup page (`pages/admin/setup.astro`)

Only reachable in local mode when no users.json exists (middleware redirects there). If users.json already exists, visiting `{basePath}/setup` redirects to `{basePath}/login`. Form: username + password + confirm. POSTs to `/api/mimsy/users` (first-run allowed without auth in local mode only). Creates users.json with one admin (`sessionVersion: 1`), redirects to `{basePath}/login`.

If the maintainer plans to use GitHub mode later, setup UI should include helper text: "Use your GitHub login as username."

### Step A6 — `POST /api/mimsy/auth/local-login`
- Extract IP from `X-Forwarded-For` header (take first value) or connection remote address
- Read `basePath` from `config.basePath` (via `virtual:mimsy/config`) — used for all redirects
- Check brute-force counter for `username:ip` — if locked, redirect to `{basePath}/login?error=locked` immediately (no DB lookup)
- Load + parse users.json; if malformed → 500
- Find user by username (case-insensitive, normalized to lowercase)
- Verify password (always run verifyPassword even if user not found, with dummy hash, to prevent timing oracle)
- On failure: `recordFailure(username, ip)` with exponential delay (await delay before responding), redirect to `{basePath}/login?error=1`
- On success: `clearFailures(username, ip)`, sign session with `sessionVersion`, set `SameSite=Strict; HttpOnly` cookie, redirect to validated `?next` or `{basePath}`. **`?next=` validation**: only allow relative paths that start with `basePath` (must begin with `/`, not `//` or a protocol). Reject any value that is absolute, protocol-relative, or does not start with `basePath`. Fall back to `{basePath}` on rejection.

### Step A7 — `POST /api/mimsy/auth/local-logout`
- Clear `mimsy_session` cookie (max-age=0) → redirect to `{basePath}/login`

### Step A8 — Integration route injection (Slice A routes)
```ts
{ pattern: `${base}/login`, entrypoint: pages/admin/login.astro }
{ pattern: `${base}/setup`, entrypoint: pages/admin/setup.astro }
{ pattern: '/api/mimsy/auth/local-login', entrypoint: api/auth/local-login.ts }
{ pattern: '/api/mimsy/auth/local-logout', entrypoint: api/auth/local-logout.ts }
```

---

## Slice B — RBAC Enforcement

### Step B1 — Middleware (full permission enforcement)

Add after `locals.mimsyUser` is set (both modes). All checks short-circuit for `isAdmin === true`.

**Route matching order (IMPORTANT)**: Evaluate paths in this exact order to avoid reserved admin paths being misidentified as collection routes. Reserved paths must be matched first; collection matching is the final catch-all.

1. `{basePath}/login` — public. `{basePath}/setup` — first-run only; when users.json exists it is already redirected to `{basePath}/login` by auth gate.
2. `{basePath}/_page/*` — pages gate
3. `{basePath}/media` — media gate
4. `{basePath}/settings/*` — settings gate (admin-only redirect)
5. `{basePath}/{col}` OR `{basePath}/{col}/*` — collection gate (any remaining path segment after basePath)

The collection segment is extracted as the first path component after `basePath` — e.g., `pathname.slice(basePath.length + 1).split('/')[0]`. This covers both the collection index (`{basePath}/blog`) and sub-pages (`{basePath}/blog/new-post`). If no segment exists after `basePath` (dashboard route), skip collection gating.

For non-admin users (resolved via `resolvePermissions()`). All redirect paths use `basePath`. Admin-only page redirects append `?toast=access-denied` so AdminLayout can show a toast:
- `GET {basePath}/{col}` or `{basePath}/{col}/*` → check collection in `user.collections` list → redirect to `{basePath}?toast=access-denied` if not allowed
- `GET {basePath}/_page/*` → check `user.canPages` → redirect to `{basePath}?toast=access-denied` if false
- `GET {basePath}/media` → check `user.canMedia` → redirect to `{basePath}?toast=access-denied` if false
- `GET {basePath}/settings/*` → always redirect non-admins to `{basePath}` (no toast — settings existence is implicit)
- `DELETE /api/mimsy/content/{col}/*` → check `canDelete` AND collection → 403 if either fails
- `POST/PUT /api/mimsy/content/{col}/*` → check collection → 403 if not allowed
- `GET /api/mimsy/content/{col}*` → check collection → 403 if not allowed
- `GET/PUT /api/mimsy/page-text/*` → check `canPages` → 403 if false
- `GET /api/mimsy/history` → check `collection` query param against `user.collections` → 403 if not allowed
- `GET /api/mimsy/history/diff` → check `collection` query param against `user.collections` → 403 if not allowed
- `POST /api/mimsy/deploy` → check `canPublish` → 403 if false
- `POST /api/mimsy/upload`, `GET/DELETE /api/mimsy/media` → check `canMedia` → 403 if false
- `PUT /api/mimsy/content/{col}/*` — `canPublish` gate for draft changes is checked **in the API route handler** (`[...slug].ts`), not middleware. Middleware cannot cleanly read and re-buffer the request body; the route handler parses the body, compares normalized draft booleans (`Boolean(oldDraft)` vs `Boolean(newDraft)`), and returns 403 if the user lacks `canPublish` and is attempting to change draft state. All other field updates proceed normally regardless of `canPublish`.
- `/api/mimsy/users/*`, `/api/mimsy/roles/*` → 403 for all non-admins
- `GET /api/mimsy/collections` → pass through (collection list filtered in the API route handler itself, not middleware)

**"Access denied" toast mechanism**: Middleware cannot dispatch client-side events. Instead, middleware redirects to `{basePath}?toast=access-denied`. AdminLayout `<script is:inline>` (inside the `window.__mimsyInit` guard) reads `new URLSearchParams(window.location.search).get('toast')` on page load — if `'access-denied'`, fires `window.dispatchEvent(new CustomEvent('mimsy:toast', { detail: { message: 'Access denied', type: 'error' } }))` and cleans up the URL by deleting only the `toast` param: `const p = new URLSearchParams(location.search); p.delete('toast'); history.replaceState(null, '', location.pathname + (p.size ? '?' + p : ''))`. Other existing query params are preserved.

Check `Content-Type: application/json` on `POST` and `PUT` data API routes (accept `application/json` with optional charset parameters). **Do NOT check** on:
- `DELETE` routes (no body; `SameSite=Strict` is sufficient)
- `/api/mimsy/auth/local-login` (form submit — `application/x-www-form-urlencoded`)
- `/api/mimsy/auth/local-logout` (form submit, no body)
- `/api/mimsy/upload` (multipart/form-data — upload route already enforces this itself)
- `/api/mimsy/deploy` (POST with no body — client sends no JSON body and route parses no body)
- `/api/mimsy/users` POST when `usersFileExists()` returns false (first-run form submit)

### Step B2 — AdminLayout + UI filtering

Pass resolved `user` (from `locals.mimsyUser`) to AdminLayout. Use permission flags to conditionally render:
- Sidebar collection list: filtered to `user.collections` if not null
- "Media" nav link: hidden if `!user.canMedia`
- "Pages" nav link: hidden if `!user.canPages`
- "Settings" nav link: shown only when `user.isAdmin`
- Draft toggle in entry editor: disabled/hidden if `!user.canPublish`
- Delete buttons: hidden if `!user.canDelete`

Add logout button: local mode → form POST to `/api/mimsy/auth/local-logout`; GitHub mode → existing `/api/mimsy/auth/logout` link.

---

## Slice C — User Management UI

### Step C1 — Users API routes

**`GET /api/mimsy/users`** — Admin only → return users list (hash + sessionVersion stripped)

**`POST /api/mimsy/users`** — Admin only (or first-run: no users.json exists → allowed unauthenticated, **local mode only**)
- **First-run** (no users.json, `!MIMSY_GITHUB_REPO`): accepts `application/x-www-form-urlencoded` (from setup page HTML form). Re-checks `usersFileExists()` before writing — if a race condition created the file between the middleware check and the write, return 403 (documented: single-developer setup, extremely unlikely, but fail closed). **Ignores any submitted `role` or `collections` values — always forces `{ role: 'admin', collections: null }` regardless of form input.** This prevents a tampered form from creating a non-admin first user.
- **Normal** (admin call from UserManager): requires `Content-Type: application/json` + authenticated admin session.
- **First-run path**: `{ username, displayName?, password }` — role and collections silently ignored (forced to admin/null). Validates: username `/^[a-zA-Z0-9_-]+$/`, normalize to lowercase, password >= 8 chars.
- **Normal path**: `{ username, displayName?, role, collections?, password }`. Validates: username `/^[a-zA-Z0-9_-]+$/`, normalize to lowercase, role must exist in roles map or be `'admin'`, password >= 8 chars.
- Hash password, `sessionVersion: 1`, append to users array, save

**`PUT /api/mimsy/users/[username]`** — Admin only
- Check `Content-Type: application/json`
- Body: `{ role?, collections?, displayName?, action? }`
- `action: 'reset'` → generate password, hash, bump `sessionVersion`, save → return `{ password }` once
- Role **reassignment** (changing the user's `role` field): bump `sessionVersion` (forces re-login with new role)
- Collections change: bump `sessionVersion` (forces re-login with updated collections scope)
- `displayName` change only: NO sessionVersion bump (display-only)
- Role permission flag edits (on the role itself, not the user): handled by the roles API — no sessionVersion bump needed on any user, permissions resolve fresh
- Cannot change own role away from `admin`

**`DELETE /api/mimsy/users/[username]`** — Admin only (no Content-Type check)
- Cannot delete self; must leave at least one admin user

### Step C2 — Roles API routes

**`GET /api/mimsy/roles`** — Admin only → return all custom roles (plus `admin` sentinel)

**`POST /api/mimsy/roles`** — Admin only
- Check `Content-Type: application/json`
- Body: `{ id, displayName, canDelete, canMedia, canPages, canPublish, defaultCollections? }`
- `id` must match `/^[a-zA-Z0-9_-]+$/` and not be `'admin'`
- Append to roles map, save

**`PUT /api/mimsy/roles/[roleId]`** — Admin only
- Check `Content-Type: application/json`
- Body: `{ displayName?, canDelete?, canMedia?, canPages?, canPublish?, defaultCollections? }`
- Cannot update `admin` role (reserved)
- Permission changes take effect immediately (no sessionVersion bump needed — permissions are resolved fresh each request)

**`DELETE /api/mimsy/roles/[roleId]`** — Admin only
- Cannot delete `admin` role
- Returns 400 if any user currently has this role (must reassign users first)

### Step C3 — UserManager.svelte (`client:load`)

Single island with two tabs: **Users** and **Roles**.

**Users tab:**
- Table: username, display name, role badge (colored by role), collection list, action buttons
- Add user form: username, display name, role dropdown (from roles API), collection multi-select, password field
- Edit: change role, change collections (inline)
- Reset password: confirm → show generated password in `<code>` with copy button + "shown once" warning
- Delete: confirm dialog, disabled for self + last admin

**Roles tab:**
- Table: role name, display name, permission flags as icon badges, # of users, action buttons
- Add role form: name (slug), display name, permission checkboxes (canDelete, canMedia, canPages, canPublish), default collections multi-select (optional)
- Edit: inline permission checkboxes, takes effect immediately
- Delete: disabled if any users have this role (shows user count as tooltip)

### Step C4 — Integration route injection (Slice C routes)
```ts
{ pattern: `${base}/settings/users`, entrypoint: pages/admin/settings/users.astro }
{ pattern: '/api/mimsy/users', entrypoint: api/mimsy/users/index.ts }
{ pattern: '/api/mimsy/users/[username]', entrypoint: api/mimsy/users/[username].ts }
{ pattern: '/api/mimsy/roles', entrypoint: api/mimsy/roles/index.ts }
{ pattern: '/api/mimsy/roles/[roleId]', entrypoint: api/mimsy/roles/[roleId].ts }
```

---

## Env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `MIMSY_SESSION_SECRET` | Yes in production | HMAC key for session signing |

**Secret handling by environment:**
- **Development** (`NODE_ENV !== 'production'`): If `MIMSY_SESSION_SECRET` is unset and users.json exists, generate an ephemeral per-process secret (`crypto.getRandomValues()`) and print a loud `console.warn('[mimsy] MIMSY_SESSION_SECRET not set — using ephemeral session secret. All sessions will be lost on restart. Set this env var for stable sessions.')`. This lets new setups work immediately without a .env file.
- **Production** (`NODE_ENV === 'production'`): If `MIMSY_SESSION_SECRET` is unset, middleware hard-fails immediately on the first protected request with a 500 response containing a clear error message. No ephemeral fallback.
- Warn at `astro:config:setup` if unset in production, but don't hard-fail at build time (users.json may not exist yet on first deploy).

---

## Edge cases

| Case | Handling |
|------|----------|
| No `MIMSY_SESSION_SECRET` in dev | Ephemeral per-process secret generated with loud `console.warn`; sessions lost on restart |
| No `MIMSY_SESSION_SECRET` in prod | Middleware hard-fails with 500 "Set MIMSY_SESSION_SECRET env var" |
| users.json malformed | Middleware returns 500 "Auth config corrupted — check src/.mimsy-users.json"; never redirects to setup (fail closed) |
| Unknown role in users.json | `resolvePermissions` throws `RoleNotFoundError`; middleware returns 403 "Role no longer exists — contact your admin" |
| Last admin deletes self | API returns 400 |
| Editor visits disallowed collection | Middleware redirects to `{basePath}?toast=access-denied`; AdminLayout reads query param on load and fires `mimsy:toast` CustomEvent, then removes only the `toast` param via `history.replaceState` (preserves other query params) |
| GitHub mode + no users.json | All OAuth users get 403 (explicit provisioning required), with a clear setup message pointing to the bootstrap steps |
| GitHub mode user not in users.json | 403 Forbidden |
| GitHub bootstrap username mismatch | User can authenticate with OAuth but gets 403 until their users.json username matches GitHub login (case-insensitive); setup UI and docs instruct this explicitly |
| GitHub role resolution after role change | Users file cache (60s TTL) invalidated immediately by `saveUsersFile()` → change takes effect on next request |
| GitHub token cache bypass | Token cache (auth-cache.ts) only caches identity; users.json lookup always executes separately — role changes visible immediately after cache invalidation |
| Username with path chars | Validated: alphanumeric + hyphen + underscore only, normalized to lowercase |
| Username case collision ("Dev" vs "dev") | Lowercased on creation; duplicate check is case-insensitive |
| Cloudflare rate limit enabled | Repeated abusive login bursts can be blocked at edge with 429 before app handler runs; app-level username:ip backoff/lock remains fallback |
| Old failed-attempt streak | If `lastFailAt` is older than 30 minutes, failure count resets before applying backoff/lockout |
| Brute force (5+ failures on username:ip) | Exponential backoff `min(2^(count-5), 30)` seconds; after 10 total failures → hard 15-min lockout; `?error=locked` shows "Account temporarily locked" |
| Brute force (username-only attack) | username:ip keying prevents account-lock DoS — different IP gets separate counter |
| Session after password reset | sessionVersion bumped + cache invalidated → old session rejected on next request |
| Session after role reassignment | sessionVersion bumped → old session rejected; new permissions apply on next login |
| Role permission flag change (not reassignment) | No sessionVersion bump; permissions resolved fresh on next request automatically |
| First-run race (2 POSTs simultaneously) | POST /api/mimsy/users re-checks `usersFileExists()` before write; if file now exists and caller is not admin → 403. Not fully atomic but sufficient for single-developer setup |
| CSRF attempt | SameSite=Strict blocks all cross-site cookie use; Content-Type JSON check on data API routes (POST/PUT) as additional depth-of-defense |
| local-login form missing Content-Type check | `/api/mimsy/auth/local-login` is explicitly excluded from the Content-Type JSON enforcement |
| deploy.ts currently has no auth | `POST /api/mimsy/deploy` will add `canPublish` gate in Slice B |
| `?toast=access-denied` param persists on refresh | `URLSearchParams.delete('toast')` + `history.replaceState` removes only that param immediately after toast fires; other params preserved. Manual refresh fires toast once more (harmless) |
| `?next=` open redirect | Validated server-side: must be relative, must start with `basePath`, must not start with `//` or contain a protocol. Falls back to `{basePath}` on rejection. |

---

## Verification

**Slice A:**
1. `cd playground && npx astro dev`
2. **First run (no users.json)**: visit `/admin` → redirects to `{basePath}/setup` (not 401). Visiting `{basePath}/login` also redirects to `{basePath}/setup`. Complete setup form → creates users.json → redirects to `{basePath}/login`. Log in → full admin access.
3. **Dev with no MIMSY_SESSION_SECRET**: `console.warn` appears. Sessions work but reset on server restart.
4. Wrong password: generic "Invalid credentials" + same delay regardless of username existence
5. Repeated wrong passwords (same username+IP): backoff delays increase (`min(2^(count-5), 30)`); after 10: "Account temporarily locked". If Cloudflare edge rate limiting is enabled, abusive bursts may return 429 before app-level lockout.
6. Logout: session cleared → redirect to login
7. Corrupt users.json: middleware returns 500 HTML error (never redirects to setup)
8. **First-run race**: two tabs both try to submit setup form simultaneously → second gets 403 after first creates the file
9. **Open redirect**: tamper `?next=https://evil.com` → rejected, redirects to `{basePath}` instead

**Slice B:**
10. Create `writer` role (canPages=false) and alice user (role=writer, collections=[blog]) by editing users.json directly
11. Log in as alice → sidebar shows only "blog"; no Media link, no Pages link
12. Visit `{basePath}/authors` → redirected to `{basePath}` with "Access denied" toast
13. Visit `{basePath}/_page/home` → redirected to `{basePath}` with "Access denied" toast (canPages=false)
14. `GET /api/mimsy/page-text/home.astro` (as alice) → 403
15. `GET /api/mimsy/history?collection=authors&slug=test` (as alice) → 403 (not in allowed collections)
16. `POST /api/mimsy/deploy` (as alice, canPublish=false) → 403
17. `GET /api/mimsy/collections` (as alice) → only `["blog"]` returned (filtered)
18. GitHub mode: users.json present, GitHub login not in it → 403
19. Edit alice's role in users.json to have `"role": "nonexistent-role"` → next request returns 403 "Role no longer exists" (NOT admin access)

**Slice C:**
20. Settings → Users & Roles page (admin only, not visible to alice)
21. Roles tab → create "writer" role: canDelete=false, canMedia=false, canPages=false, canPublish=false
22. Users tab → add alice, role=writer, collections=[blog] → reset gives 16-char temp password
23. Log in as alice → no Media link, no Pages link, no delete buttons, only blog collection visible
24. Back as admin → update "writer" role to set canMedia=true → **no re-login needed for alice** → Media link appears on next request
25. Assign alice to "editor" role → alice's current session is **invalidated** (sessionVersion bumped) → alice must re-login → now has full editor permissions
26. Delete "writer" role while alice is assigned → 400 (must reassign first)
