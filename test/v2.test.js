/**
 * Scoring model v2 through the connector: daylight-only answers, the face
 * height at the break, wind judged against the way the beach faces, what
 * limits the score for each skill, and a confidence note further out.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../src/server.js";
import { clearCache } from "../src/upstream.js";
import { todayIn } from "../src/when.js";
import { windShelter } from "../src/beach-day.js";
import { describeHour, classifyWind, windText } from "../src/conditions.js";
import { stubFetch, v2Payload, hourV2 } from "./fixture.js";

const TODAY = todayIn("Europe/London");
const TOMORROW = new Date(Date.parse(`${TODAY}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

async function connect(body) {
	const server = buildServer({ fetchImpl: stubFetch(body) });
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	const [c, s] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(s), client.connect(c)]);
	return client;
}
const call = async (client, name, args) => {
	const res = await client.callTool({ name, arguments: args });
	return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError };
};

beforeEach(() => clearCache());

test("the best hour is a daylight hour — never the 99 at 19:00, two hours after dark", async () => {
	const client = await connect(v2Payload({ today: TODAY, tomorrow: TOMORROW }));
	const { text, isError } = await call(client, "find_surf_spots", { latitude: 50.35, longitude: -5.155, skill_level: "advanced" });
	assert.ok(!isError, text);
	assert.match(text, /Perranporth\s+82 .* at 09:00/);
	assert.doesNotMatch(text, /at 19:00/);
	assert.match(text, /in the dark are left out \(sunrise 07:01, sunset 17:07\)/);
});

test("an evening after dark says so, rather than ranking the dark", async () => {
	const client = await connect(v2Payload({ today: TODAY, tomorrow: TOMORROW }));
	const { text, isError } = await call(client, "find_surf_spots", {
		latitude: 50.35, longitude: -5.155, part_of_day: "evening",
	});
	assert.ok(!isError, text);
	assert.match(text, /All of this evening is in the dark/);
	assert.match(text, /sunset 17:07/);
	assert.doesNotMatch(text, /99/);
});

test("rows say what limits the score, for the skill asked about", async () => {
	const client = await connect(v2Payload({ today: TODAY, tomorrow: TOMORROW }));
	const beginner = await call(client, "find_surf_spots", { latitude: 50.35, longitude: -5.155, skill_level: "beginner" });
	assert.match(beginner.text, /Too big: Above your level — 4–5ft faces|Above your level/);
	const advanced = await call(client, "find_surf_spots", { latitude: 50.35, longitude: -5.155, skill_level: "advanced" });
	assert.match(advanced.text, /Firing: 4–5ft, light offshore\. · 12s WNW swell/);
	assert.match(advanced.text, /wave faces at each break/);
});

test("wind is judged against the way the beach faces", () => {
	const spot = { shoreNormal: 285 };
	// Perranporth's WSW 30 km/h — the app showed it as OFFSHORE in green.
	assert.equal(classifyWind(spot, 247.5, 30), "cross-on");
	assert.equal(classifyWind(spot, 105, 20), "offshore");
	const h = hourV2(TODAY, 15, { scores: [5, 22, 25], limit: ["big", "wind", "wind"], face: 1.9, wind: "cross-on", windSpeed: 30, windDirection: 247.5, gust: 49 });
	const d = describeHour(h, spot, "advanced");
	assert.equal(d.label, "Blown out");
	assert.equal(d.headline, "Blown out — 30 km/h cross-onshore, gusting 49.");
	// Headland shelter is named, so the number agrees with the forecast wind.
	assert.equal(windText({ type: "cross", felt: 14.5, gust: 26, shelter: 0.6 }), "15 km/h cross-shore (sheltered from 24)");
});

test("further out, the answer carries a confidence note", async () => {
	const client = await connect(v2Payload({ today: TODAY, tomorrow: TOMORROW, confidence: "low" }));
	const { text } = await call(client, "find_surf_spots", { latitude: 50.35, longitude: -5.155, date: "tomorrow" });
	assert.match(text, /low confidence/);
});

test("get_spot_forecast: a verdict per skill, dark hours marked, the breakdown in words", async () => {
	const client = await connect(v2Payload({ today: TODAY, tomorrow: TOMORROW }));
	const { text, isError } = await call(client, "get_spot_forecast", { spot: "Perranporth" });
	assert.ok(!isError, text);
	assert.match(text, /Daylight: sunrise 07:01, sunset 17:07/);
	assert.match(text, /beginner\s+18\/100 at 07:00 — Not great — best around 7am\. Above your level/);
	assert.match(text, /advanced\s+82\/100 at 09:00 — Best around 9am/);
	assert.match(text, /^19:00 .* dark /m, "a night hour is marked dark, whatever it scores");
	assert.match(text, /^15:00 .*30km\/h WSW cross-on .*Blown out/m);
	assert.match(text, /wind\s+×0\.98\s+\(light offshore\)/);
	assert.match(text, /limited by\s+beginner big/);
});

test("beach wind shelter uses the measured shore normal and headland shelter", () => {
	// Fistral faces 299° and a headland blocks part of a SW wind.
	const fistral = { faces: "W", shoreNormal: 299, windShelter: [{ from: 200, to: 250, factor: 0.6 }] };
	const plain = { faces: "W", shoreNormal: 299 };
	assert.ok(windShelter(220, fistral) < windShelter(220, plain) - 0.2);
	// Straight onshore at the real normal is no shelter at all.
	assert.equal(windShelter(299, plain), 1);
	// The faces word alone still works.
	assert.equal(windShelter(270, "W"), 1);
});

test("the connector's words match the app's and the API's on the edge cases", () => {
	const h = hourV2(TODAY, 17, { scores: [61, 63, 58], limit: ["wind", "wind", "wind"], face: 1.4, wind: "cross-off", windSpeed: 24, windDirection: 160, gust: 44 });
	const d = describeHour(h, { shoreNormal: 285 }, "intermediate");
	assert.equal(d.label, "Good");
	assert.equal(d.headline, "3–5ft, 24 km/h cross-offshore, gusting 44 — a bit bumpy.");
	const small = hourV2(TODAY, 17, { scores: [61, 45, 40], limit: ["small", "small", "small"], face: 0.7, wind: "cross-off", windSpeed: 24, windDirection: 160, gust: 44 });
	assert.match(describeHour(small, { shoreNormal: 285 }, "beginner").headline, /^Small — 2–3ft/);
	assert.equal(describeHour(small, { shoreNormal: 285 }, "beginner").label, "Small");
});
