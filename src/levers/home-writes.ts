import type { Env } from "../config.js";
import type { LeverDescriptor } from "./types.js";

export function describeHomeWrites(
	lever: LeverDescriptor,
	env: Env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	return lever.homeWrites.map((write) => `${write.description} in ${write.path(env, platform)}`);
}
