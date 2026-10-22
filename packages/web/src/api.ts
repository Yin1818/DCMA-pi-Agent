import { type ChartReference, validateChartReference } from "../chart-contracts.ts";
import type { BackendStatus } from "./types.ts";

export async function getBackendStatus(signal?: AbortSignal, refresh = false): Promise<BackendStatus> {
	const response = await fetch(refresh ? "/api/health?refresh=1" : "/api/health", { signal });
	if (!response.ok) throw new Error("本地后端未连接");
	return (await response.json()) as BackendStatus;
}

export async function streamChat(
	payload: unknown,
	signal: AbortSignal,
	onDelta: (text: string) => void,
	onChart?: (chart: ChartReference) => void,
): Promise<void> {
	const response = await fetch("/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-DCMA-Client": "web" },
		body: JSON.stringify(payload),
		signal,
	});
	if (!response.ok) {
		const body: unknown = await response.json();
		throw new Error(
			body && typeof body === "object" && "error" in body && typeof body.error === "string"
				? body.error
				: `请求失败（${response.status}）`,
		);
	}
	if (!response.body) throw new Error("模型未返回响应流。");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let finished = false;
	const consume = (line: string) => {
		if (!line.trim()) return;
		const event: unknown = JSON.parse(line);
		if (!event || typeof event !== "object" || !("type" in event)) throw new Error("响应格式无效。");
		if (event.type === "delta" && "text" in event && typeof event.text === "string") onDelta(event.text);
		else if (event.type === "chart" && "chart" in event) {
			const chart = validateChartReference(event.chart);
			if (chart) onChart?.(chart);
		} else if (event.type === "error" && "message" in event && typeof event.message === "string")
			throw new Error(event.message);
		else if (event.type === "done") finished = true;
	};
	try {
		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) consume(line);
			if (done) break;
		}
		consume(buffer);
		if (!finished) throw new Error("模型连接提前结束，可以重新发送问题。");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
