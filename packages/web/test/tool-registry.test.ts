import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { createIndustrialServices, createIndustrialTools } from "../tools/index.ts";

test("registered catalog schema supports optional table filtering without accepting arbitrary sources", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dcma-registry-"));
	const services = createIndustrialServices(directory);
	try {
		const tools = createIndustrialTools("real_data_01", services);
		assert.equal(tools.length, 17);
		assert.equal(new Set(tools.map((tool) => tool.name)).size, 17);
		const drawing = tools.find((tool) => tool.name === "create_analysis_chart");
		assert.ok(drawing);
		assert.ok(
			Check(drawing.parameters, {
				evidenceId: "11111111-1111-4111-8111-111111111111",
				kind: "line",
				metrics: ["motor_temp"],
			}),
		);
		assert.ok(!Check(drawing.parameters, { evidenceId: "x", kind: "line", points: [1, 2, 3] }));
		const catalog = tools.find((tool) => tool.name === "list_industrial_tables");
		assert.ok(catalog);
		assert.ok(Check(catalog.parameters, {}));
		assert.ok(Check(catalog.parameters, { table: "real_data_01", refresh: false }));
		assert.ok(!Check(catalog.parameters, { table: "private_table" }));
		assert.ok(!Check(catalog.parameters, { schema: "other_database" }));
		const statistics = tools.find((tool) => tool.name === "summarize_metrics");
		assert.ok(statistics);
		assert.ok(
			Check(statistics.parameters, { from: "2026-10-22T00:00:00.000+08:00", to: "2026-10-22T00:03:00.000+08:00" }),
		);
	} finally {
		await services.monitoring.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
