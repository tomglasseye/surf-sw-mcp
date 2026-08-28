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
 * A fresh McpServer and transport are built per request. That looks wasteful
 * and is not: construction is cheap, and reusing them across invocations is
 * how a serverless MCP server leaks one caller's session into another's. The
 * only thing deliberately kept across warm invocations is the cached forecast
 * payload in upstream.js, which is shared read-only data, not per-caller state.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { buildServer } from "../../src/server.js";

export default async (req) => {
	if (req.method === "GET") {
		// Clients and humans both probe with GET before anything else.
		// "Method not allowed" reads like a broken deploy.
		return new Response(
			JSON.stringify({
				name: "surf-forecast",
				transport: "streamable-http",
				hint: "POST JSON-RPC here, or add this URL as a custom connector in Claude.",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}

	if (req.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
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
		return await transport.handleRequest(req);
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
		// Release the per-request server even when handleRequest threw.
		await server.close().catch(() => {});
	}
};

export const config = { path: "/mcp" };
