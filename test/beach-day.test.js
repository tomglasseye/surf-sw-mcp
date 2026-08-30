import { test } from "node:test";
import assert from "node:assert/strict";

import {
	scoreBeachHour,
	scoreBeachDay,
	ratingFor,
	exposureAt,
	effectiveWaveHeight,
	windShelter,
	explainBeach,
} from "../src/beach-day.js";

const hour = ({ wave = 0.5, wind = 8, temp = 22, rain = 0 }) => ({
	marine: { waveHeight: wave },
	weather: { windSpeed: wind, temperature: temp, precipitation: rain },
});

test("a warm, calm, dry day scores well", () => {
	const r = scoreBeachHour(hour({ temp: 24, wind: 5, wave: 0.3, rain: 0 }));
	assert.ok(r.score >= 90, `expected a great day, got ${r.score}`);
	assert.equal(r.rating, "great");
});

test("a cold day is not rescued by being calm", () => {
	// The thing a wind-and-waves-only score gets wrong: 9°C and glassy reads
	// as perfect to `good-for.js`, and is nobody's idea of a beach day.
	const r = scoreBeachHour(hour({ temp: 9, wind: 2, wave: 0.2 }));
	assert.ok(r.score < 55, `9°C should not be a good beach day, got ${r.score}`);
});

test("wind ruins an otherwise warm day", () => {
	const calm = scoreBeachHour(hour({ temp: 24, wind: 4 }));
	const blown = scoreBeachHour(hour({ temp: 24, wind: 38 }));
	assert.ok(
		calm.score - blown.score > 30,
		`wind should dominate: calm ${calm.score} vs blown ${blown.score}`,
	);
});

test("rain gates rather than averages", () => {
	// A weighted rain term lets a warm calm day average out to "fair" in a
	// downpour. It must not.
	const dry = scoreBeachHour(hour({ temp: 25, wind: 4, rain: 0 }));
	const wet = scoreBeachHour(hour({ temp: 25, wind: 4, rain: 3 }));
	assert.ok(dry.score > 90, `dry baseline should be high, got ${dry.score}`);
	assert.ok(wet.score < 25, `heavy rain must gate the score, got ${wet.score}`);
	assert.ok(wet.components.rain_gate < 0.2);
});

test("heavy-rain hours stay rankable against each other", () => {
	// The gate floors at 0.08 rather than 0 so a wet warm spot still beats a
	// wet freezing one instead of every wet spot collapsing to zero.
	const warmWet = scoreBeachHour(hour({ temp: 24, wind: 5, rain: 5 }));
	const coldWet = scoreBeachHour(hour({ temp: 11, wind: 25, rain: 5 }));
	assert.ok(warmWet.score > coldWet.score);
});

test("big surf costs a beach day something, but not everything", () => {
	const flat = scoreBeachHour(hour({ wave: 0.3 }));
	const big = scoreBeachHour(hour({ wave: 3.5 }));
	assert.ok(flat.score > big.score, "big waves should cost something");
	assert.ok(
		big.score > 55,
		`a warm calm day with big surf is still a fine beach day, got ${big.score}`,
	);
});

test("missing wind or temperature returns null rather than a guess", () => {
	// A spot with no weather data must drop out of the ranking, not land in
	// the middle of it on default values.
	assert.equal(scoreBeachHour({ weather: { temperature: 20 } }), null);
	assert.equal(scoreBeachHour({ weather: { windSpeed: 10 } }), null);
	assert.equal(scoreBeachHour({}), null);
});

test("missing wave height is tolerated — it is the least important term", () => {
	const r = scoreBeachHour({
		weather: { windSpeed: 6, temperature: 23, precipitation: 0 },
	});
	assert.ok(r && r.score > 60);
});

test("day-level scoring spreads daily rain over daylight hours", () => {
	// precipitationSum is a 24h total. Compared directly against an hourly
	// threshold, any drizzly day would gate to nothing.
	const drizzle = scoreBeachDay({
		summary: {
			windSpeed: { avg: 6 },
			temperature: { max: 23 },
			waveHeight: { avg: 0.4 },
		},
		daily: { weather: { precipitationSum: 0.8 } }, // 0.1mm/h over 8h
	});
	assert.ok(drizzle.score > 60, `light drizzle should not zero the day, got ${drizzle.score}`);

	const washout = scoreBeachDay({
		summary: {
			windSpeed: { avg: 6 },
			temperature: { max: 23 },
			waveHeight: { avg: 0.4 },
		},
		daily: { weather: { precipitationSum: 24 } }, // 3mm/h
	});
	assert.ok(washout.score < 30);
});

test("ratings match the thresholds the surf app already uses", () => {
	assert.equal(ratingFor(80), "great");
	assert.equal(ratingFor(60), "good");
	assert.equal(ratingFor(45), "fair");
	assert.equal(ratingFor(25), "poor");
	assert.equal(ratingFor(5), "no");
});

test("REGRESSION: a gale is a gale, however warm the afternoon", () => {
	// The mirror of the cold-day bug. Wind carries 40% of the weight, so a
	// 35km/h day at 24°C still scored 64 — "good" — on temperature and flat
	// water alone. Nobody sits on a beach in that.
	const gale = scoreBeachHour(hour({ temp: 24, wind: 35, wave: 0.5 }));
	assert.ok(gale.score < 45, `35km/h should not read "good", got ${gale.score}`);
	assert.ok(gale.components.gale_gate < 0.7);
});

test("moderate wind is weighted, not gated", () => {
	// The gate must only bite at the top end, or every breezy day collapses
	// and the score stops discriminating among the ordinary ones.
	const breezy = scoreBeachHour(hour({ temp: 22, wind: 18, wave: 0.5 }));
	assert.equal(breezy.components.gale_gate, 1);
	assert.ok(breezy.score > 60);
});

// ── Shelter: the part good-for.js cannot do ──────────────────────────────

test("exposureAt reads the 36-bucket window, and defaults open", () => {
	const w = Array.from({ length: 36 }, (_, i) => i / 35);
	assert.equal(exposureAt(w, 0), 0);
	assert.equal(exposureAt(w, 350), 1);
	assert.ok(Math.abs(exposureAt(w, 180) - 18 / 35) < 0.01);
	assert.equal(exposureAt(w, 356), 0, "wraps back to bucket 0");

	// Safe wiring: a spot with no window must score as it did before rather
	// than being wrongly penalised. This is the rule that stopped the swell
	// window breaking every spot when it was first added to the API.
	assert.equal(exposureAt(undefined, 270), 1);
	assert.equal(exposureAt([], 270), 1);
	assert.equal(exposureAt(w, null), 1);
});

test("effective wave height uses the square root of exposure", () => {
	// Height goes as the root of energy. Multiplying height by exposure
	// directly would put Towan at 0.2m in a 2.5m swell, which is far too
	// flattering; the root puts it at 0.7m.
	assert.ok(Math.abs(effectiveWaveHeight(2.5, 0.08) - 0.707) < 0.01);
	assert.equal(effectiveWaveHeight(2.5, 1), 2.5);
	assert.ok(Math.abs(effectiveWaveHeight(2.5, 0.42) - 1.62) < 0.01);
	assert.equal(effectiveWaveHeight(null, 0.5), null);
});

test("wind shelter reads offshore as sheltered", () => {
	// A west-facing beach. Wind FROM the west has crossed the sea and hits you;
	// wind FROM the east has crossed the land behind the beach first.
	assert.equal(windShelter(270, "W"), 1, "straight onshore, no shelter");
	assert.ok(Math.abs(windShelter(90, "W") - 0.6) < 0.001, "straight offshore");
	assert.ok(Math.abs(windShelter(180, "W") - 0.8) < 0.001, "cross-shore, half");

	// Unknown or missing data must not invent shelter.
	assert.equal(windShelter(90, undefined), 1);
	assert.equal(windShelter(null, "W"), 1);
	assert.equal(windShelter(90, "banana"), 1);
});

test("THE FIX: two beaches in one grid cell score differently", () => {
	// Same wave height, wind and air — the only difference is the swell
	// window. Measured on real data, six Newquay spots reported an identical
	// 0.56m across a twelve-fold difference in exposure, and good-for.js gave
	// them all the same swim and splash score because it reads the grid cell.
	const conditions = {
		marine: { waveHeight: 2.5, swellDirection: 285 },
		weather: { windSpeed: 14, windDirection: 135, temperature: 22, precipitation: 0 },
	};
	const sheltered = scoreBeachHour(conditions, {
		swellWindow: Array(36).fill(0.08), faces: "W",
	});
	const exposed = scoreBeachHour(conditions, {
		swellWindow: Array(36).fill(1), faces: "W",
	});

	assert.ok(
		sheltered.score > exposed.score + 10,
		`sheltered ${sheltered.score} should clearly beat exposed ${exposed.score}`,
	);
	assert.ok(sheltered.inputs.effective_wave_height_m < 0.8, "knee-high in the cove");
	assert.equal(exposed.inputs.effective_wave_height_m, 2.5, "full size outside");
	// Both still report the grid-cell figure, so an answer can explain itself.
	assert.equal(sheltered.inputs.wave_height_m, 2.5);
});

test("with no spot the score still works, just bluntly", () => {
	// Safe wiring again: omitting the spot must not throw or zero the score,
	// it should simply fall back to the grid cell.
	const r = scoreBeachHour({
		marine: { waveHeight: 0.4, swellDirection: 285 },
		weather: { windSpeed: 8, windDirection: 135, temperature: 22, precipitation: 0 },
	});
	assert.ok(r && r.score > 70);
	assert.equal(r.components.swell_exposure, 1);
	assert.equal(r.components.wind_shelter, 1);
});

test("day-level scoring applies shelter from the dominant directions", () => {
	const day = {
		summary: {
			windSpeed: { avg: 14 },
			temperature: { max: 22 },
			waveHeight: { avg: 2.5 },
		},
		daily: {
			marine: { waveDirectionDominant: 285 },
			weather: { precipitationSum: 0, windDirectionDominant: 135 },
		},
	};
	const sheltered = scoreBeachDay(day, { swellWindow: Array(36).fill(0.08), faces: "W" });
	const exposed = scoreBeachDay(day, { swellWindow: Array(36).fill(1), faces: "W" });
	assert.ok(
		sheltered.score > exposed.score + 10,
		`day-level must shelter too: ${sheltered.score} vs ${exposed.score}`,
	);
});

// ── Audience ─────────────────────────────────────────────────────────────

test("THE FAMILY CASE: a 2.5m beach is fine to sit on and no place for kids", () => {
	// One weighting collapses these. Wind and temperature carry 80% of the
	// sitting score, so a warm, light-wind, 2.5m day at an exposed beach came
	// out at 79/100 — "great" — which is correct for a deckchair and dangerous
	// advice for a family with small children.
	const conditions = {
		marine: { waveHeight: 2.5, swellDirection: 285 },
		weather: { windSpeed: 12, windDirection: 135, temperature: 23, precipitation: 0 },
	};
	const exposed = { swellWindow: Array(36).fill(1), faces: "W" };

	const sitting = scoreBeachHour(conditions, exposed, "sitting");
	const swimming = scoreBeachHour(conditions, exposed, "swimming");
	const kids = scoreBeachHour(conditions, exposed, "kids");

	assert.ok(sitting.score > 70, `fine to sit on, got ${sitting.score}`);
	assert.ok(swimming.score < 50, `not for swimming, got ${swimming.score}`);
	assert.ok(kids.score < 20, `no place for kids, got ${kids.score}`);
	assert.equal(kids.rating, "no");
});

test("the same day at a sheltered beach works for everyone", () => {
	// And this is the pay-off: same grid cell, same weather, but the swell
	// window says the water here is knee-high. Without the shelter maths this
	// beach would score identically to the exposed one and a family would have
	// nowhere to go on a big day.
	const conditions = {
		marine: { waveHeight: 2.5, swellDirection: 285 },
		weather: { windSpeed: 12, windDirection: 135, temperature: 23, precipitation: 0 },
	};
	const sheltered = { swellWindow: Array(36).fill(0.08), faces: "W" };

	for (const audience of ["sitting", "swimming", "kids"]) {
		const r = scoreBeachHour(conditions, sheltered, audience);
		assert.ok(r.score > 70, `${audience} should be fine here, got ${r.score}`);
	}
});

test("wave size still matters to kids on a calm warm day", () => {
	// The gate must not be all-or-nothing: 0.9m is worse than 0.3m for a
	// toddler even though neither is dangerous.
	const at = (wave) =>
		scoreBeachHour(
			{
				marine: { waveHeight: wave, swellDirection: 285 },
				weather: { windSpeed: 8, windDirection: 135, temperature: 23, precipitation: 0 },
			},
			{ swellWindow: Array(36).fill(1), faces: "W" },
			"kids",
		).score;
	assert.ok(at(0.3) > at(0.9), "smaller is better for kids");
	assert.ok(at(0.9) > at(1.6), "and 1.6m worse again");
});

test("an unknown audience falls back to sitting rather than throwing", () => {
	const r = scoreBeachHour(
		{
			marine: { waveHeight: 1, swellDirection: 285 },
			weather: { windSpeed: 10, windDirection: 135, temperature: 22, precipitation: 0 },
		},
		{ swellWindow: Array(36).fill(1), faces: "W" },
		"sunbathing-with-a-dog",
	);
	assert.ok(r);
	assert.equal(r.audience, "sitting");
});

// ── Sun ──────────────────────────────────────────────────────────────────

const sunHour = (cloud) => ({
	marine: { waveHeight: 0.5, swellDirection: 285 },
	weather: {
		windSpeed: 8, windDirection: 135, temperature: 22, precipitation: 0,
		...(cloud === null ? {} : { cloudCover: cloud }),
	},
});
const openSpot = { swellWindow: Array(36).fill(1), faces: "W" };

test("SAFE WIRING: no cloudCover scores exactly as before, not approximately", () => {
	// The API did not serve this field when the term was added. A connector
	// that quietly re-scored all 125 spots the day it shipped would be
	// indistinguishable from a bug, so sun is blended in by taking its weight
	// off the other three proportionally — absent, the arithmetic is
	// identical, not merely close.
	//
	// These are the values from before the sun term existed.
	assert.equal(scoreBeachHour(sunHour(null), openSpot, "sitting").score, 100);
	assert.equal(scoreBeachHour(sunHour(null), openSpot, "swimming").score, 100);
	assert.equal(scoreBeachHour(sunHour(null), openSpot, "kids").score, 91);
	assert.equal(scoreBeachHour(sunHour(null), openSpot).components.sun, null);
});

test("a clear sky beats an overcast one", () => {
	const clear = scoreBeachHour(sunHour(0), openSpot, "sitting").score;
	const grey = scoreBeachHour(sunHour(100), openSpot, "sitting").score;
	assert.ok(clear > grey, `clear ${clear} should beat overcast ${grey}`);
	assert.ok(clear - grey >= 8, "and by enough to change a ranking");
});

test("grey is weighted, never gated", () => {
	// Cold, rain and a gale each end a beach day on their own. Grey does not:
	// a warm, calm, overcast afternoon on the sand is still a good one, and a
	// score that called it "poor" would be wrong in a way people would notice
	// immediately.
	const overcast = scoreBeachHour(sunHour(100), openSpot, "sitting");
	assert.ok(overcast.score > 75, `still a good day, got ${overcast.score}`);
	assert.equal(overcast.rating, "great");
});

test("a few clouds cost nothing", () => {
	assert.equal(
		scoreBeachHour(sunHour(0), openSpot, "sitting").score,
		scoreBeachHour(sunHour(20), openSpot, "sitting").score,
	);
});

test("sun matters most to sitting and least to kids in the water", () => {
	// You notice the sun on a towel. You notice it less while chasing a
	// five-year-old through the shorebreak.
	const drop = (audience) =>
		scoreBeachHour(sunHour(0), openSpot, audience).score -
		scoreBeachHour(sunHour(100), openSpot, audience).score;
	assert.ok(drop("sitting") > drop("swimming"), "sitting should care most");
	assert.ok(drop("swimming") > drop("kids"), "kids should care least");
});

test("sun cannot rescue a day that is cold, wet or blowing", () => {
	// The gates multiply, so a brilliant clear sky still cannot make 9°C a
	// beach day. Otherwise the cheapest possible input would override the
	// three that actually decide it.
	const brightAndFreezing = scoreBeachHour(
		{
			marine: { waveHeight: 0.4, swellDirection: 285 },
			weather: { windSpeed: 5, windDirection: 135, temperature: 9, precipitation: 0, cloudCover: 0 },
		},
		openSpot,
		"sitting",
	);
	assert.ok(brightAndFreezing.score < 35, `got ${brightAndFreezing.score}`);
});

test("the day-level path reads cloudCoverMean", () => {
	// Days beyond today carry only aggregates, and a field missing there would
	// silently fall back to the no-sun score for six of the seven days.
	const day = (mean) => ({
		summary: { windSpeed: { avg: 8 }, temperature: { max: 22 }, waveHeight: { avg: 0.5 } },
		daily: {
			marine: { waveDirectionDominant: 285 },
			weather: { precipitationSum: 0, windDirectionDominant: 135, cloudCoverMean: mean },
		},
	});
	const clear = scoreBeachDay(day(0), openSpot, "sitting");
	const grey = scoreBeachDay(day(100), openSpot, "sitting");
	assert.ok(clear.score > grey.score);
	assert.equal(clear.components.sun, 100);
	assert.equal(grey.components.sun, 35);
});

test("an overcast day says so in its explanation", () => {
	const grey = scoreBeachHour(sunHour(90), openSpot, "sitting");
	assert.match(explainBeach(grey), /grey \(90% cloud\)/);
});
