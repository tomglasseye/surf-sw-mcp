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
 * More importantly, every existing activity score is built from waves and wind
 * alone. For lounging, the two things that decide it are **temperature** and
 * **rain**, and neither appears anywhere in those curves. So this cannot be
 * derived from the scores already in the payload — it needs the raw hourly
 * weather, which the payload does carry.
 *
 * WHERE IT LIVES, AND WHY
 * -----------------------
 * In the connector, not the surf API. The app has no beach-day feature, so
 * there is no second engine to drift away from — the failure mode that made
 * `calculateComprehensiveSurfScore` disagree with the scorer it was supposed to
 * mirror. If the app ever grows one, this module should move into the API and
 * the connector should read the result rather than recompute it.
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
 * Gated, cold is cold, wet is wet, and a gale is a gale.
 *
 *     score = base(wind, temperature, waves)
 *             × coldGate(temp) × rainGate(rain) × galeGate(wind)
 *
 * Wind and temperature appear on both sides on purpose, exactly as wave height
 * does in the surf score: they gate at the end where nothing else can rescue
 * them, and contribute a gradient in between, so 26°C still beats 18°C and a
 * light breeze still beats a stiff one.
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

/**
 * Wind, km/h. The single biggest spoiler of a beach day and the one people
 * consistently underestimate from a forecast: below about 16km/h it is a
 * pleasant breeze, by 24 the sand is moving, past 34 nobody is enjoying it.
 */
const WIND = [[0, 100], [8, 100], [16, 80], [24, 45], [34, 10], [45, 0]];

/**
 * Air temperature, °C, calibrated for a British beach rather than a
 * Mediterranean one — 18°C in shelter is a good day here. Falls away hard
 * below 14 and eases off slightly above 30, which is uncomfortable rather
 * than bad.
 */
const TEMP = [[8, 0], [12, 25], [15, 55], [18, 80], [21, 100], [28, 100], [33, 80]];

/**
 * Wave height, m. Weighted lightly and deliberately so: big surf makes a
 * beach more dramatic, not unusable. It costs a beach day something because
 * of rips, shorebreak and spray, but it is not the deciding factor the way
 * wind and temperature are.
 */
const WAVES = [[0, 100], [0.5, 100], [1.2, 80], [2, 55], [3, 30], [4.5, 20]];

/**
 * Rain, mm in the hour. Anything steady ends the day, so this multiplies
 * rather than averages. The floor is 0.08 rather than 0 to keep a heavy-rain
 * hour rankable against another heavy-rain hour instead of flattening every
 * wet spot to an identical zero.
 */
const RAIN_GATE = [[0, 1], [0.1, 0.9], [0.5, 0.6], [1.5, 0.3], [4, 0.08]];

/**
 * Cold, °C. Below about 15 nothing else makes it a beach day — calm, flat and
 * sunny at 9°C is a coat-and-a-walk, not a towel. Opens fully by 17.
 *
 * Floors at 0.2 rather than 0 for the same reason the rain gate does: a cold
 * sheltered spot should still rank above a cold exposed one.
 */
const COLD_GATE = [[8, 0.2], [12, 0.5], [15, 0.85], [17, 1]];

/**
 * Gale, km/h. Only bites above 25 — below that the weighted wind term already
 * says everything worth saying. Past 32 the sand is airborne and the warmest
 * afternoon in the forecast will not save it.
 */
const GALE_GATE = [[0, 1], [25, 1], [32, 0.7], [40, 0.4], [55, 0.2]];

const WEIGHTS = { wind: 0.4, temperature: 0.4, waves: 0.2 };

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Score one hour, 0-100.
 *
 * Returns null when wind or temperature is missing rather than substituting a
 * default: a spot with no weather data should drop out of the ranking, not
 * quietly rank in the middle of it.
 *
 * @param {{marine?: Object, weather?: Object}} hour - a forecast hour
 * @returns {{score: number, rating: string, components: Object}|null}
 */
export function scoreBeachHour(hour) {
	const windSpeed = hour?.weather?.windSpeed;
	const temperature = hour?.weather?.temperature;
	const waveHeight = hour?.marine?.waveHeight;
	const precipitation = hour?.weather?.precipitation ?? 0;

	const wind = curve(WIND, windSpeed);
	const temp = curve(TEMP, temperature);
	if (wind == null || temp == null) return null;

	// Waves may legitimately be missing on a spot whose marine cell failed;
	// treat that as neutral rather than dropping the spot entirely, since it
	// is the least important term.
	const waves = curve(WAVES, waveHeight) ?? 70;
	const rainGate = curve(RAIN_GATE, precipitation) ?? 1;
	const coldGate = curve(COLD_GATE, temperature) ?? 1;
	const galeGate = curve(GALE_GATE, windSpeed) ?? 1;

	const base =
		wind * WEIGHTS.wind + temp * WEIGHTS.temperature + waves * WEIGHTS.waves;
	const score = clamp(base * coldGate * rainGate * galeGate);

	return {
		score,
		rating: ratingFor(score),
		components: {
			wind: Math.round(wind),
			temperature: Math.round(temp),
			waves: Math.round(waves),
			cold_gate: Number(coldGate.toFixed(2)),
			rain_gate: Number(rainGate.toFixed(2)),
			gale_gate: Number(galeGate.toFixed(2)),
			base: Math.round(base),
		},
		inputs: {
			wind_kph: windSpeed,
			temperature_c: temperature,
			wave_height_m: waveHeight,
			precipitation_mm: precipitation,
		},
	};
}

/**
 * Same score from a day's aggregates, for days beyond today.
 *
 * `/surf/summary` only carries hourly data for today; later days arrive as
 * daily min/max/avg. That is genuinely coarser — a dry morning and a wet
 * afternoon average into a mediocre middle — so results built this way are
 * labelled `day-level` in the tool output rather than passed off as hourly.
 *
 * @param {Object} day - one entry from forecast.next_5_days
 */
export function scoreBeachDay(day) {
	const windAvg = day?.summary?.windSpeed?.avg;
	const tempMax = day?.summary?.temperature?.max;
	const waveAvg = day?.summary?.waveHeight?.avg;
	// Daily precipitation is a total for 24h; spread it over the ~8 daylight
	// hours someone would actually be there rather than comparing a daily
	// total against an hourly threshold.
	const precipSum = day?.daily?.weather?.precipitationSum;
	const precipPerHour = precipSum == null ? 0 : precipSum / 8;

	return scoreBeachHour({
		marine: { waveHeight: waveAvg },
		weather: {
			windSpeed: windAvg,
			temperature: tempMax,
			precipitation: precipPerHour,
		},
	});
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

/** One-line explanation of what dominated the score. */
export function explainBeach(result) {
	if (!result) return "no weather data";
	const { components: c, inputs: i } = result;
	const bits = [];
	if (c.rain_gate < 0.7) bits.push(`rain (${i.precipitation_mm}mm)`);
	if (c.cold_gate < 0.85) bits.push(`cold (${Math.round(i.temperature_c)}°C)`);
	if (c.gale_gate < 1) bits.push(`gale (${Math.round(i.wind_kph)}km/h)`);
	else if (c.wind < 50) bits.push(`wind (${Math.round(i.wind_kph)}km/h)`);
	if (c.cold_gate >= 0.85 && c.temperature < 50) {
		bits.push(`cool (${Math.round(i.temperature_c)}°C)`);
	}
	if (c.waves < 50) bits.push(`big waves (${i.wave_height_m}m)`);
	if (!bits.length) {
		return `${Math.round(i.temperature_c)}°C, wind ${Math.round(i.wind_kph)}km/h`;
	}
	return `held back by ${bits.join(", ")}`;
}
