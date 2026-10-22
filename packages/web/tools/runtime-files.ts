import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ToolInputError } from "./contracts.ts";

export async function preparePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new ToolInputError("本地工具目录必须是真实目录，不能使用符号链接。");
	await chmod(directory, 0o700);
}

export interface EvidenceRecord {
	id: string;
	tool: string;
	createdAt: string;
	input: unknown;
	result: unknown;
}

export function createEvidenceStore() {
	const records = new Map<string, EvidenceRecord>();
	let bytes = 0;
	return {
		add(tool: string, input: unknown, result: unknown) {
			const record: EvidenceRecord = { id: randomUUID(), tool, createdAt: new Date().toISOString(), input, result };
			bytes += Buffer.byteLength(JSON.stringify(record));
			if (bytes > 2 * 1024 * 1024) throw new ToolInputError("本轮证据大小已达到上限，请新建分析请求。");
			records.set(record.id, record);
			return record;
		},
		get(ids: string[]) {
			if (!ids.length || ids.length > 12 || new Set(ids).size !== ids.length)
				throw new ToolInputError("请引用1至12个不同的本轮证据编号。");
			return ids.map((id) => {
				const record = records.get(id);
				if (!record) throw new ToolInputError("证据编号不存在或不属于本轮请求，不能用历史文本替代。");
				return record;
			});
		},
	};
}

export async function exportReport(directory: string, title: string, records: EvidenceRecord[]) {
	await preparePrivateDirectory(directory);
	// Bound local disk use without deleting existing user reports.
	if ((await readdir(directory)).filter((name) => /^report-.*\.(md|json)$/.test(name)).length >= 200)
		throw new ToolInputError("本地已保存100份报告，请先手动归档报告再生成。");
	const id = randomUUID();
	const bundle = {
		id,
		title,
		generatedAt: new Date().toISOString(),
		records,
		note: "程序记录的查询与分析证据。模型建议不等于已确认根因，资料来源不代表经过现场验证。",
	};
	const json = JSON.stringify(bundle, null, 2);
	if (Buffer.byteLength(json) > 1024 * 1024) throw new ToolInputError("报告超过1MB，请缩小引用范围。");
	const escapedTitle = title.replace(/[\r\n<>#]/g, " ");
	const markdown = `# ${escapedTitle}\n\n生成时间：${bundle.generatedAt}\n\n${bundle.note}\n\n${records.map((record) => `## ${record.tool} · ${record.id}\n\n记录时间：${record.createdAt}\n\n\`\`\`json\n${JSON.stringify({ parameters: record.input, result: record.result }, null, 2).replace(/`/g, "\\u0060")}\n\`\`\`\n`).join("\n")}`;
	const created: string[] = [];
	try {
		for (const [extension, content] of [
			["json", json],
			["md", markdown],
		]) {
			const path = join(directory, `report-${id}.${extension}`);
			const file = await open(
				path,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
				0o600,
			);
			created.push(path);
			try {
				await file.writeFile(content, "utf8");
			} finally {
				await file.close();
			}
		}
	} catch (error) {
		await Promise.all(created.map((path) => unlink(path).catch(() => {})));
		throw error;
	}
	return {
		reportId: id,
		markdownUrl: `/api/tools/reports/${id}.md`,
		jsonUrl: `/api/tools/reports/${id}.json`,
		evidenceIds: records.map((record) => record.id),
	};
}

export async function readReport(directory: string, name: string) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(md|json)$/.test(name))
		throw new ToolInputError("报告编号无效。");
	await preparePrivateDirectory(directory);
	const file = await open(
		join(directory, `report-${name}`),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ToolInputError("报告文件无效或过大。");
		const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await file.read(buffer, size, buffer.length - size, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		if (size > 2 * 1024 * 1024) throw new ToolInputError("报告文件超过大小限制。");
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
	} finally {
		await file.close();
	}
}
