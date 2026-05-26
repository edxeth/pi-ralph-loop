import {
	accessSync,
	constants,
	lstatSync,
	realpathSync,
	type Stats,
} from "node:fs";
import path from "node:path";

function invalidBundle(message: string): never {
	throw new Error(`Invalid Ralph bundle: ${message}`);
}

export function resolveWorkspacePath(
	root: string,
	relativePath: string,
): string {
	const resolved = path.resolve(root, relativePath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		invalidBundle(`${relativePath} escapes the workspace`);
	}
	return resolved;
}

export function validateRequiredFile(
	root: string,
	relativePath: string,
): string {
	const resolved = resolveWorkspacePath(root, relativePath);
	let stat: Stats;
	try {
		stat = lstatSync(resolved);
	} catch {
		invalidBundle(`${relativePath} is missing`);
	}

	if (stat.isSymbolicLink())
		invalidBundle(`${relativePath} must not be a symlink`);
	if (!stat.isFile()) invalidBundle(`${relativePath} is not a file`);

	let realPath: string;
	try {
		realPath = realpathSync(resolved);
		accessSync(realPath, constants.R_OK);
	} catch {
		invalidBundle(`${relativePath} is unreadable`);
	}

	const relative = path.relative(root, realPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		invalidBundle(`${relativePath} resolves outside the workspace`);
	}

	return realPath;
}
