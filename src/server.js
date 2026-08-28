/**
 * Builds a configured MCP server.
 *
 * Kept separate from the Netlify handler so the same server can be driven by
 * tests over a plain in-memory transport. The bug this guards against is the
 * one that keeps recurring in this project: a unit passing its own tests while
 * the path production actually takes does something else.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "./tools.js";

export function buildServer({ fetchImpl } = {}) {
	const server = new McpServer(
		{
			name: "surf-forecast",
			version: "0.1.0",
		},
		{
			instructions:
				"Surf and beach conditions for the UK — Cornwall, Devon, Wales, " +
				"northern England and Scotland. Use find_surf_spots when someone " +
				"wants waves, find_beach_spots when they want a pleasant beach to " +
				"spend time on (these often disagree, which is the point), and " +
				"get_spot_forecast when they name a break. Scores are 0-100. " +
				"Always say which day and part of day an answer refers to, " +
				"because conditions change hour to hour.",
		},
	);

	registerTools(server, { fetchImpl });
	return server;
}
