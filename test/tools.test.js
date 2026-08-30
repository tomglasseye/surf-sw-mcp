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
import {
	payload,
	sameCellPayload,
	travelPayload,
	stubFetch,
	iso,
} from "./fixture.js";

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

test("beach ranking separates two beaches sharing one marine grid cell", async () => {
	// End to end, through the protocol. Both spots report an identical 2.5m
	// because the marine model has one cell for both; only their swell windows
	// differ. This is the Newquay case, and it is the whole reason a family can
	// use this tool to pick a beach rather than just a region.
	const { client } = await connect(stubFetch(sameCellPayload()));
	const { text, isError } = await call(client, "find_beach_spots", {
		near: "Newquay",
		radius_km: 30,
	});

	assert.ok(!isError, text);
	assert.ok(
		text.indexOf("Sheltered Cove") < text.indexOf("Exposed Beach"),
		`the sheltered beach must win on a 2.5m day:\n${text}`,
	);
	// And it should say why, or the answer is unarguable rather than useful.
	assert.match(text, /sheltered from the swell/);
	assert.match(text, /2\.5m out/);
});

test("surf ranking is unaffected by the beach shelter maths", async () => {
	// The surf side reads surf_score, which already accounts for exposure
	// upstream. If a change to the beach score ever moves the surf ranking,
	// something has leaked between them.
	const { client } = await connect(stubFetch(sameCellPayload()));
	const { text } = await call(client, "find_surf_spots", {
		near: "Newquay",
		radius_km: 30,
	});
	assert.match(text, /Sheltered Cove/);
	assert.match(text, /Exposed Beach/);
});

test("audience changes the beach ranking through the tool", async () => {
	// The exposed beach is the pleasanter place to sit (no shelter, so more
	// open) but the wrong place to take a child on a 2.5m day.
	const { client } = await connect(stubFetch(sameCellPayload({ wave: 2.5 })));

	const kids = await call(client, "find_beach_spots", {
		near: "Newquay", radius_km: 30, audience: "kids",
	});
	assert.ok(!kids.isError, kids.text);
	assert.ok(
		kids.text.indexOf("Sheltered Cove") < kids.text.indexOf("Exposed Beach"),
		`kids ranking should strongly prefer the sheltered beach:\n${kids.text}`,
	);
	assert.match(kids.text, /small children/, "header should say who it scored for");
	assert.match(kids.text, /too big/, "and why the exposed one lost");
});

test("the beach tool advertises the audience choice to Claude", async () => {
	// If this is not in the schema, Claude cannot use it, and "somewhere to
	// take the kids" silently gets the sitting score.
	const { client } = await connect(stubFetch());
	const { tools } = await client.listTools();
	const beach = tools.find((t) => t.name === "find_beach_spots");
	assert.deepEqual(beach.inputSchema.properties.audience.enum, [
		"sitting",
		"swimming",
		"kids",
	]);
	assert.match(beach.description, /kids|children/i);
});

test("get_spot_forecast shows a sky column, and absent is not a clear sky", async () => {
	// The fixture carries no cloudCover, matching the API before its deploy.
	// A missing field rendered as 0% would read as brilliant sunshine — the
	// most misleading possible default for this particular number.
	const { client } = await connect(stubFetch());
	const { text } = await call(client, "get_spot_forecast", {
		spot: "Warm Cove",
		part_of_day: "morning",
	});
	assert.match(text, /sky/, "the column should be there");
	assert.ok(!/\s0%/.test(text), "absent cloud must not render as 0%");
	assert.match(text, /-\s*$/m, "it should render as a dash");
});

test("cloud shows up once the API serves it", async () => {
	// Proves the column is wired to the field rather than always printing a
	// dash — which would look identical today and stay broken after deploy.
	const body = payload();
	for (const spot of body.spots) {
		for (const day of spot.forecast.next_5_days) {
			for (const h of day.hourly) h.weather.cloudCover = 42;
		}
	}
	const { client } = await connect(stubFetch(body));
	const { text } = await call(client, "get_spot_forecast", {
		spot: "Warm Cove",
		part_of_day: "morning",
	});
	assert.match(text, /42%/);
});

// ── Travel ───────────────────────────────────────────────────────────────

test("THE FALMOUTH CASE: a good beach nearby beats a better one 29km away", async () => {
	// Ranking on score alone sent someone in Falmouth to Newquay. Both numbers
	// were right; the ordering ignored the distance it already had.
	const { client } = await connect(stubFetch(travelPayload()));
	const { text, isError } = await call(client, "find_beach_spots", {
		near: "Newquay", radius_km: 50,
	});

	assert.ok(!isError, text);
	assert.ok(
		text.indexOf("Near Cove") < text.indexOf("Far Beach"),
		`the nearby beach should come first:\n${text}`,
	);
});

test("the score shown is the conditions, not the conditions minus the drive", async () => {
	// Nobody wants to be told a beach is "a 76 once you account for the
	// journey". They want to know it is a 93 that happens to be too far.
	const { client } = await connect(stubFetch(travelPayload()));
	const { text } = await call(client, "find_beach_spots", {
		near: "Newquay", radius_km: 50,
	});

	const score = (name) => {
		const line = text.split("\n").find((l) => l.includes(name));
		return Number(line.match(/\s(\d+)\s+\d+km/)[1]);
	};
	assert.ok(
		score("Far Beach") > score("Near Cove"),
		"the far beach must still display the higher score, despite ranking lower",
	);
	assert.match(text, /travel/i, "and the header must say why the order looks odd");
});

test("surfers travel further than families, and the ranking knows", async () => {
	// The same two spots, the same distances. A 29km drive is most of the
	// reason not to bother with a beach and barely a consideration for waves.
	const { client } = await connect(stubFetch(travelPayload()));

	const beach = await call(client, "find_beach_spots", { near: "Newquay", radius_km: 50 });
	const surf = await call(client, "find_surf_spots", { near: "Newquay", radius_km: 50 });

	assert.ok(
		beach.text.indexOf("Near Cove") < beach.text.indexOf("Far Beach"),
		"beach ranking should prefer near",
	);
	assert.ok(
		surf.text.indexOf("Far Beach") < surf.text.indexOf("Near Cove"),
		`surf ranking should still prefer the better waves:\n${surf.text}`,
	);
});

test("distance is a tie-breaker, not a preference for whatever is closest", async () => {
	// If a mild discount ever became a local-only bias, the tool would stop
	// telling people the good waves are in Devon — which is sometimes the
	// single most useful thing it can say.
	const body = travelPayload();
	const near = body.spots.find((s) => s.name === "Near Cove");
	for (const day of near.forecast.next_5_days) {
		for (const h of day.hourly) {
			h.weather.temperature = 11;   // cold
			h.weather.windSpeed = 30;     // and blowing
		}
	}
	const { client } = await connect(stubFetch(body));
	const { text } = await call(client, "find_beach_spots", { near: "Newquay", radius_km: 50 });
	assert.ok(
		text.indexOf("Far Beach") < text.indexOf("Near Cove"),
		`a far beach that is genuinely far better must still win:\n${text}`,
	);
});
