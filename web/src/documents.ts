export { documentType } from "../../worker/documents.ts";

export function documentUrl(file: string, tree: string | null, preview?: string | null, proposal?: number) {
  const params = new URLSearchParams();
  if (tree) params.set("tree", tree);
  if (preview) params.set("preview_view", preview);
  if (proposal) params.set("proposal", String(proposal));
  return `media/${file}?${params}`;
}
