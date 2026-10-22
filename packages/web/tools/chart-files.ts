import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type ChartArtifact, type ChartReference, chartIdPattern, validateChartArtifact } from "../chart-contracts.ts";
import { ToolInputError } from "./contracts.ts";
import { preparePrivateDirectory } from "./runtime-files.ts";

const maximumBytes = 4 * 1024 * 1024;
const writes = new Map<string, Promise<unknown>>();
export async function saveChart(directory: string, artifact: ChartArtifact): Promise<ChartReference> {
	const pending = (writes.get(directory) ?? Promise.resolve())
		.catch(() => {})
		.then(async () => {
			validateChartArtifact(artifact);
			const content = JSON.stringify(artifact);
			if (Buffer.byteLength(content) > maximumBytes) throw new ToolInputError("图表快照超过4MiB，请缩小范围。");
			await preparePrivateDirectory(directory);
			const folder = join(directory, "charts");
			await preparePrivateDirectory(folder);
			if ((await readdir(folder)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).length >= 100)
				throw new ToolInputError("本机已保存100份图表，请先人工归档。");
			const temporary = join(folder, `.${randomUUID()}.tmp`);
			const handle = await open(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
				await handle.close();
				await link(temporary, join(folder, `${artifact.id}.json`));
			} finally {
				await handle.close().catch(() => {});
				await unlink(temporary).catch(() => {});
			}
			return { version: 1 as const, id: artifact.id };
		});
	writes.set(directory, pending);
	try {
		return await pending;
	} finally {
		if (writes.get(directory) === pending) writes.delete(directory);
	}
}
export async function readChart(directory: string, id: string): Promise<ChartArtifact> {
	if (!chartIdPattern.test(id)) throw new ToolInputError("图表编号无效。");
	const folder = join(directory, "charts");
	await preparePrivateDirectory(directory);
	await preparePrivateDirectory(folder);
	const file = await open(
		join(folder, `${id}.json`),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > maximumBytes) throw new ToolInputError("图表文件无效或过大。");
		const buffer = Buffer.alloc(maximumBytes + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await file.read(buffer, size, buffer.length - size, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		if (size > maximumBytes) throw new ToolInputError("图表文件过大。");
		const artifact = validateChartArtifact(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))) as unknown,
		);
		if (artifact.id !== id) throw new ToolInputError("图表编号与快照不一致。");
		return artifact;
	} finally {
		await file.close();
	}
}
export function chartCsv(artifact: ChartArtifact): string {
	return `\uFEFF${[
		artifact.columns.map((column) => column.label + (column.unit ? `（${column.unit}）` : "")),
		...artifact.rows,
	]
		.map((row) =>
			row
				.map((cell) => {
					const text = cell === null ? "" : String(cell);
					const safe = typeof cell === "string" && /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
					return `"${safe.replace(/"/g, '""')}"`;
				})
				.join(","),
		)
		.join("\r\n")}`;
}
