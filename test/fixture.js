/**
 * A synthetic surf payload, shaped exactly like the real one.
 *
 * Field names and nesting were taken from a live payload capture rather than
 * from the API source, because the connector consumes JSON over HTTP and it is
 * the serialised shape that has to be right. Anything that drifts here should
 * be caught by a real call in the deploy check, not papered over.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const iso = (d) => d.toISOString().slice(0, 10);

/** Build one forecast hour. */
export function hour(date, h, { wave = 1.0, wind = 12, temp = 18, rain = 0, surf = 50 } = {}) {
	return {
		time: `${date}T${String(h).padStart(2, "0")}:00`,
		marine: {
			waveHeight: wave,
			waveDirection: 290,
			wavePeriod: 8,
			swellHeight: wave * 0.8,
			swellDirection: 285,
			swellPeriod: 10,
		},
		weather: {
			temperature: temp,
			humidity: 70,
			precipitation: rain,
			pressure: 1015,
			windSpeed: wind,
			windDirection: 135,
			windGusts: wind * 1.6,
		},
		surf_score: {
			totalScore: surf,
			scoresBySkill: { beginner: surf, intermediate: surf, advanced: surf },
			breakdown: { waveHeightCategory: "small" },
		},
	};
}

/** Build a day. `hourly: false` mimics the summary payload's future days. */
export function day(date, opts = {}, { withHourly = true } = {}) {
	const hours = withHourly
		? Array.from({ length: 24 }, (_, h) => hour(date, h, opts))
		: [];
	return {
		date,
		hourly: hours,
		summary: {
			waveHeight: { min: opts.wave ?? 1, max: opts.wave ?? 1, avg: opts.wave ?? 1 },
			windSpeed: { min: opts.wind ?? 12, max: opts.wind ?? 12, avg: opts.wind ?? 12 },
			temperature: { min: (opts.temp ?? 18) - 3, max: opts.temp ?? 18 },
		},
		daily: {
			// The dominant directions are what the day-level path uses to apply
			// swell and wind shelter, so a fixture without them silently tests
			// the unsheltered fallback instead.
			marine: { waveHeightMax: opts.wave ?? 1, waveDirectionDominant: 285 },
			weather: {
				temperatureMax: opts.temp ?? 18,
				temperatureMin: (opts.temp ?? 18) - 3,
				precipitationSum: (opts.rain ?? 0) * 8,
				windSpeedMax: opts.wind ?? 12,
				windDirectionDominant: 135,
			},
		},
		surf_score: {
			totalScore: opts.surf ?? 50,
			scoresBySkill: {
				beginner: opts.surf ?? 50,
				intermediate: opts.surf ?? 50,
				advanced: opts.surf ?? 50,
			},
			breakdown: { windQuality: 80, swellDirection: 100, swellPeriod: 40 },
		},
		best_hour: "09:00",
		day_snapshot: {
			segments: {
				morning: { window: "06–12", scores: { surf: 25, swim: 80 }, best: "swim", rating: "great" },
			},
			best_for: ["swim"],
			headline: "Great for swimming today.",
		},
	};
}

export function spot(name, latitude, longitude, region, days, opts = {}) {
	return {
		name,
		latitude,
		longitude,
		region,
		skillLevel: "Intermediate",
		faces: opts.faces ?? "W",
		breakType: "beach",
		bestTide: "mid",
		optimalSwellDir: [270, 315],
		optimalWindDir: [90, 180],
		swellWindow: Array.from({ length: 36 }, () => opts.exposure ?? 0.5),
		scoring: { max_score: 10, overall_score: 5 },
		forecast: { generated_at: new Date().toISOString(), next_5_days: days },
		tides: { today: [{ type: "high", time: `${days[0].date}T07:30` }] },
	};
}

/**
 * A payload with three spots at known distances from Newquay (50.415, -5.078):
 *   Close Beach   ~2km   great surf, unpleasant beach (cold, windy, big)
 *   Warm Cove     ~8km   poor surf, lovely beach     (warm, calm, small)
 *   Far Point     ~90km  great everything, but out of a default radius
 *
 * Built so surf ranking and beach ranking MUST disagree — if a change makes
 * them agree, the beach score has stopped being its own thing.
 */
export function payload({ withHourly = true, today = iso(new Date()) } = {}) {
	const tomorrow = iso(new Date(Date.parse(`${today}T12:00:00Z`) + DAY_MS));

	const mk = (opts) => [
		day(today, opts, { withHourly: true }),
		day(tomorrow, opts, { withHourly }),
	];

	return {
		success: true,
		count: 3,
		generated_at: `${today}T06:00:00.000Z`,
		status: "ok",
		spots: [
			spot("Close Beach", 50.43, -5.09, "North Cornwall",
				mk({ wave: 2.4, wind: 30, temp: 11, rain: 0, surf: 82 })),
			spot("Warm Cove", 50.36, -5.05, "North Cornwall",
				mk({ wave: 0.3, wind: 6, temp: 24, rain: 0, surf: 12 })),
			spot("Far Point", 51.2, -4.2, "North Devon",
				mk({ wave: 1.5, wind: 8, temp: 23, rain: 0, surf: 90 })),
		],
	};
}

/** A fetch stand-in that serves the fixture and records what was asked for. */
export function stubFetch(body = payload(), { geocode = null } = {}) {
	const calls = [];
	const impl = async (url) => {
		calls.push(String(url));
		if (String(url).includes("geocoding-api")) {
			return {
				ok: true,
				status: 200,
				json: async () =>
					geocode ?? {
						results: [
							{
								name: "Newquay",
								admin1: "England",
								latitude: 50.415,
								longitude: -5.078,
								country: "United Kingdom",
								country_code: "GB",
							},
						],
					},
			};
		}
		return { ok: true, status: 200, json: async () => body };
	};
	impl.calls = calls;
	return impl;
}

/**
 * Two spots sharing one marine grid cell — identical waves, wind and air —
 * that differ only in how exposed they are to the swell.
 *
 * This is the Newquay case from real data: Towan and Watergate Bay report the
 * same 0.56m because the marine model has one cell for both, while their swell
 * windows read 0.08 and 1.00. Any beach score that cannot separate these two
 * is reading the grid cell, not the beach.
 */
export function sameCellPayload({ today = iso(new Date()), wave = 2.5 } = {}) {
	const opts = { wave, wind: 14, temp: 22, rain: 0, surf: 60 };
	return {
		success: true,
		count: 2,
		generated_at: `${today}T06:00:00.000Z`,
		status: "ok",
		spots: [
			spot("Sheltered Cove", 50.41, -5.08, "North Cornwall",
				[day(today, opts)], { exposure: 0.08 }),
			spot("Exposed Beach", 50.42, -5.09, "North Cornwall",
				[day(today, opts)], { exposure: 1.0 }),
		],
	};
}

/**
 * The Falmouth case, reproduced: a good spot on the doorstep and a better one
 * a long drive away.
 *
 * Measured from the real thing — asked for a beach near Falmouth, the
 * connector returned Newquay Town Beach (93, 29km) above Gyllyngvase (79,
 * 1km). Both scores were right and the ordering was useless.
 *
 * Distances are from Newquay (50.415,-5.078), which is what stubFetch
 * geocodes to.
 */
export function travelPayload({ today = iso(new Date()) } = {}) {
	return {
		success: true,
		count: 2,
		generated_at: `${today}T06:00:00.000Z`,
		status: "ok",
		spots: [
			// ~1km away, good.
			spot("Near Cove", 50.424, -5.078, "North Cornwall",
				[day(today, { wave: 0.5, wind: 14, temp: 20, rain: 0, surf: 60 })],
				{ exposure: 1 }),
			// ~29km away, better on both counts.
			spot("Far Beach", 50.676, -5.078, "North Cornwall",
				[day(today, { wave: 0.3, wind: 5, temp: 24, rain: 0, surf: 85 })],
				{ exposure: 1 }),
		],
	};
}

// ── Scoring model v2 ─────────────────────────────────────────────────────

/**
 * One v2 forecast hour: the trimmed surf_score the API serves since model v2
 * (face height at the break, wind relative to the beach, and what limited
 * each skill, in skill order beginner/intermediate/advanced).
 */
export function hourV2(date, h, {
	scores = [60, 60, 60],
	limit = [null, null, null],
	face = 1.2,
	wind = "offshore",
	windSpeed = 10,
	windDirection = 105,
	gust = 16,
	swell = 1.1,
	period = 12,
} = {}) {
	return {
		time: `${date}T${String(h).padStart(2, "0")}:00`,
		marine: {
			waveHeight: swell * 1.1,
			waveDirection: 285,
			wavePeriod: period * 0.7,
			swellHeight: swell,
			swellDirection: 285,
			swellPeriod: period * 0.85,
			swellPeakPeriod: period,
		},
		weather: {
			temperature: 14,
			humidity: 80,
			precipitation: 0,
			pressure: 1012,
			windSpeed,
			windDirection,
			windGusts: gust,
		},
		surf_score: {
			totalScore: Math.max(...scores),
			scoresBySkill: { beginner: scores[0], intermediate: scores[1], advanced: scores[2] },
			breakdown: { waveHeightCategory: "good" },
			face,
			wind,
			limit,
		},
	};
}

/**
 * A late-October day at a west-facing beach: light 07:00-17:00, a clean
 * morning, an onshore gale by mid-afternoon — and a "perfect" 99 at 19:00,
 * two hours after dark, which no answer may ever recommend.
 */
export function dayV2(date, { confidence = "high", byHour = {} } = {}) {
	const hourly = Array.from({ length: 24 }, (_, h) => hourV2(date, h, byHour[h] ?? { scores: [10, 10, 10], limit: ["flat", "flat", "flat"], face: 0.2 }));
	return {
		date,
		hourly,
		summary: {
			waveHeight: { min: 1, max: 2.4, avg: 1.6 },
			windSpeed: { min: 8, max: 34, avg: 18 },
			temperature: { min: 11, max: 14, avg: 13 },
		},
		daily: {
			marine: { waveHeightMax: 2.4, waveDirectionDominant: 285 },
			weather: { temperatureMax: 14, temperatureMin: 11, precipitationSum: 0, windSpeedMax: 34, windDirectionDominant: 240 },
		},
		surf_score: {
			totalScore: 82,
			scoresBySkill: { beginner: 18, intermediate: 74, advanced: 82 },
			limit: { beginner: "big", intermediate: null, advanced: null },
			face: 1.6,
			peakPeriod: 12,
			wind: { type: "offshore", quality: 96, felt: 10, gust: 16, theta: 5, shelter: 1 },
			breakdown: {
				modelVersion: 2,
				faceHeight: 1.6,
				swellHeight: 1.3,
				effectiveExposure: 0.97,
				spotWorks: 1,
				workingRange: [0.6, 2.6],
				workingRangeSource: "default",
				windType: "offshore",
				windFactor: 0.98,
				peakPeriod: 12,
				periodFactor: 0.94,
				directionFactor: 1,
				tideFactor: 0.9,
				tideState: "mid",
				limit: { beginner: "big", intermediate: null, advanced: null },
			},
		},
		best_hour: "09:00",
		best_hour_by_skill: { beginner: "07:00", intermediate: "09:00", advanced: "09:00" },
		sun: { sunrise: "07:01", sunset: "17:07" },
		daylight_hours: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
		face_range: { min: 0.9, max: 2.4 },
		confidence,
		advice: {
			beginner: "Not great — best around 7am. Above your level — 3–5ft faces.",
			intermediate: "Best around 9am. 4–5ft, light offshore.",
			advanced: "Best around 9am. 4–5ft, light offshore.",
		},
	};
}

/** Perranporth-ish: faces 285°, so a 247° wind is cross-onshore. */
export function v2Payload({ today, tomorrow, confidence = "high" }) {
	const byHour = {
		7: { scores: [20, 55, 60], limit: ["big", null, null], face: 1.5 },
		9: { scores: [18, 74, 82], limit: ["big", null, null], face: 1.6 },
		15: { scores: [5, 22, 25], limit: ["big", "wind", "wind"], face: 1.9, wind: "cross-on", windSpeed: 30, windDirection: 247.5, gust: 49 },
		19: { scores: [99, 99, 99], limit: [null, null, null], face: 1.6 },
	};
	const mk = (date, conf) => dayV2(date, { confidence: conf, byHour });
	return {
		success: true,
		count: 1,
		generated_at: `${today}T06:00:00.000Z`,
		status: "ok",
		spots: [
			{
				name: "Perranporth",
				latitude: 50.35,
				longitude: -5.155,
				region: "North Cornwall",
				skillLevel: "Beginner",
				faces: "W",
				shoreNormal: 285,
				breakType: "beach",
				bestTide: "low_to_mid",
				optimalSwellDir: [270, 315],
				optimalWindDir: [60, 150],
				swellWindow: Array.from({ length: 36 }, () => 1),
				scoring: { max_score: 10, overall_score: 7, model_version: 2 },
				forecast: { next_5_days: [mk(today, "high"), mk(tomorrow, confidence)] },
				tides: { today: [{ type: "LowWater", time: `${today}T09:30` }] },
			},
		],
	};
}
