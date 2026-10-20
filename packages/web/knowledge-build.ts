import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { buildFaultKnowledgeVectorIndex, getEmbeddingConfig } from "./knowledge-vectors.ts";
import { getFaultKnowledgeIndex } from "./knowledge-index.ts";

const execFileAsync = promisify(execFile);
const knowledgeRoot = fileURLToPath(new URL("./knowledge/", import.meta.url));
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
try {
	loadEnvFile(resolve(packageRoot, ".env"));
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const config = getEmbeddingConfig();
if (!config) throw new Error("请先在 packages/web/.env 配置 EMBEDDING_BASE_URL、EMBEDDING_API_KEY 和 EMBEDDING_MODEL");

const python = process.env.PYTHON?.trim() || "python";
for (const script of ["scripts/ingest.py", "scripts/validate.py"]) {
	const result = await execFileAsync(python, [script], { cwd: knowledgeRoot, maxBuffer: 1024 * 1024 });
	if (result.stdout.trim()) process.stdout.write(result.stdout);
	if (result.stderr.trim()) process.stderr.write(result.stderr);
}

const result = await buildFaultKnowledgeVectorIndex(await getFaultKnowledgeIndex());
console.log(`向量索引已更新：${result.records} 条，模型 ${result.model}，维度 ${result.dimensions}`);
