/**
 * Turning "tomorrow afternoon" into a date and a range of hours.
 *
 * TIMEZONES
 * ---------
 * Forecast hours arrive as bare local strings — "2026-08-26T10:00", no offset.
 * Parsing those with `new Date()` reinterprets them in whatever zone the
 * function happens to run in, which on Netlify is UTC, and a British Summer
 * Time afternoon quietly slides an hour. So hours are read straight out of the
 * string, exactly as `good-for.js` does in the surf API. Same convention, same
 * reason.
 */

/** Segments of the day, as hour ranges [from, to). */
export const PARTS = {
	morning: [6, 12],
	afternoon: [12, 18],
	evening: [18, 21],
	all_day: [6, 21],
};

/** Read the hour out of "2026-08-26T10:00" without constructing a Date. */
export function hourOf(timeStr) {
	if (typeof timeStr !== "string" || timeStr.length < 13) return null;
	const h = Number.parseInt(timeStr.slice(11, 13), 10);
	return Number.isFinite(h) ? h : null;
}

/** Read the date out of "2026-08-26T10:00". */
export function dateOf(timeStr) {
	return typeof timeStr === "string" && timeStr.length >= 10
		? timeStr.slice(0, 10)
		: null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in the given IANA zone, as YYYY-MM-DD. */
export function todayIn(timeZone = "Europe/London", now = new Date()) {
	// en-CA formats as YYYY-MM-DD, which saves reassembling the parts.
	return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

/** The current hour in the given zone, 0-23. */
export function hourIn(timeZone = "Europe/London", now = new Date()) {
	return Number.parseInt(
		new Intl.DateTimeFormat("en-GB", {
			timeZone,
			hour: "2-digit",
			hour12: false,
		}).format(now),
		10,
	);
}

function addDays(isoDate, days) {
	const d = new Date(`${isoDate}T12:00:00Z`); // midday avoids DST edges
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * Resolve the requested time into a concrete date and hour window.
 *
 * `date` accepts "today", "tomorrow" or an explicit YYYY-MM-DD. Weekday names
 * are deliberately NOT accepted: Claude already knows what date Saturday is and
 * can pass it, whereas guessing here means guessing which Saturday.
 *
 * @returns {{date: string, fromHour: number, toHour: number, label: string}}
 */
export function resolveWindow(
	{ date, part_of_day } = {},
	{ timeZone = "Europe/London", now = new Date() } = {},
) {
	const today = todayIn(timeZone, now);

	let resolved;
	if (!date || date === "today") resolved = today;
	else if (date === "tomorrow") resolved = addDays(today, 1);
	else if (ISO_DATE.test(date)) resolved = date;
	else {
		throw new Error(
			`Could not read the date "${date}". Use "today", "tomorrow", or ` +
				"an exact date as YYYY-MM-DD.",
		);
	}

	// "now" means the next few hours, and only makes sense today.
	if (part_of_day === "now") {
		if (resolved !== today) {
			throw new Error('part_of_day "now" only applies to today.');
		}
		const h = hourIn(timeZone, now);
		return {
			date: resolved,
			fromHour: h,
			toHour: Math.min(24, h + 3),
			label: "the next few hours",
		};
	}

	const part = part_of_day ?? "all_day";
	const range = PARTS[part];
	if (!range) {
		throw new Error(
			`Unknown part_of_day "${part}". Use one of: ` +
				`${Object.keys(PARTS).join(", ")}, now.`,
		);
	}

	const dayLabel =
		resolved === today
			? "today"
			: resolved === addDays(today, 1)
				? "tomorrow"
				: resolved;

	return {
		date: resolved,
		fromHour: range[0],
		toHour: range[1],
		label: part === "all_day" ? dayLabel : `${dayLabel} ${part}`,
	};
}

/** Does this forecast hour fall inside the window? */
export function inWindow(hour, window) {
	const h = hourOf(hour.time);
	return (
		dateOf(hour.time) === window.date &&
		h != null &&
		h >= window.fromHour &&
		h < window.toHour
	);
}
