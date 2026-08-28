/**
 * The MCP endpoint.
 *
 * Stateless by design: the MCP 2026-07-28 spec makes stateless HTTP the
 * recommended transport, which is what lets an MCP server be an ordinary
 * serverless function with no session store, no sticky routing and no shared
 * state between invocations.
 *
 * WHY THE WEB-STANDARD TRANSPORT
 * ------------------------------
 * Netlify's own guide, and most examples still online, wrap the Node transport
 * with `fetch-to-node` — translating the incoming Request into a fake
 * `http.IncomingMessage`, letting the transport write to a fake ServerResponse,
 * then translating back. That was the only option when those were written.
 *
 * It also did not work here: every POST came back 400 with an empty body,
 * because something in that round trip loses what the transport needs to
 * validate a request. Since SDK 1.30 the Web-standard transport is the real
 * implementation and the Node one is a thin adapter over it, so a runtime that
 * already speaks Request/Response — Netlify Functions, Workers, Deno — should
 * talk to it directly. One less dependency and one less layer to be wrong.
 *
 * WHY GET IS HANDLED HERE AND NOT BY THE TRANSPORT
 * -----------------------------------------------
 * An MCP client may open a listening stream with `GET` + `Accept:
 * text/event-stream`, so the server can push messages it did not ask for.
 * Handing that to the transport opens a stream that never closes — measured,
 * not assumed: reading the body of that Response never settles. On a
 * serverless platform that is the one thing a handler must not do; the
 * function would hang until the platform killed it.
 *
 * The spec's answer for a server that offers no server-initiated stream is an
 * explicit `405`, which tells the client to stop asking and use POST. An
 * earlier version answered that request with `200 application/json` — neither
 * a stream nor a refusal — and a connector that tried to open one was left
 * with a response it could not interpret.
 *
 * A fresh McpServer and transport are built per request. That looks wasteful
 * and is not: construction is cheap, and reusing them across invocations is
 * how a serverless MCP server leaks one caller's session into another's. The
 * only thing deliberately kept across warm invocations is the cached forecast
 * payload in upstream.js, which is shared read-only data, not per-caller state.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { buildServer } from "../../src/server.js";

/** Refuse a method, the way a protocol client expects to be refused. */
const refuse = (message) =>
	new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code: -32000, message },
			id: null,
		}),
		{
			status: 405,
			headers: { "content-type": "application/json", allow: "POST" },
		},
	);

export default async (req) => {
	const accept = req.headers.get("accept") ?? "";

	if (req.method === "GET") {
		// A client trying to open a listening stream. Say no, clearly.
		if (accept.includes("text/event-stream")) {
			return refuse(
				"This server does not offer a server-initiated SSE stream. Send requests as POST.",
			);
		}
		// A browser or a health check. Say something useful.
		return new Response(
			JSON.stringify({
				name: "surf-forecast",
				transport: "streamable-http",
				hint: "POST JSON-RPC here, or add this URL as a custom connector in Claude.",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}

	// DELETE terminates a session. There are no sessions to terminate.
	if (req.method !== "POST") {
		return refuse(`${req.method} is not supported. Send requests as POST.`);
	}

	const server = buildServer();
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined, // stateless
		// Answer as plain JSON rather than opening an SSE stream. A serverless
		// function is billed and killed by wall-clock time, so holding a
		// stream open is the one thing it must not do.
		enableJsonResponse: true,
	});

	try {
		await server.connect(transport);
		const res = await transport.handleRequest(req);

		// Read the body out before the transport is closed. Locally it survived
		// either way, but on a serverless platform the body can be read after
		// the handler returns, and a closed transport cannot produce it then.
		// This is the kind of difference that only shows up in production, so
		// it is not worth leaving to chance.
		const body = await res.text();
		return new Response(body || null, {
			status: res.status,
			headers: res.headers,
		});
	} catch (err) {
		console.error("MCP request failed:", err);
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32603, message: `Internal error: ${err.message}` },
				id: null,
			}),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	} finally {
		await server.close().catch(() => {});
	}
};

export const config = { path: "/mcp" };
