/**
 * End-to-end tests: a real MCP client talking to the real server over the
 * real protocol, with only the upstream HTTP call stubbed.
 *
 * Deliberately not unit tests of the tool callbacks. The recurring failure in
 * this project has been a unit passing while production took a different path
 * — the swell window that worked in tests and was dropped by the payload
 * allowlist, the scorer that had two engines. So these drive `tools/list` and
 * `tools/call` through the SDK, exactly as Claude will.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../src/server.js";
import { clearCache } from "../src/upstream.js";
import { payload, stubFetch, iso } from "./fixture.js";

const TODAY = iso(new Date());

async function connect(fetchImpl) {
	const server = buildServer({ fetchImpl });
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	const [clientT, serverT] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverT), client.connect(clientT)]);
	return { client, server };
}

const call = async (client, name, args) => {
	const res = await client.callTool({ name, arguments: args });
	return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError };
};

beforeEach(() => clearCache());

test("the server advertises the tools Claude needs, with descriptions", async () => {
	const { client } = await connect(stubFetch());
	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name).sort();

	assert.deepEqual(names, [
		"find_beach_spots",
		"find_surf_spots",
		"get_spot_forecast",
		"list_spots",
	]);

	// A tool with no description is a tool Claude will not reach for.
	for (const t of tools) {
		assert.ok(t.description && t.description.length > 40, `${t.name} needs a real description`);
		assert.ok(t.inputSchema, `${t.name} needs an input schema`);
	}
});

test("find_surf_spots ranks by surf score and reports distance", async () => {
	const { client } = await connect(stubFetch());
	const { text, isError } = await call(client, "find_surf_spots", {
		near: "Newquay",
		date: "today",
	});

	assert.ok(!isError, text);
	assert.match(text, /Close Beach/);
	// Close Beach (surf 82) must outrank Warm Cove (surf 12).
	assert.ok(
		text.indexOf("Close Beach") < text.indexOf("Warm Cove"),
		`surf ranking is wrong:\n${text}`,
	);
	assert.match(text, /\d+km [NSEW]/, "should say how far away each spot is");
});

test("THE POINT: beach ranking disagrees with surf ranking", async () => {
	// Close Beach is the best surf and a miserable beach — 2.4m, 30km/h, 11°C.
	// Warm Cove is the worst surf and a lovely beach — 0.3m, 6km/h, 24°C.
	// If one ordering ever produces the other, the beach score has stopped
	// being its own thing and is just tracking the surf score.
	const { client } = await connect(stubFetch());

	const surf = await call(client, "find_surf_spots", { near: "Newquay" });
	const beach = await call(client, "find_beach_spots", { near: "Newquay" });

	assert.ok(
		surf.text.indexOf("Close Beach") < surf.text.indexOf("Warm Cove"),
		"surf should prefer Close Beach",
	);
	assert.ok(
		beach.text.indexOf("Warm Cove") < beach.text.indexOf("Close Beach"),
		`beach should prefer Warm Cove:\n${beach.text}`,
	);
});

test("radius filters, and widening it brings distant spots back", async () => {
	const { client } = await connect(stubFetch());

	const near = await call(client, "find_surf_spots", { near: "Newquay" });
	assert.ok(!/Far Point/.test(near.text), "Far Point is ~90km away, outside the default");

	const wide = await call(client, "find_surf_spots", { near: "Newquay", radius_km: 150 });
	assert.match(wide.text, /Far Point/);
});

test("an unresolvable place says so instead of returning nothing", async () => {
	const stub = stubFetch(payload(), { geocode: { results: [] } });
	const { client } = await connect(stub);
	const { text, isError } = await call(client, "find_surf_spots", { near: "Atlantis" });

	assert.ok(isError);
	assert.match(text, /Could not find a place called "Atlantis"/);
	assert.match(text, /latitude and longitude/, "should say how to work around it");
});

test("lat/lon is accepted without geocoding", async () => {
	const stub = stubFetch();
	const { client } = await connect(stub);
	const { text } = await call(client, "find_surf_spots", {
		latitude: 50.415,
		longitude: -5.078,
	});
	assert.match(text, /Close Beach/);
	assert.ok(
		!stub.calls.some((u) => u.includes("geocoding-api")),
		"explicit coordinates must not trigger a geocode lookup",
	);
});

test("a missing location is refused with instructions", async () => {
	const { client } = await connect(stubFetch());
	const { text, isError } = await call(client, "find_surf_spots", {});
	assert.ok(isError);
	assert.match(text, /No location given/);
});

test("get_spot_forecast returns hours, both scores and a breakdown", async () => {
	const { client } = await connect(stubFetch());
	const { text, isError } = await call(client, "get_spot_forecast", {
		spot: "Warm Cove",
		part_of_day: "morning",
	});

	assert.ok(!isError, text);
	assert.match(text, /Warm Cove/);
	assert.match(text, /surf\s+beach/, "should show both scores side by side");
	assert.match(text, /06:00/);
	assert.ok(!/12:00/.test(text.split("breakdown")[0]), "morning window is exclusive of 12:00");
	assert.match(text, /breakdown/i);
});

test("an ambiguous spot name asks rather than guessing", async () => {
	// Four spots are called something-Fistral in the real dataset. Answering
	// about whichever came first would be confidently wrong.
	const body = payload();
	body.spots.push(
		{ ...body.spots[0], name: "North Fistral" },
		{ ...body.spots[1], name: "South Fistral" },
	);
	const { client } = await connect(stubFetch(body));

	const { text } = await call(client, "get_spot_forecast", { spot: "Fistral" });
	assert.match(text, /matches more than one spot/);
	assert.match(text, /North Fistral/);
	assert.match(text, /South Fistral/);
});

test("an unknown spot name is reported, not silently empty", async () => {
	const { client } = await connect(stubFetch());
	const { text } = await call(client, "get_spot_forecast", { spot: "Bondi" });
	assert.match(text, /No spot matching "Bondi"/);
});

test("a future day with no hourly data still answers, marked day-level", async () => {
	// The summary payload carries `hourly: []` beyond today. That must read as
	// "coarser answer", never as "no forecast".
	const { client } = await connect(stubFetch(payload({ withHourly: false })));
	const { text, isError } = await call(client, "find_beach_spots", {
		near: "Newquay",
		date: "tomorrow",
	});

	assert.ok(!isError, text);
	assert.match(text, /Warm Cove/);
	assert.match(text, /day-level/, "the answer must admit it is coarser");
});

test("a date beyond the forecast says so", async () => {
	const { client } = await connect(stubFetch());
	const { text } = await call(client, "get_spot_forecast", {
		spot: "Warm Cove",
		date: "2027-01-01",
	});
	assert.match(text, /No forecast for Warm Cove on 2027-01-01/);
});

test("list_spots groups by region", async () => {
	const { client } = await connect(stubFetch());
	const { text } = await call(client, "list_spots", {});
	assert.match(text, /North Cornwall \(2\)/);
	assert.match(text, /North Devon \(1\)/);

	const filtered = await call(client, "list_spots", { region: "Devon" });
	assert.match(filtered.text, /Far Point/);
	assert.ok(!/Close Beach/.test(filtered.text));
});

test("the upstream payload is fetched once and reused", async () => {
	// A conversation asks several questions in a row. Re-downloading megabytes
	// each time is the difference between a snappy connector and a timeout.
	const stub = stubFetch();
	const { client } = await connect(stub);

	await call(client, "find_surf_spots", { near: "Newquay" });
	await call(client, "find_beach_spots", { near: "Newquay" });
	await call(client, "list_spots", {});

	const surfCalls = stub.calls.filter((u) => u.includes("/surf"));
	assert.equal(surfCalls.length, 1, `expected one upstream fetch, got ${surfCalls.length}`);
});

test("an upstream failure surfaces as a readable error", async () => {
	const failing = async (url) => {
		if (String(url).includes("geocoding-api")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					results: [{ name: "Newquay", latitude: 50.415, longitude: -5.078, country_code: "GB" }],
				}),
			};
		}
		return { ok: false, status: 502, json: async () => ({}) };
	};
	const { client } = await connect(failing);
	const { text, isError } = await call(client, "find_surf_spots", { near: "Newquay" });

	assert.ok(isError);
	assert.match(text, /returned 502/);
});

test("today's data is used when the date is today", async () => {
	const { client } = await connect(stubFetch());
	const { text } = await call(client, "find_surf_spots", { near: "Newquay", date: TODAY });
	assert.match(text, new RegExp(TODAY));
});
