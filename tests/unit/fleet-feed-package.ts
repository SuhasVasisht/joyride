// The joyride-fleet-feed package's helpers, imported without running a verb (its entrypoint checks this env).
process.env.JOYRIDE_FLEET_FEED_IMPORT = "1";
// @ts-expect-error: a plain .mjs package with no type declarations
const pkg = await import("../../install/firstmate-extension/joyride-fleet-feed/joyride-fleet-feed.mjs");
export const classify: (content: string) => string = pkg.classify;
export const bounded: (text: string) => string = pkg.bounded;
export const daemonUrl: (ref: string) => string | null = pkg.daemonUrl;
export const consumerOf: (ref: string, sourceId: string) => string = pkg.consumerOf;
