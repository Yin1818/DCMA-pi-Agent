import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type * as Mysql from "mysql2/promise";
import { fieldLabels } from "../../../dashboard/database/dashboard-types.ts";
import { closeDatabase } from "../../../dashboard/database/database.ts";
import { readChart } from "../tools/chart-files.ts";
import { createIndustrialServices, createIndustrialTools } from "../tools/index.ts";

test("drawing reuses the exact query window and enforces evidence ownership and three-chart limit", async (context) => {
	process.env.MYSQL_HOST = "test.invalid";
	process.env.MYSQL_USER = "test";
	process.env.MYSQL_PASSWORD = "test";
	process.env.MYSQL_DATABASE = "dcma";
	const directory = await mkdtemp(join(tmpdir(), "dcma-chart-tool-"));
	const dashboardMysql = createRequire(new URL("../../../dashboard/database/database.ts", import.meta.url))(
		"mysql2/promise",
	) as typeof Mysql;
	const pool = dashboardMysql.createPool({});
	let reads = 0;
	const from = "2026-10-21T16:00:00.000Z",
		to = "2026-10-21T16:00:10.000Z";
	const connection = {
		connection: {
			execute() {
				reads++;
				return {
					stream: () =>
						Readable.from(
							[0, 10].map((second) => ({
								id: second,
								timestamp: String(Date.parse(from) + second * 1000),
								device_name: "synthetic",
								inverter_name: "synthetic",
								motor_temp: second,
								__collection_ms: Date.parse(from) + second * 1000,
							})),
						),
				};
			},
		},
		async execute() {
			return [
				Object.keys(fieldLabels).map((name) => ({
					TABLE_SCHEMA: "dcma",
					TABLE_NAME: "real_data_01",
					COLUMN_NAME: name,
					DATA_TYPE: "float",
					COLUMN_KEY: "",
					COLUMN_COMMENT: "",
				})),
			];
		},
		async query(options: { sql: string }) {
			if (options.sql.includes("SELECT DISTINCT"))
				return [[{ device_name: "synthetic", inverter_name: "synthetic" }]];
			if (options.sql.includes("invalid_times")) return [[{ invalid_times: 0, excluded: 0 }]];
			return [[]];
		},
		destroy() {},
		release() {},
	};
	context.mock.method(Object.getPrototypeOf(pool), "getConnection", async () => connection);
	const services = createIndustrialServices(directory),
		tools = createIndustrialTools("real_data_01", services);
	const invoke = async (name: string, params: unknown) => {
		const tool = tools.find((tool) => tool.name === name)!;
		const result = await tool.execute("fixture", params as never, undefined, undefined, {} as never);
		return JSON.parse(
			result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join(""),
		) as { ok: boolean; evidenceId: string; result: { chart: { id: string } } };
	};
	try {
		const query = await invoke("summarize_metrics", { from, to, metrics: ["motor_temp"] });
		assert.equal(query.ok, true);
		for (let index = 0; index < 3; index++) {
			const result = await invoke("create_analysis_chart", {
				evidenceId: query.evidenceId,
				kind: "line",
				metrics: ["motor_temp"],
			});
			assert.equal(result.ok, true);
			const chart = await readChart(directory, result.result.chart.id);
			assert.deepEqual(
				chart.rows.map((row) => row[1]),
				[0, 10],
			);
		}
		assert.equal(reads, 1);
		assert.equal(
			(
				await invoke("create_analysis_chart", {
					evidenceId: query.evidenceId,
					kind: "line",
					metrics: ["motor_temp"],
				})
			).ok,
			false,
		);
		const other = createIndustrialTools("real_data_01", services).find(
			(tool) => tool.name === "create_analysis_chart",
		)!;
		const invalid = await other.execute(
			"fixture",
			{ evidenceId: query.evidenceId, kind: "line", metrics: ["motor_temp"] } as never,
			undefined,
			undefined,
			{} as never,
		);
		assert.equal(invalid.isError, true);
	} finally {
		await services.monitoring.stop();
		await closeDatabase();
		await pool.end();
		await rm(directory, { recursive: true, force: true });
	}
});
