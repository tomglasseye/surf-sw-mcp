/**
 * How good is this hour for *being on the beach* — not for surfing it.
 *
 * WHY THIS IS A SEPARATE SCORE
 * ----------------------------
 * The surf API already scores hours for surfing, and for swimming, SUP, a
 * family splash and kiting (`good-for.js`). None of those answer "is it a nice
 * day to sit on the beach", and several of them invert it: a clean 2m swell
 * with an offshore wind is a brilliant surf score and a mediocre beach day.
 *
 * Two things decide a beach day that appear in none of those scores —
 * **temperature and rain** — because every one of them is built from waves and
 * wind alone. So this cannot be derived from the scores already in the payload.
 *
 * WHY IT IS SPOT-SPECIFIC, WHICH `good-for.js` IS NOT
 * --------------------------------------------------
 * `good-for.js` reads `hour.marine.waveHeight` straight from the payload, and
 * that number comes from the marine model's grid cell — which 21 Newquay
 * breaks share, byte for byte. Measured on real data, six Newquay spots on the
 * same afternoon:
 *
 *     spot            waveHeight  exposure   swim  splash
 *     Towan                 0.56      0.08     79      57
 *     Watergate Bay         0.56      1.00     77      56
 *     Crantock              0.56      0.42     79      58
 *     The Cribber           0.56      1.00     79      57
 *
 * Identical swim and splash scores across a twelve-fold difference in how
 * exposed those beaches are. On a flat day that hardly matters. On a 2.5m day
 * it matters enormously: Towan stays knee-high while Watergate is well
 * overhead, and a score that cannot tell them apart will happily send a family
 * with small children to the wrong one.
 *
 * The swell window fixes exactly this, and it is already in the payload. So
 * this score works from an EFFECTIVE wave height at the spot, not the grid
 * cell's, and from an effective wind that accounts for which way the beach
 * faces.
 *
 * SHAPE
 * -----
 * A beach day is a conjunction, not an average. Cold, rain and a gale each end
 * one on their own, whatever the other two are doing — so each gets a
 * multiplicative gate, matching the surfability gate in `surf-score.js`.
 *
 * Weighting them instead does not work, and both ends proved it. A 9°C,
 * dead-calm, flat day scored 63/100 — "good" — because calm and flat are 60%
 * of the weight between them and a temperature term can only pull down its own
 * 40%. A 24°C day in a 35km/h gale scored 64 for the mirror-image reason.
 *
 *     score = base(wind, temperature, waves)
 *             × coldGate(temp) × rainGate(rain) × galeGate(wind)
 *
 * Wind and temperature appear on both sides on purpose, exactly as wave height
 * does in the surf score: they gate at the end where nothing else can rescue
 * them, and contribute a gradient in between.
 */

/** Piecewise-linear interpolation over [input, output] points. */
function curve(points, x) {
	if (x == null || !Number.isFinite(x)) return null;
	if (x <= points[0][0]) return points[0][1];
	for (let i = 1; i < points.length; i++) {
		const [x0, y0] = points[i - 1];
		const [x1, y1] = points[i];
		if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
	}
	return points[points.length - 1][1];
}

const WIND = [[0, 100], [8, 100], [16, 80], [24, 45], [34, 10], [45, 0]];
const TEMP = [[8, 0], [12, 25], [15, 55], [18, 80], [21, 100], [28, 100], [33, 80]];
const RAIN_GATE = [[0, 1], [0.1, 0.9], [0.5, 0.6], [1.5, 0.3], [4, 0.08]];
const COLD_GATE = [[8, 0.2], [12, 0.5], [15, 0.85], [17, 1]];
const GALE_GATE = [[0, 1], [25, 1], [32, 0.7], [40, 0.4], [55, 0.2]];

/**
 * Cloud cover, percent. 0 is a clear sky, 100 is overcast.
 *
 * Deliberately NOT a gate. Cold, rain and a gale each end a beach day on their
 * own; grey does not — a warm, calm, overcast afternoon on the sand is still a
 * perfectly good one, just not as good. So this is weighted, and gently.
 *
 * The curve is flat to 20% because a few clouds are nobody's problem, and
 * floors at 35 rather than 0 because even under full overcast the difference
 * between a warm sheltered beach and a cold windy one is what the rest of the
 * score is for.
 */
const SUN = [[0, 100], [20, 100], [50, 80], [80, 50], [100, 35]];

/**
 * Who the beach day is for.
 *
 * "A nice beach" is not one question. Sitting on the sand with a book barely
 * cares about a 2.5m swell — it is something to watch. Taking a five-year-old
 * into the water, that same swell is the entire answer and nothing else about
 * the day matters.
 *
 * Scored with one weighting, those collapse: on real Newquay data a 2.5m day
 * put Watergate Bay at 79/100 — "great" — because warmth and light wind carry
 * 80% of the weight between them. Correct for a deckchair, dangerous advice
 * for a family.
 *
 * So the wave term changes shape with the audience, and for the two water
 * audiences it also gates: past a certain size, big surf ends the outing
 * whatever the weather is doing. Same logic as cold, rain and gale.
 *
 * The wave curves follow the ones already in the surf API's `good-for.js`, so
 * "too big for kids" means the same thing in the app and here.
 */
const PROFILES = {
	sitting: {
		// How much of the score sun is worth, taken off the other three
		// proportionally. Highest for sitting — that is most of why anyone sits
		// on a beach — and lower once you are in the water and moving.
		sun: 0.18,
		label: "sitting on the beach",
		weights: { wind: 0.4, temperature: 0.4, waves: 0.2 },
		waves: [[0, 100], [0.5, 100], [1.2, 80], [2, 55], [3, 30], [4.5, 20]],
		waveGate: null,
	},
	swimming: {
		// How much of the score sun is worth, taken off the other three
		// proportionally. Highest for sitting — that is most of why anyone sits
		// on a beach — and lower once you are in the water and moving.
		sun: 0.12,
		label: "swimming",
		weights: { wind: 0.3, temperature: 0.35, waves: 0.35 },
		waves: [[0, 100], [0.7, 100], [1.2, 80], [1.8, 45], [2.4, 15], [3.5, 0]],
		waveGate: [[0, 1], [1.5, 1], [2.2, 0.6], [3, 0.3], [4, 0.15]],
	},
	kids: {
		// How much of the score sun is worth, taken off the other three
		// proportionally. Highest for sitting — that is most of why anyone sits
		// on a beach — and lower once you are in the water and moving.
		sun: 0.1,
		label: "small children in the water",
		weights: { wind: 0.25, temperature: 0.3, waves: 0.45 },
		waves: [[0, 100], [0.3, 100], [0.6, 70], [1, 25], [1.4, 5], [2, 0]],
		waveGate: [[0, 1], [0.8, 1], [1.2, 0.6], [1.8, 0.25], [2.5, 0.1]],
	},
};

export const AUDIENCES = Object.keys(PROFILES);

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

// ── Shelter ───────────────────────────────────────────────────────────────

const FACE_BEARINGS = {
	N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
	S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

/**
 * How open this spot is to swell arriving from `direction`.
 *
 * Returns 1 when the spot has no window, which is what makes wiring this in
 * safe: a spot without the data scores exactly as it did before rather than
 * being wrongly penalised.
 */
export function exposureAt(swellWindow, direction) {
	if (!Array.isArray(swellWindow) || !swellWindow.length) return 1;
	if (direction == null || !Number.isFinite(direction)) return 1;
	const step = 360 / swellWindow.length;
	const i = Math.round((((direction % 360) + 360) % 360) / step) % swellWindow.length;
	return swellWindow[i] ?? 1;
}

/**
 * Wave height actually arriving at this beach, not at the grid cell.
 *
 * Exposure is a fraction of the incident swell energy, and wave height goes as
 * the square root of energy — so a beach open to 8% of the arriving swell sees
 * roughly 28% of the height, not 8% of it. Multiplying the height directly
 * would put Towan at 0.2m in a 2.5m swell, which is far too flattering; the
 * square root puts it at 0.7m, which is about right for a beach that stays
 * knee-high when Fistral is overhead.
 */
export function effectiveWaveHeight(waveHeight, exposure) {
	if (waveHeight == null || !Number.isFinite(waveHeight)) return waveHeight;
	return waveHeight * Math.sqrt(Math.max(0, Math.min(1, exposure)));
}

/**
 * How much of the wind you actually feel sitting on this beach.
 *
 * Meteorological wind direction is where the wind comes FROM, and `faces` is
 * where the beach looks out TO. So a wind from the same bearing the beach
 * faces is blowing in off the sea and hits you with nothing in the way; a wind
 * from the opposite bearing has crossed the land, cliffs or dunes behind the
 * beach first, and arrives noticeably weaker at the sand.
 *
 * This is the same fact the surf score uses and reads backwards: an offshore
 * wind is what a surfer wants because it grooms the waves, and it is also what
 * makes a beach comfortable to sit on. The two agree here and disagree almost
 * everywhere else.
 *
 * The 0.6 floor is an approximation — a cliff-backed cove in an offshore is
 * nearly still, an open dune system much less so, and the payload does not say
 * which is which.
 */
export function windShelter(windDirection, faces) {
	const bearing = FACE_BEARINGS[String(faces || "").toUpperCase()];
	if (bearing === undefined || windDirection == null || !Number.isFinite(windDirection)) {
		return 1;
	}
	const theta = (((windDirection - bearing) % 360) + 360) % 360;
	// 0 = straight onshore, 180 = straight offshore.
	const offshoreness = (1 - Math.cos((theta * Math.PI) / 180)) / 2;
	return 1 - 0.4 * offshoreness;
}

// ── Scoring ───────────────────────────────────────────────────────────────

function score({
	windSpeed, temperature, waveHeight, precipitation, cloudCover,
	shelter, exposure, audience,
}) {
	const profile = PROFILES[audience] ?? PROFILES.sitting;

	const wind = curve(WIND, windSpeed);
	const temp = curve(TEMP, temperature);
	if (wind == null || temp == null) return null;

	const waves = curve(profile.waves, waveHeight) ?? 70;
	const rainGate = curve(RAIN_GATE, precipitation) ?? 1;
	const coldGate = curve(COLD_GATE, temperature) ?? 1;
	const galeGate = curve(GALE_GATE, windSpeed) ?? 1;
	const waveGate = profile.waveGate
		? (curve(profile.waveGate, waveHeight) ?? 1)
		: 1;

	const w = profile.weights;
	const base = wind * w.wind + temp * w.temperature + waves * w.waves;

	// Sun is blended in by taking its weight off the other three
	// proportionally, so a payload without cloudCover scores EXACTLY as it did
	// before rather than approximately. That matters: the API does not serve
	// the field yet, and a connector that quietly re-scored all 125 spots the
	// day it shipped would be indistinguishable from a bug.
	//
	// Same safe-wiring rule as exposureAt returning 1 for a spot with no swell
	// window — absent data must cost nothing.
	const sun = curve(SUN, cloudCover);
	const withSun =
		sun == null ? base : base * (1 - profile.sun) + sun * profile.sun;

	const total = clamp(withSun * coldGate * rainGate * galeGate * waveGate);

	return {
		score: total,
		rating: ratingFor(total),
		audience: audience in PROFILES ? audience : "sitting",
		components: {
			wind: Math.round(wind),
			temperature: Math.round(temp),
			waves: Math.round(waves),
			sun: sun == null ? null : Math.round(sun),
			cold_gate: Number(coldGate.toFixed(2)),
			rain_gate: Number(rainGate.toFixed(2)),
			gale_gate: Number(galeGate.toFixed(2)),
			wave_gate: Number(waveGate.toFixed(2)),
			wind_shelter: Number(shelter.toFixed(2)),
			swell_exposure: Number(exposure.toFixed(2)),
			base: Math.round(base),
		},
	};
}

/**
 * Score one hour at one spot, 0-100.
 *
 * `spot` is needed, not optional decoration: without it this falls back to the
 * grid-cell wave height and cannot tell a sheltered cove from an exposed
 * beach. It still works — that is the safe-wiring rule — but it answers a
 * blunter question.
 *
 * Returns null when wind or temperature is missing rather than substituting a
 * default: a spot with no weather data should drop out of the ranking, not
 * quietly rank in the middle of it.
 */
export function scoreBeachHour(hour, spot, audience = "sitting") {
	const windSpeedRaw = hour?.weather?.windSpeed;
	const temperature = hour?.weather?.temperature;
	const precipitation = hour?.weather?.precipitation ?? 0;

	const exposure = exposureAt(spot?.swellWindow, hour?.marine?.swellDirection);
	const shelter = windShelter(hour?.weather?.windDirection, spot?.faces);

	const result = score({
		windSpeed: windSpeedRaw == null ? null : windSpeedRaw * shelter,
		temperature,
		waveHeight: effectiveWaveHeight(hour?.marine?.waveHeight, exposure),
		precipitation,
		cloudCover: hour?.weather?.cloudCover,
		shelter,
		exposure,
		audience,
	});
	if (!result) return null;

	result.inputs = {
		wind_kph: windSpeedRaw,
		felt_wind_kph: windSpeedRaw == null ? null : windSpeedRaw * shelter,
		temperature_c: temperature,
		wave_height_m: hour?.marine?.waveHeight,
		effective_wave_height_m: effectiveWaveHeight(hour?.marine?.waveHeight, exposure),
		precipitation_mm: precipitation,
		cloud_cover_pct: hour?.weather?.cloudCover ?? null,
	};
	return result;
}

/**
 * Same score from a day's aggregates, for days beyond today.
 *
 * `/surf/summary` only carries hourly records for today; later days arrive as
 * daily min/max/avg plus a dominant swell and wind direction, which is enough
 * to apply the same shelter. It is still genuinely coarser — a dry morning and
 * a wet afternoon average into a mediocre middle — so results built this way
 * are labelled `day-level` rather than passed off as hourly.
 */
export function scoreBeachDay(day, spot, audience = "sitting") {
	const windAvg = day?.summary?.windSpeed?.avg;
	const tempMax = day?.summary?.temperature?.max;
	const waveAvg = day?.summary?.waveHeight?.avg;

	// Daily precipitation is a total for 24h; spread it over the ~8 daylight
	// hours someone would actually be there rather than comparing a daily
	// total against an hourly threshold.
	const precipSum = day?.daily?.weather?.precipitationSum;
	const precipPerHour = precipSum == null ? 0 : precipSum / 8;

	const exposure = exposureAt(
		spot?.swellWindow,
		day?.daily?.marine?.waveDirectionDominant,
	);
	const shelter = windShelter(
		day?.daily?.weather?.windDirectionDominant,
		spot?.faces,
	);

	const result = score({
		windSpeed: windAvg == null ? null : windAvg * shelter,
		temperature: tempMax,
		waveHeight: effectiveWaveHeight(waveAvg, exposure),
		precipitation: precipPerHour,
		cloudCover: day?.daily?.weather?.cloudCoverMean,
		shelter,
		exposure,
		audience,
	});
	if (!result) return null;

	result.inputs = {
		wind_kph: windAvg,
		felt_wind_kph: windAvg == null ? null : windAvg * shelter,
		temperature_c: tempMax,
		wave_height_m: waveAvg,
		effective_wave_height_m: effectiveWaveHeight(waveAvg, exposure),
		precipitation_mm: precipPerHour,
		cloud_cover_pct: day?.daily?.weather?.cloudCoverMean ?? null,
	};
	return result;
}

/**
 * Bucket a score into words. Same thresholds as `ratingFromScore` in the surf
 * API's `good-for.js`, so "great" means the same thing in the app and here.
 */
export function ratingFor(score) {
	if (score >= 75) return "great";
	if (score >= 55) return "good";
	if (score >= 40) return "fair";
	if (score >= 20) return "poor";
	return "no";
}

/** One-line explanation of what decided the score. */
export function explainBeach(result) {
	if (!result) return "no weather data";
	const { components: c, inputs: i } = result;

	const bits = [];
	if (c.rain_gate < 0.7) bits.push(`rain (${Number(i.precipitation_mm).toFixed(1)}mm)`);
	if (c.cold_gate < 0.85) bits.push(`cold (${Math.round(i.temperature_c)}°C)`);
	if (c.gale_gate < 1) bits.push(`gale (${Math.round(i.felt_wind_kph)}km/h)`);
	else if (c.wind < 50) bits.push(`wind (${Math.round(i.felt_wind_kph)}km/h)`);
	if (c.cold_gate >= 0.85 && c.temperature < 50) {
		bits.push(`cool (${Math.round(i.temperature_c)}°C)`);
	}
	if (c.sun != null && c.sun < 65) bits.push(`grey (${Math.round(i.cloud_cover_pct)}% cloud)`);
	if (c.wave_gate < 1) {
		bits.push(`too big (${Number(i.effective_wave_height_m).toFixed(1)}m)`);
	} else if (c.waves < 50) {
		bits.push(`waves (${Number(i.effective_wave_height_m).toFixed(1)}m)`);
	}

	// Shelter is the reason one beach beats its neighbour in the same grid
	// cell, so say so when it is doing real work.
	const shelters = [];
	if (c.swell_exposure < 0.5) {
		shelters.push(
			`sheltered from the swell (${Number(i.wave_height_m).toFixed(1)}m out, ` +
				`${Number(i.effective_wave_height_m).toFixed(1)}m here)`,
		);
	}
	if (c.wind_shelter < 0.8) shelters.push("wind blowing off the land");

	if (!bits.length && !shelters.length) {
		const sunny =
			c.sun != null && c.sun >= 95 ? ", clear" : c.sun != null ? "" : "";
		return (
			`${Math.round(i.temperature_c)}°C, wind ` +
			`${Math.round(i.felt_wind_kph)}km/h${sunny}`
		);
	}
	return [
		bits.length ? `held back by ${bits.join(", ")}` : null,
		shelters.length ? shelters.join(", ") : null,
	]
		.filter(Boolean)
		.join(" · ");
}
