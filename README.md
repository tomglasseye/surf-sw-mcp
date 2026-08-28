# surf-mcp — a Claude connector for the surf API

Lets Claude answer questions like:

> where's the best surf near Newquay tomorrow morning?
> which beach is nicest to sit on this afternoon?
> how's Croyde looking on Saturday?

It is a thin MCP server over the deployed surf API. It fetches the same
payload the app does and does the ranking in code, so a spot cannot score one
way in the app and another way here.

## Why a connector rather than pasting the API URL into a chat

Because the arithmetic has to happen in code. Asking a model to read a 3–5MB
JSON payload and rank 126 spots is exactly the operation that produced the
fabricated region counts retracted in `docs/FORECAST_ACCURACY_AUDIT.md` — the
same question asked twice gave two different answers, one summing to 146 spots
instead of 126. Distance, filtering and ranking here are ordinary functions
with tests.

## Tools

| Tool | Answers |
|---|---|
| `find_surf_spots` | "where should I surf near me" — ranked by surf score |
| `find_beach_spots` | "where's a nice beach today" — ranked by beach-day score |
| `get_spot_forecast` | hour-by-hour detail and score breakdown for one break |
| `list_spots` | what's in the dataset, by region |

All of them take a location (`near` as a place name, or `latitude`/`longitude`)
and a time (`date` plus `part_of_day`). Place names are geocoded through
Open-Meteo, preferring UK matches — without that, "Perth" and "Boston" quietly
resolve to the wrong continent.

## The beach-day score

The surf API already scores hours for surfing, swimming, SUP, a family splash
and kiting. None of those answer "is it a nice day to sit on the beach", and
every one of them is built from waves and wind alone — the two things that
actually decide a beach day, **temperature and rain**, appear in none of them.

So `src/beach-day.js` adds one. It is not an average:

```
score = base(wind, temperature, waves)
        × coldGate(temp) × rainGate(rain) × galeGate(wind)
```

Cold, rain and a gale each end a beach day on their own, whatever the other two
are doing, so each multiplies rather than contributing a share. Both ends of
that were found by testing rather than assumed: weighted, a 9°C dead-calm flat
day scored 63/100, and a 24°C day in a 35km/h gale scored 64.

This lives in the connector, not the API, because the app has no beach-day
feature — so there is no second engine to drift away from the first, which is
what went wrong with `calculateComprehensiveSurfScore`. **If the app ever grows
one, move this module into the API and have the connector read the result.**

## Running it locally

```bash
npm install
npm test              # 46 tests, no network needed
npx netlify dev       # serves http://localhost:8888/mcp
```

Point a client at `http://localhost:8888/mcp`, or drive it by hand:

```bash
curl -s localhost:8888/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Both `accept` types are required.** The transport rejects anything else with
`406 Not Acceptable` before it reads the body, which looks like a broken deploy
if you are not expecting it. There is a test pinning that, for exactly this
reason.

### A note on the transport

Netlify's guide, and most examples still online, wrap the Node transport with
`fetch-to-node`. Every POST came back `400` with an empty body that way. Since
SDK 1.30 the Web-standard transport is the real implementation and the Node one
is a thin adapter over it, so this talks to
`WebStandardStreamableHTTPServerTransport` directly — it takes a `Request` and
returns a `Response`, which is exactly what a Netlify Function already has. One
fewer dependency and one fewer layer to be wrong.

It runs with `enableJsonResponse: true`, so requests answer as plain JSON
rather than opening an SSE stream: a serverless function is killed by
wall-clock time, so holding a stream open is the one thing it must not do.

## Deploying

This is a separate Netlify site from the surf API — the API is a long-running
Node process with an in-process cron, which does not fit a function; this is
stateless and does.

1. Push the repo.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
3. Set **Base directory** to `mcp`. Leave the build command empty; publish
   directory `public`.
4. Deploy. The endpoint is `https://<your-site>.netlify.app/mcp`.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SURF_API_URL` | `https://surferdood.inpn.io` | Base URL of the surf API |

Set it in **Site configuration → Environment variables** if the API moves.

## Adding it to Claude

**Settings → Connectors → Add custom connector**, paste the full `/mcp` URL,
click Add. No OAuth needed — it reads the same public API the app serves.

Worth knowing: that makes the endpoint public. The data behind it is already
public, but the connector will pass traffic to your API, so if that ever
matters, put a shared secret in front of it.

## Limits worth knowing

- **No cloud cover.** The surf API requests temperature, humidity,
  precipitation, pressure and wind from Open-Meteo, but not `cloud_cover`, so
  the beach score cannot tell bright from overcast. Adding `cloud_cover` to
  `HOURLY_PARAMS` in `src/services/integrations/meto-forecast.js` (and to
  `toDomain`, which maps exactly those fields) would fix it.
- **Future days can be coarser.** `/surf/summary` only carries hourly records
  for today. The connector retries against `/surf` for later days and falls
  back to day-level averages if that fails — answers built that way say
  "day-level" rather than passing themselves off as hourly.
- **Payloads are cached for 10 minutes** in the function instance. The API
  refreshes every 2 hours, so that is always fresh; it stops a conversation
  re-downloading megabytes per question.
