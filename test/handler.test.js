/**
 * Tests the Netlify function itself.
 *
 * Everything in tools.test.js runs the server over an in-memory transport.
 * That proves the tools work; it does not prove the thing Netlify actually
 * invokes works. Between the two sits the whole HTTP layer — the streamable
 * transport, the JSON-RPC framing, the method routing — and this project's
 * recurring bug is precisely a unit passing while the production path does
 * something else.
 *
 * Both bugs this file has caught were invisible to every other test: the
 * fetch-to-node round trip returning 400 on every POST, and a GET asking for
 * an event stream being answered with a JSON document.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import handler, { config } from "../netlify/functions/mcp.js";
import { clearCache } from "../src/upstream.js";
import { stubFetch } from "./fixture.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
	clearCache();
	// The handler builds its own server, so it uses global fetch — stub that
	// rather than injecting, because using global fetch IS the production path.
	globalThis.fetch = stubFetch();
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const post = (body) =>
	handler(
		new Request("https://example.netlify.app/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
		}),
	);

/**
 * Read a JSON-RPC result out of the response, whichever framing came back.
 *
 * The streamable transport may answer as plain JSON or as a single SSE event
 * depending on negotiation, and a test that only understood one framing would
 * pass or fail for reasons unrelated to the server.
 */
async function rpcResult(res) {
	const body = await res.text();
	if (body.includes("data:")) {
		const line = body.split("\n").find((l) => l.startsWith("data:"));
		return JSON.parse(line.slice(5).trim());
	}
	return JSON.parse(body);
}

const INIT = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	},
};

test("the function is mounted at /mcp", () => {
	// Netlify reads the path from this export. Getting it wrong deploys a
	// working server at a URL nobody will call.
	assert.equal(config.path, "/mcp");
});

test("initialize returns a valid handshake over HTTP", async () => {
	const res = await post(INIT);
	assert.equal(res.status, 200);

	const msg = await rpcResult(res);
	assert.equal(msg.jsonrpc, "2.0");
	assert.equal(msg.id, 1);
	assert.ok(msg.result, `expected a result, got ${JSON.stringify(msg)}`);
	assert.equal(msg.result.serverInfo.name, "surf-forecast");
	assert.ok(msg.result.capabilities.tools, "must advertise tool support");
});

test("tools/list works through the real HTTP handler", async () => {
	const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert.equal(res.status, 200);

	const msg = await rpcResult(res);
	const names = msg.result.tools.map((t) => t.name).sort();
	assert.deepEqual(names, [
		"find_beach_spots",
		"find_surf_spots",
		"get_spot_forecast",
		"list_spots",
	]);
});

test("a tool call round-trips end to end", async () => {
	const res = await post({
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "find_beach_spots", arguments: { near: "Newquay" } },
	});
	assert.equal(res.status, 200);

	const msg = await rpcResult(res);
	const text = msg.result.content.map((c) => c.text).join("");
	assert.match(text, /Warm Cove/);
	assert.match(text, /Beach-day score/);
});

test("a plain GET answers rather than 405-ing", async () => {
	// A browser or a health check. "Method not allowed" reads like a broken
	// deploy to a human.
	const res = await handler(
		new Request("https://example.netlify.app/mcp", { method: "GET" }),
	);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.name, "surf-forecast");
});

test("REGRESSION: a GET asking for a stream is refused with 405", async () => {
	// This is how an MCP client opens a listening SSE stream, and two separate
	// things go wrong if it is not refused right here.
	//
	// Passing it to the transport opens a stream that never closes — reading
	// that Response's body never settles — and a serverless function that does
	// not return gets killed by the platform.
	//
	// Answering it with the friendly 200 JSON above is worse in a quieter way:
	// the client asked for an event stream and got a JSON document, which is
	// neither a stream nor a refusal, and it has nothing sensible to do with
	// that. A connector added against such a server simply fails to connect,
	// with no clue as to why.
	//
	// 405 is what the spec prescribes for a server offering no server-initiated
	// stream, and it tells the client to carry on with POST.
	const res = await handler(
		new Request("https://example.netlify.app/mcp", {
			method: "GET",
			headers: { accept: "text/event-stream" },
		}),
	);
	assert.equal(res.status, 405);
	assert.equal(res.headers.get("allow"), "POST");
	const body = await res.json();
	assert.equal(body.jsonrpc, "2.0");
	assert.match(body.error.message, /POST/);
});

test("other methods are refused as JSON-RPC, not bare text", async () => {
	for (const method of ["PUT", "DELETE", "PATCH"]) {
		const res = await handler(
			new Request("https://example.netlify.app/mcp", { method }),
		);
		assert.equal(res.status, 405, `${method} should be 405`);
		const body = await res.json();
		assert.equal(body.jsonrpc, "2.0", `${method} should answer JSON-RPC`);
	}
});

test("a POST never answers with an open stream", async () => {
	// enableJsonResponse is what keeps this true. If it ever stops being true
	// the handler will hang trying to buffer a stream that does not end, and
	// the symptom will be a function timeout rather than an error.
	const res = await post(INIT);
	const type = res.headers.get("content-type") ?? "";
	assert.ok(
		!type.includes("text/event-stream"),
		`POST answered with ${type}, which this handler cannot buffer`,
	);
});

test("malformed JSON produces a JSON-RPC parse error, not a crash", async () => {
	const res = await handler(
		new Request("https://example.netlify.app/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: "{ not json",
		}),
	);
	assert.equal(res.status, 400);
	const body = await res.json();
	assert.equal(body.jsonrpc, "2.0");
	assert.equal(body.error.code, -32700, "should be the JSON-RPC parse error code");
});

test("a request without the right Accept header is refused clearly", async () => {
	// The transport requires the client to accept BOTH application/json and
	// text/event-stream, and rejects before parsing the body. Worth pinning:
	// it is the first thing that bites anyone testing by hand with curl, and
	// the 406 looks like a broken deploy if you do not know to expect it.
	const res = await handler(
		new Request("https://example.netlify.app/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		}),
	);
	assert.equal(res.status, 406);
	const body = await res.json();
	assert.match(body.error.message, /must accept both/i);
});

test("each request gets a fresh stateless server", async () => {
	// Two independent initialize calls must both succeed. If state leaked
	// between invocations — the classic serverless MCP mistake — the second
	// would fail with "already initialized".
	const a = await rpcResult(await post(INIT));
	const b = await rpcResult(await post({ ...INIT, id: 99 }));
	assert.ok(a.result, "first initialize should succeed");
	assert.ok(b.result, `second initialize should succeed, got ${JSON.stringify(b)}`);
	assert.equal(b.id, 99);
});
