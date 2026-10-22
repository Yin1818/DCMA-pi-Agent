import type { ChartReference } from "../chart-contracts.ts";
export interface Device {
	id: string;
	code: string;
	name: string;
	type: string;
	location: string;
	commissionDate: string;
	status: "running" | "warning" | "stopped" | "maintenance" | "unknown";
	image: string;
}
export type MetricKey = "temperature" | "vibration" | "current" | "speed";
export interface TelemetrySample {
	timestamp: string;
	temperature?: number;
	vibration?: number;
	current?: number;
	speed?: number;
}
export interface Dataset {
	source: string;
	imported: boolean;
	samples: TelemetrySample[];
}
export interface MetricData {
	id: MetricKey | "voltage";
	label: string;
	value: string | number;
	unit: string;
	change: string;
	trend: "up" | "down" | "flat";
	accentColor: "blue" | "amber";
	sparkline: number[];
	points?: ChartSample[];
}
export interface ChartPoint {
	name: string;
	value: number;
	time?: number;
}
export interface ChartSample extends Omit<ChartPoint, "value"> {
	value: number | null;
}
export interface ChatMessage {
	charts?: ChartReference[];
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: string;
	status?: "streaming" | "done" | "error" | "cancelled";
	engine?: string;
}
export interface ConversationItem {
	id: string;
	title: string;
	time: string;
	deviceId: string;
	messages: ChatMessage[];
}
export interface AppSettings {
	databaseEnabled?: boolean;
	model: string;
	telemetryIntervalMs: number;
	alarmThreshold: number;
}
export interface BackendStatus {
	connected: boolean;
	models: { id: string; name: string }[];
	message: string;
}
export interface SuggestionCard {
	id: string;
	title: string;
	query: string;
	iconBg: string;
	iconColor: string;
	iconType: "search" | "chart" | "alert" | "clipboard";
}
