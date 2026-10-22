import { normalizeRecord } from "../../../dashboard/database/dashboard-data.ts";
import type { ChartSource } from "../tools/charts.ts";
import type { AnalysisWindow } from "../tools/contracts.ts";

export function chartFixture(
	values: (number | null)[] = [0, null, 2, 3, 4],
): Extract<ChartSource, { type: "window" | "preview" }> {
	const window: AnalysisWindow = {
		table: "real_data_01",
		from: "2026-10-21T16:00:00.000Z",
		to: "2026-10-21T16:00:40.000Z",
		queriedAt: "2026-10-21T16:00:41.000Z",
		complete: true,
		invalidTimeRows: 0,
		excludedIdentityRows: 0,
		availableFields: ["motor_temp", "current_actual"],
		records: values.map((value, index) =>
			normalizeRecord({
				id: index,
				timestamp: String(Date.parse("2026-10-21T16:00:00.000Z") + index * 10000),
				device_name: "synthetic",
				inverter_name: "synthetic",
				motor_temp: value,
				current_actual: index === 3 ? null : index * 2,
			}),
		),
	};
	return { type: "window", window, allowedMetrics: ["motor_temp", "current_actual"], units: {} };
}
