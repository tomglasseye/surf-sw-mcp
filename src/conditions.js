/**
 * Words for a surf score: what limited it, as the app and the API say it.
 *
 * Mirrors `shared/wind.js` and `shared/conditions-text.js` in the app
 * (surf-southwest), which mirror `src/services/business/surf-advice.js` in the
 * API. Copied rather than imported because the three deploy separately; keep
 * them in step.
 *
 * WHY
 * ---
 * Rows used to read "2.4m @10s W · wind 30km/h WSW": the open-sea height
 * every spot in a model cell shares, and a compass wind with nothing to say
 * whether it was offshore. Since scoring model v2 each forecast hour carries
 * the face height at the break (`surf_score.face`), the wind relative to the
 * beach (`surf_score.wind`) and what limited each skill (`surf_score.limit`),
 * so the connector can say what a surfer would: "Blown out — 30 km/h
 * cross-onshore, gusting 49", "Above your level — 6–8ft faces".
 */

export const SKILL_INDEX = { beginner: 0, intermediate: 1, advanced: 2 };

const FACE_BEARINGS = {
	N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
	S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

const norm = (d) => ((d % 360) + 360) % 360;
const angDiff = (a, b) => {
	const d = Math.abs(norm(a - b));
	return d > 180 ? 360 - d : d;
};

// ── Wind relative to the beach ────────────────────────────────────────────

/** The bearing the beach looks out to sea, or null. */
export function shoreNormal(spot) {
	if (Number.isFinite(spot?.shoreNormal)) return norm(spot.shoreNormal);
	const r = spot?.optimalWindDir;
	if (Array.isArray(r) && r.length === 2 && r.every(Number.isFinite)) {
		return norm(r[0] + norm(r[1] - r[0]) / 2 + 180);
	}
	const f = FACE_BEARINGS[String(spot?.faces || "").toUpperCase()];
	return f === undefined ? null : f;
}

/** Share of the wind a headland lets through from this direction (0-1). */
export function shelterFactor(spot, dir) {
	if (!Array.isArray(spot?.windShelter) || !Number.isFinite(dir)) return 1;
	let f = 1;
	for (const s of spot.windShelter) {
		const a = norm(s.from);
		const b = norm(s.to);
		const d = norm(dir);
		const inside = a <= b ? d >= a && d <= b : d >= a || d <= b;
		if (inside && Number.isFinite(s.factor)) f = Math.min(f, Math.max(0, Math.min(1, s.factor)));
	}
	return f;
}

export const WIND_TYPES = ["glassy", "offshore", "cross-off", "cross", "cross-on", "onshore"];

/** The API's thresholds, measured from dead offshore. */
export function classifyWind(spot, windDir, windKmh) {
	const felt = Number.isFinite(windKmh) ? windKmh * shelterFactor(spot, windDir) : null;
	if (felt != null && felt < 5) return "glassy";
	const n = shoreNormal(spot);
	if (n == null || !Number.isFinite(windDir)) return "cross";
	const theta = angDiff(windDir, norm(n + 180));
	if (theta <= 30) return "offshore";
	if (theta <= 70) return "cross-off";
	if (theta <= 110) return "cross";
	if (theta <= 150) return "cross-on";
	return "onshore";
}

/** The wind as the break feels it this hour. */
export function hourWind(spot, hour) {
	const w = hour?.weather ?? {};
	const shelter = Number.isFinite(w.windDirection) ? shelterFactor(spot, w.windDirection) : 1;
	const api = hour?.surf_score?.wind;
	return {
		type: WIND_TYPES.includes(api) ? api : classifyWind(spot, w.windDirection, w.windSpeed),
		felt: Number.isFinite(w.windSpeed) ? w.windSpeed * shelter : null,
		gust: Number.isFinite(w.windGusts) ? w.windGusts * shelter : null,
		shelter,
	};
}

// ── Words ─────────────────────────────────────────────────────────────────

export function ratingOf(score) {
	if (score >= 80) return "EPIC";
	if (score >= 60) return "GOOD";
	if (score >= 40) return "FAIR";
	if (score >= 20) return "POOR";
	return "FLAT";
}

/** "3–4ft" from a face height in metres. */
export function sizeText(face) {
	if (!Number.isFinite(face) || face <= 0) return "flat";
	const ft = face * 3.28084;
	if (ft < 1) return "under 1ft";
	const lo = Math.max(1, Math.round(ft * 0.75));
	const hi = Math.max(lo + 1, Math.round(ft));
	return `${lo}–${hi}ft`;
}

const TYPE_WORDS = {
	offshore: "offshore",
	"cross-off": "cross-offshore",
	cross: "cross-shore",
	"cross-on": "cross-onshore",
	onshore: "onshore",
};
const LIGHT_UP_TO = { offshore: 20, "cross-off": 15, cross: 10, "cross-on": 10, onshore: 8 };

export function windText(wind) {
	if (!wind || !Number.isFinite(wind.felt)) return "wind unknown";
	if (wind.type === "glassy") return "glassy";
	const words = TYPE_WORDS[wind.type] || "cross-shore";
	const kmh = Math.round(wind.felt);
	let text;
	if (kmh <= (LIGHT_UP_TO[wind.type] ?? 10)) text = `light ${words}`;
	else if (wind.type === "offshore" && kmh > 30) text = `strong offshore (${kmh} km/h)`;
	else text = `${kmh} km/h ${words}`;
	const shelter = Number.isFinite(wind.shelter) ? wind.shelter : 1;
	if (shelter > 0 && shelter < 1) {
		const raw = Math.round(wind.felt / shelter);
		if (raw - kmh >= 3) text += ` (sheltered from ${raw})`;
	}
	const gust = Number.isFinite(wind.gust) ? Math.round(wind.gust) : null;
	if (gust != null && gust >= 40 && gust >= wind.felt * 1.4) text += `, gusting ${gust}`;
	return text;
}

/** Light enough, and off the land enough, to call the surface clean. */
export function cleanWind(wind) {
	if (!wind) return false;
	if (wind.type === "glassy") return true;
	return (wind.type === "offshore" || wind.type === "cross-off") && Number.isFinite(wind.felt) && wind.felt <= 20;
}

export function blownOut(wind) {
	if (!wind || !Number.isFinite(wind.felt)) return false;
	if (wind.felt >= 35) return true;
	return (wind.type === "onshore" || wind.type === "cross-on" || wind.type === "cross") && wind.felt >= 18;
}

const TIDE_WORDS = {
	low: "low tide",
	mid_to_low: "low-to-mid tide",
	low_to_mid: "low-to-mid tide",
	mid: "mid tide",
	mid_to_high: "mid-to-high tide",
	high: "high tide",
	all: "any tide",
};
export const tideText = (state) => (state && TIDE_WORDS[String(state).toLowerCase().replace(/[\s-]+/g, "_")]) || "";

/** One or two words for the label. */
export function labelFor(rating, limit, wind = null) {
	if (limit === "wind" && rating !== "EPIC" && rating !== "GOOD") {
		return blownOut(wind) ? "Blown out" : "Bumpy";
	}
	if (rating === "EPIC") {
		if (limit === "big") return "Too big";
		if (limit === "spot") return "Not for you";
		return "Firing";
	}
	if (rating === "GOOD") {
		if (!limit) return "Clean";
		if (limit === "small") return cleanWind(wind) ? "Small but clean" : "Small";
		return "Good";
	}
	if (rating === "FAIR") {
		const fair = { small: "Small", big: "Big", tide: "Wrong tide", period: "Weak", max: "Maxed out", spot: "Not for you" };
		return (limit && fair[limit]) || "Fair";
	}
	const poor = {
		big: "Too big", max: "Maxed out", small: "Tiny", flat: "Flat",
		tide: "Wrong tide", period: "Weak", spot: "Not for you", dir: "Wrong swell",
	};
	if (rating === "POOR") return (limit && poor[limit]) || "Poor";
	return (limit && poor[limit]) || (limit ? "Poor" : "Flat");
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** One sentence for the hour, built from what limited it. */
export function headlineFor(c, spot) {
	const size = sizeText(c.face);
	const wind = windText(c.wind);
	const tideSensitive = (spot?.bestTide || "all") !== "all";
	const tide = tideSensitive ? tideText(c.tideState) : "";
	switch (c.limit) {
		case null:
		case undefined:
			return `${cap(size)}, ${wind}${tide ? `, ${tide}` : ""}.`;
		case "flat":
			return "Flat — too small to break here.";
		case "small":
			return cleanWind(c.wind)
				? `Small but clean — ${size}, ${wind}.`
				: `Small — ${size}, ${wind}.`;
		case "big":
			return `Above your level — ${size} faces.`;
		case "max":
			return `Maxed out — ${size} and closing out.`;
		case "wind":
			if (blownOut(c.wind)) return `Blown out — ${wind}.`;
			// Still a good hour; the wind is just what keeps it from better.
			return c.rating === "GOOD" || c.rating === "EPIC"
				? `${cap(size)}, ${wind} — a bit bumpy.`
				: `Bumpy — ${wind}, ${size}.`;
		case "tide": {
			const best = tideText(spot?.bestTide) || "another tide";
			const now = tideText(c.tideState);
			return `Wrong tide — works best at ${best}${now ? `, now ${now}` : ""}.`;
		}
		case "period": {
			const t = Number.isFinite(c.peakPeriod) ? `${Math.round(c.peakPeriod)}s` : "short";
			return `Weak, short-period swell (${t}) — ${size}.`;
		}
		case "dir":
			return `Wrong swell direction for this break — ${size}.`;
		case "spot":
			return "An advanced break — rocks, currents and a heavy take-off. Not one for your level.";
		default:
			return `${cap(size)}, ${wind}.`;
	}
}

/** What limited this skill in this hour, or null. */
export function hourLimit(hour, skill) {
	const l = hour?.surf_score?.limit;
	if (!Array.isArray(l)) return null;
	return l[SKILL_INDEX[skill] ?? 1] ?? null;
}

/** The sentence without repeating the label in front of it. */
export function withoutLabel(label, headline) {
	if (!label || !headline) return headline;
	const prefix = `${label.toLowerCase()} — `;
	if (!headline.toLowerCase().startsWith(prefix)) return headline;
	const rest = headline.slice(prefix.length);
	return rest ? cap(rest) : headline;
}

/** Peak period when the payload has it; surfers quote peak, not mean. */
export function peakPeriodOf(hour) {
	const m = hour?.marine ?? {};
	if (Number.isFinite(m.swellPeakPeriod)) return m.swellPeakPeriod;
	return Number.isFinite(m.swellPeriod) ? m.swellPeriod : null;
}

/**
 * Score, label and sentence for one hour and one surfer.
 * @returns {{score: number, rating: string, limit: string|null, face: number|null, label: string, headline: string}}
 */
export function describeHour(hour, spot, skill) {
	const s = hour?.surf_score;
	const score = Math.round(s?.scoresBySkill?.[skill] ?? s?.totalScore ?? 0);
	const rating = ratingOf(score);
	const limit = hourLimit(hour, skill);
	const wind = hourWind(spot, hour);
	const m = hour?.marine ?? {};
	const face = Number.isFinite(s?.face) ? s.face : null;
	// A pre-v2 payload has no face height: describe the open-sea height
	// rather than calling it flat.
	const sizeFor = face ?? (Number.isFinite(m.waveHeight) ? m.waveHeight : null);
	const label = labelFor(rating, limit, wind);
	return {
		score,
		rating,
		limit,
		face,
		label,
		headline: headlineFor({ face: sizeFor, wind, limit, peakPeriod: peakPeriodOf(hour), rating }, spot),
	};
}
