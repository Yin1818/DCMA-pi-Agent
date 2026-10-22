import { dashboardTables } from "../../../dashboard/database/dashboard-types.ts";
import { validateChartReference } from "../chart-contracts.ts";
import { createDemoDatasets, defaultSettings, initialDevices } from "./mockData.ts";
import { parseTelemetry } from "./telemetry.ts";
import type { AppSettings, ConversationItem, Dataset } from "./types.ts";

export const storageKey = "dcma-workspace-v1";
export interface WorkspaceState {
	conversations: ConversationItem[];
	activeId: string | null;
	deviceId: string;
	settings: AppSettings;
	datasets: Record<string, Dataset>;
	offlineDeviceId?: string;
}
export function loadWorkspace(): WorkspaceState {
	const initial: WorkspaceState = {
		conversations: [],
		activeId: null,
		deviceId: dashboardTables[0],
		settings: defaultSettings,
		datasets: createDemoDatasets(),
	};
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
		if (!raw || typeof raw !== "object") return initial;
		const value = raw as Record<string, unknown>;
		const saved = value.settings;
		if (saved && typeof saved === "object") {
			const settings = saved as Record<string, unknown>;
			initial.settings = {
				databaseEnabled: settings.databaseEnabled !== false,
				model: typeof settings.model === "string" ? settings.model : "",
				telemetryIntervalMs: [1000, 3000, 5000].includes(Number(settings.telemetryIntervalMs))
					? Number(settings.telemetryIntervalMs)
					: 3000,
				alarmThreshold:
					typeof settings.alarmThreshold === "number" &&
					settings.alarmThreshold >= 0 &&
					settings.alarmThreshold <= 150
						? settings.alarmThreshold
						: 75,
			};
		}
		if (typeof value.deviceId === "string" && dashboardTables.some((table) => table === value.deviceId))
			initial.deviceId = value.deviceId;
		if (Array.isArray(value.conversations)) {
			initial.conversations = value.conversations.slice(0, 50).flatMap((entry: unknown) => {
				if (!entry || typeof entry !== "object") return [];
				const conversation = entry as Record<string, unknown>;
				if (
					typeof conversation.id !== "string" ||
					typeof conversation.title !== "string" ||
					typeof conversation.time !== "string" ||
					typeof conversation.deviceId !== "string" ||
					!Array.isArray(conversation.messages)
				)
					return [];
				const messages = conversation.messages.slice(-200).flatMap((item: unknown) => {
					if (!item || typeof item !== "object") return [];
					const message = item as Record<string, unknown>;
					if (
						typeof message.id !== "string" ||
						(message.role !== "user" && message.role !== "assistant") ||
						typeof message.content !== "string" ||
						typeof message.timestamp !== "string"
					)
						return [];
					return [
						{
							id: message.id,
							charts: Array.isArray(message.charts)
								? message.charts.slice(0, 3).flatMap((value: unknown, index: number, values: unknown[]) => {
										const chart = validateChartReference(value);
										return chart &&
											values.findIndex((entry) => validateChartReference(entry)?.id === chart.id) === index
											? [chart]
											: [];
									})
								: undefined,
							role: message.role,
							content: message.content,
							timestamp: message.timestamp,
							engine: typeof message.engine === "string" ? message.engine.replace(/^pi\b/iu, "DCMA") : undefined,
							status:
								message.status === "error"
									? ("error" as const)
									: message.status === "streaming" || message.status === "cancelled"
										? ("cancelled" as const)
										: ("done" as const),
						},
					];
				});
				return [
					{
						id: conversation.id,
						title: conversation.title,
						time: conversation.time,
						deviceId: conversation.deviceId,
						messages,
					} as ConversationItem,
				];
			});
		}
		if (
			typeof value.activeId === "string" &&
			initial.conversations.some((conversation) => conversation.id === value.activeId)
		)
			initial.activeId = value.activeId;
		if (value.datasets && typeof value.datasets === "object") {
			for (const deviceId of [...initialDevices.map((device) => device.id), ...dashboardTables]) {
				const savedData: unknown = (value.datasets as Record<string, unknown>)[deviceId];
				if (!savedData || typeof savedData !== "object") continue;
				const dataset = savedData as Record<string, unknown>;
				if (!Array.isArray(dataset.samples) || !dataset.imported || typeof dataset.source !== "string") continue;
				try {
					const restored = parseTelemetry(
						dataset.samples.map((sample: unknown) => JSON.stringify(sample)).join("\n"),
						"历史导入数据",
					);
					initial.datasets[deviceId] = { ...restored, source: dataset.source };
				} catch {
					/* A damaged dataset must not prevent loading other conversations. */
				}
			}
		}
		if (
			typeof value.offlineDeviceId === "string" &&
			dashboardTables.some((table) => table === value.offlineDeviceId) &&
			initial.datasets[value.offlineDeviceId]?.imported
		)
			initial.offlineDeviceId = value.offlineDeviceId;
	} catch {
		/* Start with a usable workspace if storage is unavailable or corrupted. */
	}
	return initial;
}
