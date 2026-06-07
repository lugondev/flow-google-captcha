# Flow Kit — WXT

A Chrome / Firefox extension that bridges a local Python agent to the Google
Flow API on [labs.google](https://labs.google). It captures the user's bearer
token, solves enterprise reCAPTCHA from a real Flow tab, and proxies
authenticated API + tRPC calls through the browser context so reCAPTCHA stays
bound to a legitimate session.

> WXT rewrite of [lugondev/flow-google-captcha](https://github.com/lugondev/flow-google-captcha).

## What it does

| Subsystem | Where | What it does |
| --- | --- | --- |
| **Token capture** | `entrypoints/background/index.ts` | Sniffs the `Authorization: Bearer ya29.…` header on every `aisandbox-pa.googleapis.com` request via `chrome.webRequest` and stores it in `chrome.storage.local`. |
| **reCAPTCHA solver** | `entrypoints/flow-bridge-main.ts` | Injected into the Flow page's MAIN world, calls `grecaptcha.enterprise.execute(SITE_KEY, { action })` when asked. |
| **API proxy** | `entrypoints/background/api-proxy.ts` | Solves a captcha, splices the token into the request body's `recaptchaContext.token`, then re-emits the request with the captured bearer token from the browser context. |
| **tRPC proxy** | `entrypoints/background/api-proxy.ts` | Same pattern for `labs.google/fx/api/trpc/*` calls (no captcha needed). |
| **TRPC media-URL harvester** | `entrypoints/flow-bridge-main.ts` | Monkey-patches `window.fetch` to clone TRPC responses and forward fresh signed GCS media URLs back to the agent. |
| **Telemetry** | `entrypoints/background/telemetry.ts` | Sends randomized `FLOW_*_LATENCY` / `GRID_SCROLL_DEPTH` events to Google's analytics endpoints every 45–120s to keep the session looking organic. |
| **WS transport** | `entrypoints/background/websocket.ts` | Connects to a local agent over `ws://127.0.0.1:9222`. API responses are also POSTed to `http://127.0.0.1:8100/api/ext/callback` so they survive transient WS disconnects. |
| **UI** | `entrypoints/popup/`, `entrypoints/sidepanel/` | Status, metrics, request log, ON/OFF toggle. |

## Project layout

```
flow-google-captcha/
├── entrypoints/
│   ├── background/
│   │   ├── index.ts        # main service worker
│   │   ├── state.ts        # global state + persistent storage
│   │   ├── websocket.ts    # agent <-> extension transport
│   │   ├── captcha.ts      # captcha solving from the active Flow tab
│   │   ├── api-proxy.ts    # API + tRPC request proxy
│   │   ├── telemetry.ts    # human-like telemetry
│   │   ├── log.ts          # in-memory request log
│   │   ├── trpc-media.ts   # tRPC media URL extractor
│   │   └── types.ts
│   ├── flow-bridge.content/
│   │   └── index.ts        # ISOLATED-world bridge (uses injectScript)
│   ├── flow-bridge-main.ts # unlisted MAIN-world script (grecaptcha + fetch hook)
│   ├── popup/
│   │   ├── index.html
│   │   └── main.ts
│   └── sidepanel/
│       ├── index.html
│       └── main.ts
├── public/
│   ├── icon/{16,32,48,96,128}.png
│   └── rules.json          # declarativeNetRequest (Referer/Origin)
├── wxt.config.ts
├── package.json
├── tsconfig.json
└── .gitignore
```

## Setup

```bash
pnpm install            # or npm install / yarn
```

## Development

```bash
# Chrome / Edge / Brave (Chromium MV3)
pnpm dev

# Firefox
pnpm dev:firefox
```

WXT will start a dev server with HMR for the UI, then print the path to a
rebuilt `.output/chrome-mv3` directory. Load it as an **unpacked extension**
in `chrome://extensions` (enable Developer mode first).

## Build

```bash
pnpm build              # .output/chrome-mv3
pnpm build:firefox      # .output/firefox-mv2
pnpm zip                # produces a .zip ready for the Chrome Web Store
```

## Message protocol with the local agent

The extension speaks two transports to the local Python agent:

### WebSocket `ws://127.0.0.1:9222`

Inbound (extension → agent, unsolicited):

```json
{ "type": "extension_ready", "flowKeyPresent": true, "tokenAge": 12345 }
{ "type": "token_captured",  "flowKey": "ya29.…" }
{ "type": "media_urls_refresh", "urls": [{ "mediaType": "video", "url": "…", "mediaId": "…" }] }
```

Outbound (agent → extension, request/response):

```json
{ "method": "api_request", "id": "abc", "params": {
    "url": "https://aisandbox-pa.googleapis.com/v1/projects/.../flowMedia:batchGenerateImages",
    "method": "POST", "headers": {...}, "body": {...},
    "captchaAction": "IMAGE_GENERATION"
} }

{ "method": "trpc_request", "id": "def", "params": {
    "url": "https://labs.google/fx/api/trpc/...",
    "method": "POST", "body": {...}
} }

{ "method": "solve_captcha", "id": "ghi", "params": { "captchaAction": "VIDEO_GENERATION" } }

{ "method": "get_status", "id": "jkl" }
```

### HTTP callback `http://127.0.0.1:8100/api/ext/callback`

API responses (`{id, status, data}` / `{id, error}`) are POSTed here so they
survive a transient WS blip. WS is the fallback when the callback is
unreachable.

### `captchaAction` values

`IMAGE_GENERATION` · `VIDEO_GENERATION` — passed to
`grecaptcha.enterprise.execute(SITE_KEY, { action })`.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Persist `flowKey` and metrics |
| `alarms` | Keep-alive pings, token refresh, WS reconnect |
| `tabs` | Find / open the active Flow tab |
| `webRequest` + `extraHeaders` | Sniff bearer token from outgoing requests |
| `scripting` | Manually re-inject content script when WS reconnect races page load |
| `declarativeNetRequest` | Set `Referer` / `Origin` on API calls |
| `sidePanel` | The side panel UI |

Host permissions: `https://labs.google/*`, `https://aisandbox-pa.googleapis.com/*`,
`http://127.0.0.1:8100/*`.

## Caveats

* This extension exists to drive Google Flow from a local Python agent. It
  re-uses the user's existing browser session and token. It does not bypass
  Google's reCAPTCHA — it solves it from the user's own logged-in Flow tab.
* The site key `6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV` is Google's
  enterprise key for `labs.google`. It is part of the public page source and
  is not a secret.
* Bearer tokens expire after ~60 min. The extension auto-refreshes every
  45 min via a background alarm; the side panel will also auto-refresh when
  the token is older than 55 min.

## License

See [lugondev/flow-google-captcha](https://github.com/lugondev/flow-google-captcha) for license terms.
