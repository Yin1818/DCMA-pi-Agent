import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chartCsv, readChart, saveChart } from "../tools/chart-files.ts";
import { buildChart } from "../tools/charts.ts";
import { chartFixture } from "./chart-fixture.ts";

test("snapshot reload preserves exact data, permissions and rejects paths and symlinks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dcma-chart-"));
	try {
		const chart = buildChart(
			{ evidenceId: "11111111-1111-4111-8111-111111111111", kind: "line", metrics: ["motor_temp"] },
			chartFixture(),
		);
		await saveChart(directory, chart);
		assert.deepEqual(await readChart(directory, chart.id), chart);
		assert.equal((await stat(join(directory, "charts", `${chart.id}.json`))).mode & 0o777, 0o600);
		await assert.rejects(readChart(directory, "../profiles"));
		const other = "22222222-2222-4222-8222-222222222222";
		await symlink(join(directory, "charts", `${chart.id}.json`), join(directory, "charts", `${other}.json`));
		await assert.rejects(readChart(directory, other));
		await rm(join(directory, "charts", `${other}.json`));
		await writeFile(join(directory, "charts", `${other}.json`), "{}");
		await assert.rejects(readChart(directory, other));
		await writeFile(join(directory, "charts", `${other}.json`), Buffer.alloc(4 * 1024 * 1024 + 1));
		await assert.rejects(readChart(directory, other), /过大/);
		for (let index = 0; index < 98; index++) await writeFile(join(directory, "charts", `${randomUUID()}.json`), "{}");
		await assert.rejects(saveChart(directory, { ...chart, id: randomUUID() }), /100份/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("CSV retains null and zero, quotes safely and neutralizes text formulas", () => {
	const chart = buildChart(
		{ evidenceId: "11111111-1111-4111-8111-111111111111", kind: "line", metrics: ["motor_temp"] },
		chartFixture(),
	);
	chart.columns[0].label = "=SUM(1,2)";
	const csv = chartCsv(chart);
	assert.ok(csv.startsWith('\uFEFF"\'=SUM(1,2)"'));
	assert.ok(csv.includes(',"0"'));
	assert.ok(csv.includes('"2026-10-21T16:00:10.000Z",""'));
});
