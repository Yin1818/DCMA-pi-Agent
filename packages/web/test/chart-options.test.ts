import assert from "node:assert/strict";
import test from "node:test";
import { chartRequery, chartZoomViewport, createChartOptions } from "../src/chart-options.ts";
import { buildChart } from "../tools/charts.ts";
import { chartFixture } from "./chart-fixture.ts";

test("line options use separate metric panels and missing values stay disconnected", () => {
	const chart = buildChart(
		{ evidenceId: "11111111-1111-4111-8111-111111111111", kind: "line", metrics: ["motor_temp", "current_actual"] },
		chartFixture(),
	);
	const option = createChartOptions(chart, 390);
	assert.equal((option.grid as unknown[]).length, 2);
	assert.equal((option.series as { connectNulls: boolean }[])[0].connectNulls, false);
	assert.ok(JSON.stringify(option).includes("单位未确认"));
});
test("scatter and histogram map the real paired/bin values", () => {
	for (const kind of ["scatter", "histogram"] as const) {
		const chart = buildChart(
			{
				evidenceId: "11111111-1111-4111-8111-111111111111",
				kind,
				metrics: ["motor_temp"],
				...(kind === "scatter" ? { xMetric: "current_actual" as const } : {}),
			},
			chartFixture(),
		);
		const option = createChartOptions(chart, 800);
		assert.equal((option.series as { type: string }[])[0].type, kind === "scatter" ? "scatter" : "bar");
		if (kind === "histogram") assert.match((option.xAxis as { name: string }[])[0].name, /电机温度.*单位未确认/);
	}
});
test("export transfers only the zoom viewport and requery retains A/B metrics", () => {
	assert.deepEqual(chartZoomViewport([{ start: 20, end: 75, bottom: 10 }]), [{ start: 20, end: 75 }]);
	const chart = buildChart(
		{ evidenceId: "11111111-1111-4111-8111-111111111111", kind: "line", metrics: ["motor_temp"] },
		chartFixture(),
	);
	chart.sources.push({ ...chart.sources[0] });
	assert.match(chartRequery(chart), /A\/B.*均值/);
	assert.match(chartRequery(chart), /motor_temp/);
	assert.doesNotMatch(chartRequery(chart), /代码事件/);
});
