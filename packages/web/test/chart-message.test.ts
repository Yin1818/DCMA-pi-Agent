import assert from "node:assert/strict";
import test from "node:test";
import { streamChat } from "../src/api.ts";
import { loadWorkspace, storageKey } from "../src/storage.ts";
import { chartToolEvent } from "../tools/chart-stream.ts";

const chart = { version: 1 as const, id: "11111111-1111-4111-8111-111111111111" };
test("only successful saved chart tools emit references", () => {
	const event = {
		type: "tool_execution_end",
		toolName: "create_analysis_chart",
		isError: false,
		result: { details: { chart } },
	};
	assert.deepEqual(chartToolEvent(event), { type: "chart", chart });
	assert.equal(chartToolEvent({ ...event, isError: true }), null);
	assert.equal(chartToolEvent({ ...event, toolName: "summarize_metrics" }), null);
	assert.equal(chartToolEvent({ ...event, result: { details: { chart: { version: 1, id: "../file" } } } }), null);
});
test("stream preserves a validated chart before a later error and ignores forged invalid refs", async (context) => {
	context.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				[
					JSON.stringify({ type: "chart", chart }),
					JSON.stringify({ type: "chart", chart: { version: 1, id: "bad" } }),
					JSON.stringify({ type: "error", message: "stopped" }),
				].join("\n"),
			),
	);
	const refs: unknown[] = [];
	await assert.rejects(
		streamChat(
			{},
			new AbortController().signal,
			() => {},
			(reference) => refs.push(reference),
		),
		/stopped/,
	);
	assert.deepEqual(refs, [chart]);
});
test("history restores valid chart refs once and keeps plain messages", (context) => {
	const saved = {
		activeId: "c",
		conversations: [
			{
				id: "c",
				title: "test",
				time: "2026-10-22",
				deviceId: "real_data_01",
				messages: [
					{
						id: "m",
						role: "assistant",
						timestamp: "2026-10-22",
						content: "answer",
						status: "done",
						charts: [chart, chart, { version: 1, id: "bad" }],
					},
					{ id: "plain", role: "user", timestamp: "2026-10-22", content: "hello" },
				],
			},
		],
	};
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (key: string) => (key === storageKey ? JSON.stringify(saved) : null) },
	});
	context.after(() => {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});
	const state = loadWorkspace();
	assert.deepEqual(state.conversations[0].messages[0].charts, [chart]);
	assert.equal(state.conversations[0].messages[1].content, "hello");
});
