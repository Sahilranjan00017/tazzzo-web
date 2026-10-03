# Engineering status

| Area                                      | State       |
| ----------------------------------------- | ----------- |
| W1 CMS foundation scaffold (`apps/admin`) | IN REVIEW   |
| Google OAuth / OIDC sign-in               | NOT STARTED |
| CMS session (cookie + server-side store)  | NOT STARTED |
| Backend integration (`/me`, BFF API)      | NOT STARTED |
| CMS business modules                      | NOT STARTED |
| Customer web app (`apps/web`)             | NOT STARTED |

Next: **W2**, which adds Google authorization code + state + OIDC nonce + PKCE (`openid-client`), the Valkey/Redis
session with an encrypted ID token, the HttpOnly session cookie, logout, session validation, the backend `/me`
bootstrap, 401/403 handling and mock-OIDC integration tests.
