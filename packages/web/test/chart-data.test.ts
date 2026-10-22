import assert from "node:assert/strict";
import test from "node:test";
import { validateChartArtifact } from "../chart-contracts.ts";
import { compareMetricWindows, getCodeEvents } from "../tools/analytics.ts";
import { buildChart } from "../tools/charts.ts";
import { chartFixture } from "./chart-fixture.ts";

const base = { evidenceId: "11111111-1111-4111-8111-111111111111", metrics: ["motor_temp" as const] };

test("corrupt time coordinates and query options cannot enter the renderer", () => {
	const chart = buildChart({ ...base, kind: "line" }, chartFixture());
	chart.rows[0][0] = "not-a-date";
	assert.throws(() => validateChartArtifact(chart));
	const second = buildChart({ ...base, kind: "line" }, chartFixture());
	assert.throws(() =>
		validateChartArtifact({ ...second, request: { ...second.request, bucketSeconds: "injected text" } }),
	);
	assert.throws(() => validateChartArtifact({ ...second, displayRows: [] }));
});
test("comparison and code bar charts preserve program-calculated category meanings", () => {
	const a = chartFixture(),
		b = chartFixture([10, null, 12, 13, 14]);
	const compared = buildChart(
		{ ...base, kind: "bar" },
		{
			type: "comparison",
			windows: [a.window, b.window],
			result: compareMetricWindows(a.window, b.window, ["motor_temp"]),
		},
	);
	assert.deepEqual(compared.rows, [
		["A", 2.25],
		["B", 12.25],
	]);
	const defaults = buildChart(
		{ evidenceId: base.evidenceId, kind: "bar" },
		{
			type: "comparison",
			windows: [a.window, b.window],
			result: compareMetricWindows(a.window, b.window, ["motor_temp"]),
		},
	);
	assert.deepEqual(defaults.request.metrics, ["motor_temp"]);
	a.window.availableFields.push("fault_code", "alarm_code");
	for (const [index, record] of a.window.records.entries()) {
		record.raw.fault_code = index < 3 ? "F1" : 0;
		record.raw.alarm_code = 0;
	}
	const codes = buildChart(
		{ evidenceId: base.evidenceId, kind: "bar" },
		{ type: "code_events", window: a.window, result: getCodeEvents(a.window) },
	);
	assert.deepEqual(codes.rows, [["故障 F1", 1]]);
	assert.throws(
		() =>
			buildChart(
				{ evidenceId: base.evidenceId, kind: "bar" },
				{ type: "code_events", window: a.window, result: { ...getCodeEvents(a.window), codesTruncated: true } },
			),
		/截断/,
	);
});

test("line keeps zero and missing values; source metadata is a frozen query scope", () => {
	const chart = buildChart({ ...base, kind: "line" }, chartFixture());
	assert.deepEqual(
		chart.rows.map((row) => row[1]),
		[0, null, 2, 3, 4],
	);
	assert.equal(chart.series[0].unit, null);
	assert.equal(chart.sources[0].kind, "simulation");
	assert.equal(chart.sources[0].from, "2026-10-21T16:00:00.000Z");
});
test("scatter pairs fields in the same row and reports excluded pairs", () => {
	const chart = buildChart({ ...base, kind: "scatter", xMetric: "current_actual" }, chartFixture());
	assert.deepEqual(
		chart.rows.map((row) => row.slice(1)),
		[
			[0, 0],
			[4, 2],
			[8, 4],
		],
	);
	assert.equal(chart.excluded, 2);
});
test("histogram counts the whole valid window, includes maximum and handles a constant", () => {
	for (const source of [chartFixture(), chartFixture([2, 2, 2, 2, 2])]) {
		const chart = buildChart({ ...base, kind: "histogram", bins: 5 }, source);
		assert.equal(
			chart.rows.reduce((sum, row) => sum + Number(row[1]), 0),
			source.window.records.filter((row) => row.values.motor_temp !== null).length,
		);
		assert.ok(chart.rows.some((row) => Number(row[1]) > 0));
		assert.match(chart.title, /电机温度/);
	}
});
test("bucket bars compute actual mean and keep empty buckets unknown", () => {
	const chart = buildChart({ ...base, kind: "bar", bucketSeconds: 10, aggregation: "mean" }, chartFixture());
	assert.deepEqual(
		chart.rows.map((row) => row[1]),
		[0, null, 2, 3.5],
	);
});
test("invalid combinations, missing fields, empty data and unsupported evidence are rejected", () => {
	assert.throws(() => buildChart({ ...base, kind: "scatter" }, chartFixture()), /横轴/);
	assert.throws(() => buildChart({ ...base, kind: "line", xMetric: "current_actual" }, chartFixture()), /散点/);
	assert.throws(() => buildChart({ ...base, kind: "histogram", bins: 51 }, chartFixture()), /箱/);
	assert.throws(() => buildChart({ ...base, kind: "line", metrics: ["dc_voltage"] }, chartFixture()), /字段/);
	assert.throws(() => buildChart({ ...base, kind: "line" }, chartFixture([null, null])), /有效/);
});
test("line sampling preserves spikes and null boundaries or rejects excessive gaps", () => {
	const source = chartFixture(Array.from({ length: 6000 }, (_, i) => (i === 3101 ? 1000 : 1)));
	source.window.to = new Date(Date.parse(source.window.from) + 5999 * 10000).toISOString();
	const chart = buildChart({ ...base, kind: "line" }, source);
	assert.ok(chart.displayRows.length <= 2000);
	assert.ok(chart.displayRows.some((row) => row[1] === 1000));
	assert.equal(chart.rows.length, 6000);
	const gaps = chartFixture(Array.from({ length: 6000 }, (_, i) => (i % 2 ? null : i)));
	gaps.window.to = source.window.to;
	assert.throws(() => buildChart({ ...base, kind: "line" }, gaps), /断点|范围/);
});
