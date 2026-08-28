import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreBeachHour, scoreBeachDay, ratingFor } from "../src/beach-day.js";

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
