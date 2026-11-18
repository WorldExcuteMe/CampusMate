export function localWorkspaceIdentity(): { owner: string; token: string } | null {
  if (typeof document === "undefined" || location.hostname !== "127.0.0.1") return null;
  const owner = document.querySelector<HTMLMetaElement>('meta[name="campusmate-local-owner"]')?.content;
  const token = document.querySelector<HTMLMetaElement>('meta[name="campusmate-local-token"]')?.content;
  return owner && token ? { owner, token } : null;
}
