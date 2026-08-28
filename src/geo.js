/**
 * Turning "near me" into coordinates, and coordinates into distances.
 *
 * Claude cannot see the user's location, so "where's the best spot near me"
 * arrives as either a place name the person typed ("near Newquay", "I'm in
 * Exeter") or, occasionally, a lat/lon. Both have to work.
 *
 * Geocoding goes through Open-Meteo, which the surf API already depends on for
 * marine and weather data: free, no key, no new account, and one fewer service
 * to be down.
 */

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

const EARTH_R_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function distanceKm(lat1, lon1, lat2, lon2) {
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const COMPASS = [
	"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
	"S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** Degrees to a 16-point compass label. */
export function compassOf(deg) {
	if (deg == null || !Number.isFinite(deg)) return "";
	return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * Compass direction from the first point to the second.
 *
 * Only used to make results readable — "Watergate Bay, 6km NW" tells someone
 * far more than a bare distance does.
 */
export function bearingFrom(lat1, lon1, lat2, lon2) {
	const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
	const x =
		Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
		Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
	const deg = (Math.atan2(y, x) * 180) / Math.PI;
	return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * Resolve a place name to coordinates.
 *
 * Every spot in the dataset is in the UK, so a UK match is preferred over a
 * higher-ranked foreign one. Without that, "Newquay" is fine but "Perth",
 * "Boston" and "Newport" quietly resolve to the wrong continent and the answer
 * becomes "no spots within 50km" — which reads like missing data rather than a
 * geocoding miss.
 *
 * @returns {Promise<{name: string, latitude: number, longitude: number, country: string}>}
 * @throws {Error} when nothing matches — callers should surface this verbatim
 */
export async function geocode(place, { fetchImpl = fetch, signal } = {}) {
	const url =
		`${GEOCODE_URL}?name=${encodeURIComponent(place)}` +
		"&count=10&language=en&format=json";

	const res = await fetchImpl(url, { signal });
	if (!res.ok) {
		throw new Error(`Geocoding service returned ${res.status} for "${place}".`);
	}
	const body = await res.json();
	const results = body?.results ?? [];
	if (!results.length) {
		throw new Error(
			`Could not find a place called "${place}". Try a nearby town, ` +
				"or pass latitude and longitude directly.",
		);
	}

	const hit = results.find((r) => r.country_code === "GB") ?? results[0];
	return {
		name: [hit.name, hit.admin1].filter(Boolean).join(", "),
		latitude: hit.latitude,
		longitude: hit.longitude,
		country: hit.country ?? "",
	};
}

/**
 * Work out where the user means, from whichever of the two forms they gave.
 *
 * @param {{near?: string, latitude?: number, longitude?: number}} args
 * @returns {Promise<{name: string, latitude: number, longitude: number}>}
 */
export async function resolveLocation(args, opts = {}) {
	const { near, latitude, longitude } = args;

	if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
		return { name: near || "your location", latitude, longitude };
	}
	if (near) return geocode(near, opts);

	throw new Error(
		"No location given. Pass `near` (a town or place name) or both " +
			"`latitude` and `longitude`.",
	);
}
