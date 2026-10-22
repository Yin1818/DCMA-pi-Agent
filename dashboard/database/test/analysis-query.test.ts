import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createPool } from "mysql2/promise";
import { closeDatabase, readAnalysisRows } from "../database.ts";
import { fieldLabels } from "../dashboard-types.ts";

test("完整分析窗口使用预处理二进制流，保留与展板一致的FLOAT精度", async (context) => {
	process.env.MYSQL_HOST = "test.invalid";
	process.env.MYSQL_USER = "test";
	process.env.MYSQL_PASSWORD = "test";
	process.env.MYSQL_DATABASE = "dcma";
	const dummyPool = createPool({});
	const timestamp = "2026-10-21T16:00:00.000Z";
	const value = Math.fround(0.1);
	let prepared = false;
	const connection = {
		connection: {
			query() { throw new Error("analysis must not use lossy text protocol"); },
			execute(options: { sql: string }, parameters: unknown[]) {
				prepared = true;
				assert.match(options.sql, /ORDER BY __collection_ms ASC, id ASC LIMIT 20001/);
				assert.deepEqual(parameters, ["synthetic", "synthetic", Date.parse(timestamp), Date.parse(timestamp)]);
				return { stream: () => Readable.from([{ id: "1", device_name: "synthetic", inverter_name: "synthetic", timestamp: "2026-10-22 00:00:00", motor_temp: value, __collection_ms: Date.parse(timestamp) }]) };
			},
		},
		async execute(options: { sql: string }) {
			assert.match(options.sql, /information_schema.COLUMNS/);
			return [Object.keys(fieldLabels).map((field) => ({ TABLE_SCHEMA: "dcma", TABLE_NAME: "real_data_01", COLUMN_NAME: field, DATA_TYPE: "float", COLUMN_KEY: "", COLUMN_COMMENT: "" }))];
		},
		async query(options: { sql: string }) {
			if (options.sql.includes("SELECT DISTINCT")) return [[{ device_name: "synthetic", inverter_name: "synthetic" }]];
			if (options.sql.includes("invalid_times")) return [[{ invalid_times: 0, excluded: 0 }]];
			assert.match(options.sql, /^(START TRANSACTION READ ONLY|COMMIT)$/);
			return [[]];
		},
		destroy() {}, release() {},
	};
	context.mock.method(Object.getPrototypeOf(dummyPool), "getConnection", async () => connection);
	context.after(async () => { await closeDatabase(); await dummyPool.end(); });
	const result = await readAnalysisRows({ table: "real_data_01", from: timestamp, to: timestamp });
	assert.equal(prepared, true);
	assert.equal(result.records[0].values.motor_temp, value);
});
