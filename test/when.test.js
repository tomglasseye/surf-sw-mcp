import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveWindow, hourOf, dateOf, inWindow, todayIn } from "../src/when.js";

test("hours are read from the string, not parsed as dates", () => {
	// Forecast times carry no offset. Netlify runs in UTC; the forecast is
	// British local. Parsing with Date() slides a BST afternoon by an hour and
	// silently returns the wrong window.
	assert.equal(hourOf("2026-08-26T10:00"), 10);
	assert.equal(dateOf("2026-08-26T10:00"), "2026-08-26");
	assert.equal(hourOf("2026-08-26T00:00"), 0);
	assert.equal(hourOf("nope"), null);
	assert.equal(hourOf(null), null);
});

test("REGRESSION: a BST afternoon hour keeps its local value", () => {
	// 2026-08-26 is inside British Summer Time (UTC+1). Read as UTC and
	// converted to local, 14:00 would come back as 15:00.
	const h = "2026-08-26T14:00";
	assert.equal(hourOf(h), 14);
	assert.notEqual(hourOf(h), new Date(h).getHours() + 1);
});

const NOW = new Date("2026-08-26T09:30:00Z");

test("today and tomorrow resolve against the forecast's timezone", () => {
	assert.equal(resolveWindow({}, { now: NOW }).date, "2026-08-26");
	assert.equal(resolveWindow({ date: "today" }, { now: NOW }).date, "2026-08-26");
	assert.equal(resolveWindow({ date: "tomorrow" }, { now: NOW }).date, "2026-08-27");
	assert.equal(resolveWindow({ date: "2026-09-01" }, { now: NOW }).date, "2026-09-01");
});

test("parts of the day map to hour ranges", () => {
	const m = resolveWindow({ part_of_day: "morning" }, { now: NOW });
	assert.deepEqual([m.fromHour, m.toHour], [6, 12]);
	const a = resolveWindow({ part_of_day: "afternoon" }, { now: NOW });
	assert.deepEqual([a.fromHour, a.toHour], [12, 18]);
	const all = resolveWindow({}, { now: NOW });
	assert.deepEqual([all.fromHour, all.toHour], [6, 21]);
});

test('"now" means the next few hours and only applies today', () => {
	const w = resolveWindow({ part_of_day: "now" }, { now: NOW });
	assert.equal(w.fromHour, 10); // 09:30 UTC = 10:30 BST
	assert.equal(w.toHour, 13);
	assert.throws(
		() => resolveWindow({ date: "tomorrow", part_of_day: "now" }, { now: NOW }),
		/only applies to today/,
	);
});

test("labels read naturally so the answer can quote them", () => {
	assert.equal(resolveWindow({}, { now: NOW }).label, "today");
	assert.equal(
		resolveWindow({ date: "tomorrow", part_of_day: "morning" }, { now: NOW }).label,
		"tomorrow morning",
	);
	assert.equal(
		resolveWindow({ date: "2026-09-05", part_of_day: "afternoon" }, { now: NOW }).label,
		"2026-09-05 afternoon",
	);
});

test("bad input is refused with something a person can act on", () => {
	assert.throws(() => resolveWindow({ date: "Saturday" }, { now: NOW }), /YYYY-MM-DD/);
	assert.throws(() => resolveWindow({ date: "26/08/2026" }, { now: NOW }), /YYYY-MM-DD/);
	assert.throws(
		() => resolveWindow({ part_of_day: "lunchtime" }, { now: NOW }),
		/Unknown part_of_day/,
	);
});

test("inWindow matches on both date and hour", () => {
	const w = resolveWindow({ date: "2026-08-26", part_of_day: "morning" }, { now: NOW });
	assert.ok(inWindow({ time: "2026-08-26T06:00" }, w));
	assert.ok(inWindow({ time: "2026-08-26T11:00" }, w));
	assert.ok(!inWindow({ time: "2026-08-26T12:00" }, w), "toHour is exclusive");
	assert.ok(!inWindow({ time: "2026-08-26T05:00" }, w));
	assert.ok(!inWindow({ time: "2026-08-27T09:00" }, w), "wrong day");
});

test("todayIn uses the given zone", () => {
	// 23:30 UTC on the 26th is already the 27th in Sydney.
	const late = new Date("2026-08-26T23:30:00Z");
	assert.equal(todayIn("Europe/London", late), "2026-08-27"); // BST is UTC+1
	assert.equal(todayIn("UTC", late), "2026-08-26");
});
