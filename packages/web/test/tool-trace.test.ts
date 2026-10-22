import assert from "node:assert/strict";
import test from "node:test";
import { toolTraceEvent } from "../tools/trace.ts";

test("trace keeps routing parameters but omits user text and query values", () => {
	const event = toolTraceEvent({
		type: "tool_execution_start",
		toolName: "analyze_threshold_events",
		toolCallId: "call-1",
		args: {
			table: "real_data_01",
			from: "2026-10-20T00:00:00.000Z",
			rule: { metric: "motor_temp", threshold: 80, source: "DO_NOT_LEAK", unit: "DO_NOT_LEAK" },
			query: "DO_NOT_LEAK",
		},
	});
	assert.equal(event?.type, "tool_start");
	assert.deepEqual(event?.parameters, {
		table: "real_data_01",
		from: "2026-10-20T00:00:00.000Z",
		rule: { metric: "motor_temp", threshold: 80 },
	});
	assert.ok(!JSON.stringify(event).includes("DO_NOT_LEAK"));
});

test("successful trace exposes result metadata without raw records or arbitrary strings", () => {
	const event = toolTraceEvent({
		type: "tool_execution_end",
		toolName: "read_industrial_dashboard",
		toolCallId: "call-2",
		isError: false,
		durationMs: 12,
		result: {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						ok: true,
						evidenceId: "11111111-1111-4111-8111-111111111111",
						result: {
							returned: 100,
							rows: [["DO_NOT_LEAK"]],
							latest: { secret: "DO_NOT_LEAK" },
							warnings: ["DO_NOT_LEAK"],
						},
					}),
				},
			],
		},
	});
	assert.equal(event?.ok, true);
	assert.deepEqual(event?.summary, { returned: 100 });
	assert.equal(event?.evidenceId, "11111111-1111-4111-8111-111111111111");
	assert.ok(!JSON.stringify(event).includes("DO_NOT_LEAK"));
});

test("framework error remains failure even without an application envelope", () => {
	const event = toolTraceEvent({
		type: "tool_execution_end",
		toolName: "summarize_metrics",
		toolCallId: "call-3",
		isError: true,
		result: { content: [{ type: "text", text: "Invalid parameters: DO_NOT_LEAK" }] },
	});
	assert.equal(event?.ok, false);
	assert.ok(!JSON.stringify(event).includes("DO_NOT_LEAK"));
});

test("unrelated stream events do not become tool traces", () => {
	assert.equal(toolTraceEvent({ type: "message_update", text: "DO_NOT_LEAK" }), null);
});

test("trace preserves explicit timezone offsets for semantic acceptance checks", () => {
	const event = toolTraceEvent({
		type: "tool_execution_start",
		toolName: "summarize_metrics",
		args: { from: "2026-10-22T00:16:32.000+08:00", to: "2026-10-21T16:19:32.000Z" },
	});
	assert.deepEqual(event?.parameters, { from: "2026-10-22T00:16:32.000+08:00", to: "2026-10-21T16:19:32.000Z" });
});
