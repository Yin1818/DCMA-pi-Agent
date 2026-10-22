import { dashboardTables, fieldLabels } from "../../../dashboard/database/dashboard-types.ts";

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parameters(value: unknown, depth = 0): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	if (depth > 3) return result;
	for (const [key, item] of Object.entries(object(value) ?? {})) {
		if (["a", "b", "rule", "spec"].includes(key)) result[key] = parameters(item, depth + 1);
		else if (
			[
				"limit",
				"offset",
				"threshold",
				"recoveryThreshold",
				"minDurationSeconds",
				"maxGapSeconds",
				"staleAfterSeconds",
				"bucketSeconds",
				"intervalSeconds",
				"windowSeconds",
				"page",
			].includes(key) &&
			typeof item === "number" &&
			Number.isFinite(item)
		)
			result[key] = item;
		else if (key === "refresh" && typeof item === "boolean") result[key] = item;
		else if (key === "table" && dashboardTables.some((table) => table === item)) result[key] = item;
		else if (
			["from", "to"].includes(key) &&
			typeof item === "string" &&
			/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(item)
		)
			result[key] = item;
		else if (["metric", "column"].includes(key) && typeof item === "string" && Object.hasOwn(fieldLabels, item))
			result[key] = item;
		else if (["metrics", "columns"].includes(key) && Array.isArray(item))
			result[key] = item
				.filter((field) => typeof field === "string" && Object.hasOwn(fieldLabels, field))
				.slice(0, 31);
		else if (
			["action", "state", "operator", "direction", "kind"].includes(key) &&
			typeof item === "string" &&
			/^(list|create|update|pause|resume|active|recovered|unknown|all|gt|lt|=|>=|<=|asc|desc|fault|alarm|status|control)$/.test(
				item,
			)
		)
			result[key] = item;
	}
	return result;
}

/** Public stream metadata deliberately excludes raw samples, free text, knowledge excerpts and credentials. */
export function toolTraceEvent(value: unknown): Record<string, unknown> | null {
	const event = object(value);
	if (!event || (event.type !== "tool_execution_start" && event.type !== "tool_execution_end")) return null;
	if (typeof event.toolName !== "string" || !/^[a-z_]{1,64}$/.test(event.toolName)) return null;
	const base = {
		tool: event.toolName,
		callId: typeof event.toolCallId === "string" ? event.toolCallId.slice(0, 128) : "",
	};
	if (event.type === "tool_execution_start")
		return { type: "tool_start", ...base, parameters: parameters(event.args) };
	const content = object(event.result)?.content;
	let payload: Record<string, unknown> | null = null;
	if (Array.isArray(content)) {
		const text = object(content[0])?.text;
		if (typeof text === "string" && text.length <= 64000) {
			try {
				payload = object(JSON.parse(text) as unknown);
			} catch {
				/* Framework failures may be plain text. */
			}
		}
	}
	const summary: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(object(payload?.result) ?? {})) {
		if (
			[
				"configured",
				"found",
				"truncated",
				"hasMore",
				"records",
				"returned",
				"total",
				"faults",
				"alarms",
				"open",
				"codeCount",
			].includes(key) &&
			(item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))
		)
			summary[key] = item;
		else if (
			["status", "freshness", "currentState"].includes(key) &&
			typeof item === "string" &&
			/^(unknown|partial|observed|ok|issues|fresh|stale|running|stopped|fault|pending_confirmation|confirmed)$/.test(
				item,
			)
		)
			summary[key] = item;
	}
	return {
		type: "tool_end",
		...base,
		ok: event.isError !== true && payload?.ok === true,
		evidenceId:
			typeof payload?.evidenceId === "string" && /^[0-9a-f-]{36}$/.test(payload.evidenceId)
				? payload.evidenceId
				: null,
		durationMs: typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? event.durationMs : null,
		summary,
	};
}
