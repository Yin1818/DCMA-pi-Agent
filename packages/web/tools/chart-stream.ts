import { validateChartReference } from "../chart-contracts.ts";

export function chartToolEvent(value: unknown) {
	if (!value || typeof value !== "object") return null;
	const event = value as Record<string, unknown>;
	if (
		event.type !== "tool_execution_end" ||
		event.toolName !== "create_analysis_chart" ||
		event.isError === true ||
		!event.result ||
		typeof event.result !== "object"
	)
		return null;
	const details: unknown = "details" in event.result ? event.result.details : null;
	if (!details || typeof details !== "object" || !("chart" in details)) return null;
	const chart = validateChartReference(details.chart);
	return chart ? { type: "chart" as const, chart } : null;
}
