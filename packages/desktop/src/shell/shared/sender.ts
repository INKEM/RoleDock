import { pathToFileURL } from "node:url";

/**
 * Sender validation for shell IPC (DESKTOP_GUI_PLAN §9): only frames whose
 * URL is the production renderer page may invoke shell channels. Pure and
 * electron-free (structural input) so unit tests drive it directly.
 */

export function shellPageUrlPrefix(rendererDir: string): string {
  return pathToFileURL(rendererDir + "/").href;
}

export interface SenderFrameLike { url?: string }

export function isTrustedSender(event: { senderFrame?: SenderFrameLike | null }, urlPrefix: string): boolean {
  const url = event.senderFrame?.url ?? "";
  return url.startsWith(urlPrefix);
}
