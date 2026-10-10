// Images the captain attaches to a message: the rules the daemon enforces and the UI
// shows before anything is uploaded. Imported by both, so the limits never disagree.

/** The image types an upload may be, by extension. */
export const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
} as const;
export type ImageExt = keyof typeof IMAGE_TYPES;

/** What the file picker offers. */
export const IMAGE_ACCEPT = Object.values(IMAGE_TYPES).join(",");

/** The largest image Joyride takes, in bytes. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The most images one message carries. */
export const MAX_IMAGES_PER_MESSAGE = 8;

/**
 * Agents that load an image when its path is pasted into their input box on its own:
 * Claude Code and Codex turn it into an "[Image #N]" attachment (checked in a Herdr lab).
 */
export const IMAGE_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);

export const canSendImages = (agent: string | null | undefined) => Boolean(agent && IMAGE_AGENTS.has(agent));

/** Why images can't go to this agent, for the UI and the relay's refusal. */
export function noImagesReason(agent: string | null | undefined, who = "This agent"): string {
  const name = agent ? `${who} (${agent})` : who;
  return `${name} can't load images from a file path, so Joyride won't send it images. Images work with Claude Code and Codex; describe the picture in words here instead.`;
}

/** Stored uploads live at <uploads>/<YYYY-MM-DD>/<id>.<ext>; this is the daemon route that serves one. */
const STORED = /\/uploads\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]{6,32}\.(?:png|jpg|gif|webp))$/;
export function uploadUrl(absPath: string): string | null {
  const m = absPath.match(STORED);
  return m ? `/api/uploads/${m[1]}/${m[2]}` : null;
}

export const fileName = (p: string) => p.split("/").pop() ?? p;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
