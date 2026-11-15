/** `npm run build:plugin`: writes the Claude Code plugin and its marketplace from luseen's sources (FR-PLUG-012). */
import { buildPluginFiles, writePluginFiles } from "../adapters/storage/plugin-files.js";

const root = process.cwd();
const files = await buildPluginFiles(root);
await writePluginFiles(root, files);
process.stdout.write(`Wrote ${files.size} plugin files.\n`);
