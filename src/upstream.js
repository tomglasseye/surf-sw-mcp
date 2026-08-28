/**
 * Talking to the surf API.
 *
 * The connector deliberately owns no forecast logic of its own beyond the
 * beach-day score: it reads the same payload the app reads, so a spot can
 * never score one way in the app and another way here. That was the point of
 * wrapping the deployed API rather than importing its modules.
 *
 * TWO ENDPOINTS, DIFFERENT COSTS
 * ------------------------------
 *   /surf/summary  ~3MB   hourly for TODAY only; days 1-6 carry day-level
 *                         scores, a morning/afternoon snapshot and daily
 *                         min/max/avg, but `hourly: []`.
 *   /surf          ~5MB   hourly for all seven days.
 *
 * Summary answers most questions, so it is the default and the full payload is
 * only fetched when hourly detail is genuinely needed for a future day. Both
 * are served from a pre-serialised cache upstream, so the cost is transfer and
 * parse rather than computation.
 */

const DEFAULT_BASE = "https://surferdood.inpn.io";

/**
 * How long a fetched payload is reused.
 *
 * The API refreshes every two hours, so ten minutes is comfortably fresh while
 * still sparing a warm function instance from re-downloading megabytes on
 * every tool call in a conversation.
 */
const TTL_MS = 10 * 60 * 1000;

/**
 * A Netlify function is killed at 10s by default. Cut the upstream fetch off
 * before that so a slow API produces a readable error instead of an opaque
 * platform timeout.
 */
const TIMEOUT_MS = 8000;

/** endpoint -> { at, payload }. Survives across warm invocations. */
const cache = new Map();

export function baseUrl() {
	return (process.env.SURF_API_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

/** Drop cached payloads. Tests use this; nothing in production should. */
export function clearCache() {
	cache.clear();
}

async function fetchJson(path, { fetchImpl = fetch } = {}) {
	const url = `${baseUrl()}${path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	let res;
	try {
		res = await fetchImpl(url, {
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
	} catch (err) {
		if (err?.name === "AbortError") {
			throw new Error(
				`The surf API at ${baseUrl()} did not respond within ` +
					`${TIMEOUT_MS / 1000}s.`,
			);
		}
		throw new Error(`Could not reach the surf API at ${baseUrl()}: ${err.message}`);
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) {
		throw new Error(`The surf API returned ${res.status} for ${path}.`);
	}
	return res.json();
}

/**
 * Fetch (or reuse) a forecast payload.
 *
 * @param {{full?: boolean, fetchImpl?: Function, now?: number}} opts
 *   full - fetch /surf instead of /surf/summary, for hourly data beyond today
 * @returns {Promise<Object>} the parsed payload: { success, count, spots, ... }
 */
export async function getPayload({ full = false, fetchImpl, now = Date.now() } = {}) {
	const path = full ? "/surf" : "/surf/summary";

	const hit = cache.get(path);
	if (hit && now - hit.at < TTL_MS) return hit.payload;

	const payload = await fetchJson(path, { fetchImpl });
	if (!Array.isArray(payload?.spots)) {
		throw new Error(
			`The surf API returned an unexpected shape for ${path} — ` +
				"no `spots` array.",
		);
	}

	// Only ever hold one payload: the two differ by megabytes and a function
	// instance holding both for no reason is how memory limits get hit.
	cache.clear();
	cache.set(path, { at: now, payload });
	return payload;
}

/**
 * Does this day actually carry hourly records?
 *
 * The summary payload gives `hourly: []` for every day after today, and the
 * difference matters: an empty array is "ask for the full payload", not "no
 * forecast".
 */
export function hasHourly(day) {
	return Array.isArray(day?.hourly) && day.hourly.length > 0;
}

/** Find a spot's forecast day by date, or undefined. */
export function findDay(spot, date) {
	return spot?.forecast?.next_5_days?.find((d) => d.date === date);
}

const normalise = (s) =>
	String(s || "")
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

/**
 * Resolve a spot name a person typed to the spot (or spots) it could mean.
 *
 * Names in the dataset are not unique in the way people use them — "Fistral"
 * matches four separate entries, and "Towan" three. Returning the first match
 * would silently answer about the wrong break, so an ambiguous name comes back
 * as a list for the caller to put to the user.
 *
 * @returns {{match: Object|null, candidates: Object[]}}
 */
export function findSpot(payload, name) {
	const spots = payload?.spots ?? [];
	const q = normalise(name);
	if (!q) return { match: null, candidates: [] };

	const exact = spots.filter((s) => normalise(s.name) === q);
	if (exact.length === 1) return { match: exact[0], candidates: exact };
	if (exact.length > 1) return { match: null, candidates: exact };

	const starts = spots.filter((s) => normalise(s.name).startsWith(q));
	if (starts.length === 1) return { match: starts[0], candidates: starts };

	const contains = spots.filter((s) => {
		const n = normalise(s.name);
		return n.includes(q) || q.includes(n);
	});
	const pool = starts.length ? starts : contains;
	if (pool.length === 1) return { match: pool[0], candidates: pool };
	return { match: null, candidates: pool.slice(0, 12) };
}
