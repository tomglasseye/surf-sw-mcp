/**
 * The tools Claude sees.
 *
 * Tool descriptions are not documentation — they are the only thing the model
 * reads when deciding whether to call something, so they say when to use each
 * tool in the words a person would use, not what the function does internally.
 */

import { z } from "zod";

import { compassOf, distanceKm, bearingFrom, resolveLocation } from "./geo.js";
import { resolveWindow, inWindow, hourOf } from "./when.js";
import {
	getPayload,
	findDay,
	findSpot,
	hasHourly,
	baseUrl,
} from "./upstream.js";
import {
	scoreBeachHour,
	scoreBeachDay,
	explainBeach,
	ratingFor,
} from "./beach-day.js";

const DEFAULT_RADIUS_KM = 40;
const DEFAULT_LIMIT = 6;

/**
 * How much a spot's score is discounted for being far away.
 *
 * Ranking on score alone produced answers nobody would act on. Asked for a
 * beach near Falmouth, the connector returned Newquay Town Beach — 93, and
 * 29km away — above Gyllyngvase, which scores 79 and is 1km from the centre of
 * town. Both scores are right. The ordering is useless, because it had the
 * distance and did not use it.
 *
 * Two curves, because the two questions have genuinely different travel
 * tolerance. People drive an hour for a good wave and will not drive an hour
 * to sit on slightly nicer sand, particularly with children in the car.
 *
 * Deliberately gentle. This is a tie-breaker among comparable options, not a
 * preference for whatever is closest: a distant spot that is far better still
 * wins, which is correct — sometimes the good waves really are in Devon.
 */
const TRAVEL_BEACH = [[0, 1], [5, 1], [15, 0.92], [30, 0.82], [60, 0.7], [120, 0.55]];
const TRAVEL_SURF = [[0, 1], [15, 1], [40, 0.93], [80, 0.85], [150, 0.75]];

/** Piecewise-linear interpolation over [input, output] points. */
function interpolate(points, x) {
	if (x <= points[0][0]) return points[0][1];
	for (let i = 1; i < points.length; i++) {
		const [x0, y0] = points[i - 1];
		const [x1, y1] = points[i];
		if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
	}
	return points[points.length - 1][1];
}

/** Shared shape for anything that takes a place and a time. */
const locationShape = {
	near: z
		.string()
		.optional()
		.describe(
			'Town, village or place name to search around, e.g. "Newquay", ' +
				'"Exeter", "Swansea". Give this OR latitude+longitude.',
		),
	latitude: z.number().optional().describe("Latitude, if known precisely."),
	longitude: z.number().optional().describe("Longitude, if known precisely."),
	radius_km: z
		.number()
		.optional()
		.describe(
			`How far to look, in km. Defaults to ${DEFAULT_RADIUS_KM}. ` +
				"Widen to 100+ if the person is inland or nothing comes back.",
		),
};

const whenShape = {
	date: z
		.string()
		.optional()
		.describe(
			'"today" (default), "tomorrow", or an exact date as YYYY-MM-DD. ' +
				"Forecasts run 7 days ahead. Work out the date yourself for " +
				'things like "Saturday" — do not pass the weekday name.',
		),
	part_of_day: z
		.enum(["now", "morning", "afternoon", "evening", "all_day"])
		.optional()
		.describe(
			'Defaults to all_day (06:00-21:00). "now" means the next three ' +
				"hours and only works for today. morning 06-12, afternoon 12-18, " +
				"evening 18-21.",
		),
};

// ── Shared ranking ────────────────────────────────────────────────────────

/**
 * Load a payload that actually has hourly data for the requested day.
 *
 * The summary endpoint only carries hourly records for today, so a question
 * about tomorrow gets one retry against the full payload. Doing it by
 * inspection rather than by assuming "future day = full payload" means a
 * change in what the API returns shows up as a slower call, not wrong answers.
 */
async function payloadFor(window, fetchImpl) {
	const summary = await getPayload({ fetchImpl });
	const sample = summary.spots?.[0];
	const day = findDay(sample, window.date);

	if (day && !hasHourly(day)) {
		try {
			return { payload: await getPayload({ full: true, fetchImpl }), hourly: true };
		} catch {
			// Full payload unavailable — fall back to day-level rather than
			// failing the whole question.
			return { payload: summary, hourly: false };
		}
	}
	return { payload: summary, hourly: Boolean(day && hasHourly(day)) };
}

/**
 * Rank spots near a location for a given window.
 *
 * @param {Object} opts
 * @param {(hour: Object) => number|null} opts.scoreHour
 * @param {(day: Object) => number|null} opts.scoreDay - used when the day has
 *   no hourly records; results are flagged so the caller can say so
 */
async function rankSpots({
	payload,
	location,
	window,
	radiusKm,
	scoreHour,
	scoreDay,
	describe,
	travel,
}) {
	const rows = [];

	for (const spot of payload.spots ?? []) {
		if (!Number.isFinite(spot.latitude) || !Number.isFinite(spot.longitude)) continue;

		const km = distanceKm(
			location.latitude,
			location.longitude,
			spot.latitude,
			spot.longitude,
		);
		if (km > radiusKm) continue;

		const day = findDay(spot, window.date);
		if (!day) continue;

		let score = null;
		let bestHour = null;
		let detail = "";
		let resolution = "day";

		if (hasHourly(day)) {
			const hours = day.hourly.filter((h) => inWindow(h, window));
			for (const h of hours) {
				const s = scoreHour(h, spot);
				if (s == null) continue;
				if (score == null || s > score) {
					score = s;
					bestHour = h;
				}
			}
			resolution = "hour";
			if (bestHour) detail = describe(bestHour, null, spot);
		} else {
			score = scoreDay(day, spot);
			detail = describe(null, day, spot);
		}

		if (score == null) continue;

		rows.push({
			name: spot.name,
			region: spot.region,
			km,
			bearing: bearingFrom(
				location.latitude,
				location.longitude,
				spot.latitude,
				spot.longitude,
			),
			score,
			time: bestHour ? bestHour.time.slice(11, 16) : null,
			resolution,
			detail,
		});
	}

	// Rank on the discounted value, report the real one. Showing a distance-
	// adjusted number would be worse than useless — nobody wants to know a
	// beach is "a 76 once you account for the drive", they want to know it is
	// a 93 that happens to be too far.
	for (const r of rows) r.rank = r.score * interpolate(travel, r.km);
	rows.sort((a, b) => b.rank - a.rank || a.km - b.km);
	return rows;
}

function renderTable(rows, limit) {
	return rows
		.slice(0, limit)
		.map((r, i) => {
			const rank = String(i + 1).padStart(2);
			const name = r.name.slice(0, 24).padEnd(25);
			const score = String(r.score).padStart(3);
			const dist = `${Math.round(r.km)}km ${r.bearing}`.padEnd(9);
			const at = r.time ? ` at ${r.time}` : "";
			return `${rank}. ${name}${score}  ${dist}${at}  ${r.detail}`;
		})
		.join("\n");
}

function noResults(location, window, radiusKm) {
	return (
		`No spots found within ${radiusKm}km of ${location.name} for ` +
		`${window.label}.\n\n` +
		"The dataset covers Cornwall, Devon, Wales, northern England and " +
		"Scotland. Try a wider radius_km, or a coastal town nearer the person."
	);
}

const text = (s) => ({ content: [{ type: "text", text: s }] });
const failure = (s) => ({ content: [{ type: "text", text: s }], isError: true });

// ── Tool registration ─────────────────────────────────────────────────────

export function registerTools(server, { fetchImpl } = {}) {
	// ── 1. Surf ────────────────────────────────────────────────────────────
	server.registerTool(
		"find_surf_spots",
		{
			title: "Find the best surf nearby",
			description:
				"Rank surf spots near a place by how good the surf will be, for a " +
				"given day and part of day. Use this for anything like \"where " +
				"should I surf near me\", \"best waves this weekend\", \"is it " +
				"worth going out tomorrow morning\". Covers Cornwall, Devon, " +
				"Wales, northern England and Scotland. Scores are 0-100 and " +
				"already account for wave height, swell direction and period, " +
				"wind quality, tide, and how exposed each break is to the swell " +
				"direction on the day.",
			inputSchema: {
				...locationShape,
				...whenShape,
				skill_level: z
					.enum(["beginner", "intermediate", "advanced"])
					.optional()
					.describe(
						"Score for this ability level if the person mentions it. " +
							"Defaults to intermediate.",
					),
				limit: z
					.number()
					.optional()
					.describe(`How many spots to return. Defaults to ${DEFAULT_LIMIT}.`),
			},
		},
		async (args) => {
			try {
				const location = await resolveLocation(args, { fetchImpl });
				const window = resolveWindow(args);
				const radiusKm = args.radius_km ?? DEFAULT_RADIUS_KM;
				const limit = args.limit ?? DEFAULT_LIMIT;
				const skill = args.skill_level ?? "intermediate";

				const { payload } = await payloadFor(window, fetchImpl);

				const pickScore = (score) =>
					score?.scoresBySkill?.[skill] ?? score?.totalScore ?? null;

				const rows = await rankSpots({
					payload,
					location,
					window,
					radiusKm,
					travel: TRAVEL_SURF,
					scoreHour: (h) => pickScore(h.surf_score),
					scoreDay: (d) => pickScore(d.surf_score),
					describe: (hour, day) => {
						if (hour) {
							const m = hour.marine ?? {};
							const w = hour.weather ?? {};
							const wave =
								m.waveHeight != null
									? `${m.waveHeight.toFixed(1)}m`
									: "wave n/a";
							const per = m.swellPeriod != null ? `@${Math.round(m.swellPeriod)}s` : "";
							const dir = compassOf(m.swellDirection);
							const wind =
								w.windSpeed != null
									? `wind ${Math.round(w.windSpeed)}km/h ${compassOf(w.windDirection)}`
									: "wind n/a";
							return `${wave} ${per} ${dir} · ${wind}`;
						}
						const s = day?.summary ?? {};
						const wave = s.waveHeight?.avg;
						const wind = s.windSpeed?.avg;
						return (
							`${wave != null ? `${wave.toFixed(1)}m avg` : "wave n/a"} · ` +
							`${wind != null ? `wind ${Math.round(wind)}km/h avg` : "wind n/a"}` +
							" (day-level)"
						);
					},
				});

				if (!rows.length) return text(noResults(location, window, radiusKm));

				const coarse = rows.slice(0, limit).some((r) => r.resolution === "day");
				const header =
					`Best surf near ${location.name} — ${window.label} ` +
					`(${window.date}, ${String(window.fromHour).padStart(2, "0")}:00-` +
					`${String(window.toHour).padStart(2, "0")}:00)\n` +
					`Surf score 0-100 for a ${skill} surfer. ` +
					`${rows.length} spot(s) within ${radiusKm}km; best hour shown.\n` +
					"Ordered with travel taken into account, so a nearer spot can " +
					"outrank a slightly better far one. Scores are the conditions " +
					"themselves.\n";

				const footer = coarse
					? "\n\nSome rows are day-level averages — the hourly forecast for " +
						"that day was not available, so the score is a daily figure " +
						"rather than a best hour."
					: "";

				return text(`${header}\n${renderTable(rows, limit)}${footer}`);
			} catch (err) {
				return failure(err.message);
			}
		},
	);

	// ── 2. Beach ───────────────────────────────────────────────────────────
	server.registerTool(
		"find_beach_spots",
		{
			title: "Find a good beach to spend time on",
			description:
				"Rank beaches near a place by how good they will actually be to " +
				"spend time on, rather than to surf. Use this for \"where's a " +
				"good beach today\", \"nicest beach this afternoon\", " +
				"\"somewhere to take the kids\", \"somewhere out of the wind\". " +
				"This is NOT the surf score and often disagrees with it: a big " +
				"clean swell is great surf and a poor family beach. Accounts for " +
				"wind, air temperature, rain, and how sheltered each beach is " +
				"from the swell — so it can tell two beaches apart even when the " +
				"forecast gives them the same wave height. Set `audience` when " +
				"the person says who is going.",
			inputSchema: {
				...locationShape,
				...whenShape,
				audience: z
					.enum(["sitting", "swimming", "kids"])
					.optional()
					.describe(
						"Who it is for, which changes how much wave size matters. " +
							"sitting (default) — on the sand, big surf is just " +
							"scenery. swimming — going in the water. kids — small " +
							"children in the water, where anything over about a " +
							"metre rules a beach out however nice the weather.",
					),
				limit: z
					.number()
					.optional()
					.describe(`How many beaches to return. Defaults to ${DEFAULT_LIMIT}.`),
			},
		},
		async (args) => {
			try {
				const location = await resolveLocation(args, { fetchImpl });
				const window = resolveWindow(args);
				const radiusKm = args.radius_km ?? DEFAULT_RADIUS_KM;
				const limit = args.limit ?? DEFAULT_LIMIT;

				const { payload } = await payloadFor(window, fetchImpl);

				const audience = args.audience ?? "sitting";

				const rows = await rankSpots({
					payload,
					location,
					window,
					radiusKm,
					travel: TRAVEL_BEACH,
					scoreHour: (h, spot) => scoreBeachHour(h, spot, audience)?.score ?? null,
					scoreDay: (d, spot) => scoreBeachDay(d, spot, audience)?.score ?? null,
					describe: (hour, day, spot) => {
						const r = hour
							? scoreBeachHour(hour, spot, audience)
							: scoreBeachDay(day, spot, audience);
						if (!r) return "no weather data";
						return `${ratingFor(r.score)} · ${explainBeach(r)}` +
							(hour ? "" : " (day-level)");
					},
				});

				if (!rows.length) return text(noResults(location, window, radiusKm));

				const AUDIENCE_NOTE = {
					sitting: "for sitting on the beach — big surf is scenery, not a problem",
					swimming: "for swimming — wave size matters much more",
					kids: "for small children in the water — anything over about a metre rules a beach out",
				};

				const header =
					`Best beaches near ${location.name} — ${window.label} ` +
					`(${window.date})\n` +
					`Beach-day score 0-100, ${AUDIENCE_NOTE[audience]}.\n` +
					"Wave heights are what reaches each beach after shelter, not " +
					"the open-sea forecast. Ordered with travel taken into account, " +
					"so a nearer beach can outrank a slightly better far one.\n";

				return text(`${header}\n${renderTable(rows, limit)}`);
			} catch (err) {
				return failure(err.message);
			}
		},
	);

	// ── 3. One spot in detail ──────────────────────────────────────────────
	server.registerTool(
		"get_spot_forecast",
		{
			title: "Full forecast for one spot",
			description:
				"Hour-by-hour forecast and score for a single named surf spot — " +
				"waves, swell, wind, tide, air temperature and both the surf and " +
				"beach-day scores. Use when the person names a specific break " +
				'("how is Fistral looking Saturday?") rather than asking where ' +
				"to go. Also returns why the score is what it is.",
			inputSchema: {
				spot: z
					.string()
					.describe(
						'Spot name, e.g. "Watergate Bay", "Croyde", "Rhossili Bay". ' +
							"Partial names work; ambiguous ones come back as a list.",
					),
				...whenShape,
			},
		},
		async (args) => {
			try {
				const window = resolveWindow(args);
				const { payload } = await payloadFor(window, fetchImpl);
				const { match, candidates } = findSpot(payload, args.spot);

				if (!match) {
					if (!candidates.length) {
						return text(
							`No spot matching "${args.spot}". Try find_surf_spots with ` +
								"a nearby town to see what is in the dataset.",
						);
					}
					return text(
						`"${args.spot}" matches more than one spot — which one?\n\n` +
							candidates
								.map((c) => `  • ${c.name} (${c.region})`)
								.join("\n"),
					);
				}

				const day = findDay(match, window.date);
				if (!day) {
					return text(
						`No forecast for ${match.name} on ${window.date}. ` +
							"The forecast runs seven days ahead.",
					);
				}

				const lines = [
					`${match.name} — ${match.region}`,
					`${match.breakType ?? "break"}, faces ${match.faces ?? "?"}, ` +
						`best tide ${match.bestTide ?? "?"}, ${match.skillLevel ?? "all levels"}`,
					"",
					`${window.label} (${window.date})`,
				];

				if (day.day_snapshot?.headline) {
					lines.push(`Summary: ${day.day_snapshot.headline}`);
				}
				if (day.best_hour) lines.push(`Best hour for surf: ${day.best_hour}`);
				lines.push("");

				if (hasHourly(day)) {
					const hours = day.hourly.filter((h) => inWindow(h, window));
					lines.push(
						"time   surf  beach  waves          wind           air   rain    sky",
					);
					for (const h of hours) {
						const m = h.marine ?? {};
						const w = h.weather ?? {};
						const beach = scoreBeachHour(h, match);
						lines.push(
							[
								h.time.slice(11, 16).padEnd(6),
								String(h.surf_score?.totalScore ?? "-").padStart(4),
								String(beach?.score ?? "-").padStart(6),
								`  ${m.waveHeight?.toFixed(1) ?? "-"}m @${Math.round(m.swellPeriod ?? 0)}s ${compassOf(m.swellDirection)}`.padEnd(15),
								`${Math.round(w.windSpeed ?? 0)}km/h ${compassOf(w.windDirection)}`.padEnd(14),
								`${Math.round(w.temperature ?? 0)}°C`.padStart(5),
								`${(w.precipitation ?? 0).toFixed(1)}mm`.padStart(7),
								// Absent until the API serves cloud_cover; shown as
								// "-" rather than 0 so a missing field never reads
								// as a clear sky.
								(w.cloudCover == null
									? "  -"
									: `${Math.round(w.cloudCover)}%`
								).padStart(7),
							].join(""),
						);
					}
				} else {
					const s = day.summary ?? {};
					const beach = scoreBeachDay(day, match);
					lines.push(
						"Day-level only (hourly detail was not available for this day):",
						`  surf score       ${day.surf_score?.totalScore ?? "-"}/100`,
						`  beach-day score  ${beach?.score ?? "-"}/100 (${beach ? explainBeach(beach) : "no data"})`,
						`  waves            ${s.waveHeight?.min ?? "-"}-${s.waveHeight?.max ?? "-"}m`,
						`  wind             ${Math.round(s.windSpeed?.avg ?? 0)}km/h avg`,
						`  air              ${s.temperature?.min ?? "-"}-${s.temperature?.max ?? "-"}°C`,
						`  cloud            ${
							day.daily?.weather?.cloudCoverMean == null
								? "not reported"
								: `${Math.round(day.daily.weather.cloudCoverMean)}%`
						}`,
					);
				}

				const b = day.surf_score?.breakdown;
				if (b) {
					lines.push("", "Surf score breakdown (day):");
					for (const [k, v] of Object.entries(b)) {
						if (typeof v === "number") {
							lines.push(`  ${k.padEnd(22)} ${Math.round(v * 100) / 100}`);
						} else if (v && typeof v === "object") {
							lines.push(`  ${k.padEnd(22)} ${JSON.stringify(v)}`);
						}
					}
				}

				const tideDay =
					window.date === (payload.generated_at ?? "").slice(0, 10)
						? match.tides?.today
						: null;
				if (Array.isArray(tideDay) && tideDay.length) {
					lines.push(
						"",
						`Tides today: ${tideDay
							.map((t) => `${t.type ?? "?"} ${String(t.time ?? "").slice(11, 16)}`)
							.join(", ")}`,
					);
				}

				return text(lines.join("\n"));
			} catch (err) {
				return failure(err.message);
			}
		},
	);

	// ── 4. What exists ─────────────────────────────────────────────────────
	server.registerTool(
		"list_spots",
		{
			title: "List the spots in the dataset",
			description:
				"List known surf spots, optionally filtered by region or name. " +
				"Use to check coverage before telling someone a place is not " +
				'covered, or to answer "what spots are there in Wales?". Regions ' +
				"are: North Cornwall, South Cornwall, North Devon, South Devon, " +
				"Wales, Northern England, Scotland.",
			inputSchema: {
				region: z.string().optional().describe("Filter to one region."),
				contains: z
					.string()
					.optional()
					.describe("Filter to spots whose name contains this text."),
			},
		},
		async (args) => {
			try {
				const payload = await getPayload({ fetchImpl });
				let spots = payload.spots ?? [];

				if (args.region) {
					const r = args.region.toLowerCase();
					spots = spots.filter((s) => String(s.region).toLowerCase().includes(r));
				}
				if (args.contains) {
					const c = args.contains.toLowerCase();
					spots = spots.filter((s) => String(s.name).toLowerCase().includes(c));
				}
				if (!spots.length) return text("No spots matched that filter.");

				const byRegion = new Map();
				for (const s of spots) {
					if (!byRegion.has(s.region)) byRegion.set(s.region, []);
					byRegion.get(s.region).push(s);
				}

				const out = [`${spots.length} spot(s), from ${baseUrl()}`, ""];
				for (const [region, list] of byRegion) {
					out.push(`${region} (${list.length})`);
					for (const s of list) {
						out.push(
							`  ${s.name.padEnd(26)} ${s.breakType ?? ""} ` +
								`faces ${s.faces ?? "?"}  ${s.skillLevel ?? ""}`,
						);
					}
					out.push("");
				}
				return text(out.join("\n"));
			} catch (err) {
				return failure(err.message);
			}
		},
	);
}
