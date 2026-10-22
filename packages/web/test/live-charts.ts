/** Explicit real-provider acceptance. Never included in the offline test command. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type ChartArtifact, validateChartArtifact } from "../chart-contracts.ts";

if (process.env.DCMA_RUN_LIVE_ACCEPTANCE !== "1") throw new Error("真实验收须显式启用DCMA_RUN_LIVE_ACCEPTANCE=1。");
const base = "http://127.0.0.1:3000";
const response = await fetch(`${base}/api/database/dashboard?table=real_data_01&limit=50`, {
	signal: AbortSignal.timeout(20000),
});
assert.equal(response.status, 200);
const snapshot = (await response.json()) as { latest?: { acquiredAt: string | null } };
assert.ok(snapshot.latest?.acquiredAt);
const to = snapshot.latest.acquiredAt,
	from = new Date(Date.parse(to) - 180000).toISOString();
const range = `UTC ${from}至${to}`;
const cases = [
	{ kind: "line", text: `画${range}的电机温度原始折线图，注明来源与时间，单位未知就注明。` },
	{ kind: "scatter", text: `用${range}同一采样的实际电流作横轴、电机温度作纵轴，画散点图，不推断因果。` },
	{ kind: "bar", text: `将${range}的实际电流按60秒分桶计算采样均值，画柱状图。` },
	{ kind: "histogram", text: `画${range}电机温度分布的直方图，分10个箱，用整个窗口的有效数据。` },
];
const selected = process.argv.slice(2);
const directory = fileURLToPath(new URL("../.dcma-runtime/acceptance/", import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = `${directory}/charts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const results: Record<string, unknown>[] = [];
for (const item of cases.filter((item) => !selected.length || selected.includes(item.kind))) {
	const events: Record<string, unknown>[] = [];
	let answer = "",
		failure: string | null = null;
	const artifacts: ChartArtifact[] = [];
	try {
		const response = await fetch(`${base}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-DCMA-Client": "web" },
			body: JSON.stringify({
				model: "deepseek/deepseek-flash",
				database: true,
				table: "real_data_01",
				context: "当前来源dcma.real_data_01，为模拟采样。",
				text: item.text,
				history: [],
			}),
			signal: AbortSignal.timeout(125000),
		});
		assert.equal(response.status, 200);
		const body = await response.text();
		for (const line of body.split("\n").filter(Boolean)) {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (event.type === "delta") answer += String(event.text);
			else events.push(event);
		}
		assert.ok(events.some((event) => event.type === "done"));
		assert.ok(!events.some((event) => event.type === "error" || (event.type === "tool_end" && event.ok !== true)));
		const refs = events.filter((event) => event.type === "chart");
		assert.equal(refs.length, 1);
		for (const event of refs) {
			const id = (event.chart as { id: string }).id;
			const saved = await fetch(`${base}/api/tools/charts/${id}.json`);
			assert.equal(saved.status, 200);
			const chart = validateChartArtifact(await saved.json());
			assert.equal(chart.kind, item.kind);
			assert.equal(chart.sources[0].from, from);
			assert.equal(chart.sources[0].to, to);
			const csv = await fetch(`${base}/api/tools/charts/${id}.csv`);
			assert.equal(csv.status, 200);
			assert.ok((await csv.text()).length > 30);
			const rejected = await fetch(`${base}/api/tools/charts/${id}.json`, { method: "POST" });
			assert.equal(rejected.status, 405);
			const invalid = await fetch(`${base}/api/tools/charts/not-a-valid-id.json`);
			assert.equal(invalid.status, 404);
			const query = new URLSearchParams({ table: "real_data_01", from, to, limit: "200", page: "1" });
			const history = (await (await fetch(`${base}/api/database/sample-history?${query}`)).json()) as {
				total: number;
				hasMore: boolean;
				samples: { acquiredAt: string; values: { motor_temp: number | null; current_actual: number | null } }[];
			};
			assert.equal(history.hasMore, false);
			assert.equal(chart.sourceRecords, history.total);
			if (item.kind === "line")
				assert.deepEqual(
					chart.rows,
					history.samples.map((row) => [row.acquiredAt, row.values.motor_temp]),
				);
			if (item.kind === "scatter")
				assert.deepEqual(
					chart.rows,
					history.samples
						.filter((row) => row.values.motor_temp !== null && row.values.current_actual !== null)
						.map((row) => [row.acquiredAt, row.values.current_actual, row.values.motor_temp]),
				);
			if (item.kind === "histogram")
				assert.equal(
					chart.rows.reduce((sum, row) => sum + Number(row[1]), 0),
					history.samples.filter((row) => row.values.motor_temp !== null).length,
				);
			if (item.kind === "bar")
				for (let index = 0; index < chart.rows.length; index++) {
					const start = Date.parse(from) + index * 60000,
						end = Math.min(Date.parse(to), start + 60000);
					const values = history.samples
						.filter(
							(row) =>
								Date.parse(row.acquiredAt) >= start &&
								(index === chart.rows.length - 1
									? Date.parse(row.acquiredAt) <= end
									: Date.parse(row.acquiredAt) < end) &&
								row.values.current_actual !== null,
						)
						.map((row) => row.values.current_actual!);
					const mean = values.reduce((a, b) => a + b, 0) / values.length;
					assert.ok(
						values.length ? Math.abs(Number(chart.rows[index][1]) - mean) < 1e-8 : chart.rows[index][1] === null,
					);
				}
			artifacts.push(chart);
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : "验收失败";
		process.exitCode = 1;
	}
	const result = {
		kind: item.kind,
		question: item.text,
		failure,
		answer,
		events,
		chartIds: artifacts.map((chart) => chart.id),
	};
	results.push(result);
	await writeFile(
		file,
		JSON.stringify({ source: "live_mysql_simulation", model: "deepseek/deepseek-flash", from, to, results }, null, 2),
		{ mode: 0o600 },
	);
	console.log(
		JSON.stringify({
			kind: item.kind,
			failure,
			tools: events.filter((event) => event.type === "tool_start").map((event) => event.tool),
			charts: artifacts.map((chart) => ({ id: chart.id, kind: chart.kind, rows: chart.rows.length })),
		}),
	);
}
console.log(`Private evidence: ${file}`);
