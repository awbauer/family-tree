export { documentType } from "../../worker/documents.ts";

export function documentUrl(file: string, tree: string | null, preview?: string | null, proposal?: number) {
  const params = new URLSearchParams();
  if (tree) params.set("tree", tree);
  if (preview) params.set("preview_view", preview);
  if (proposal) params.set("proposal", String(proposal));
  return `media/${file}?${params}`;
}

/** An attachment that is a photo or scan (marked `image` by /api/tree), shown in the page rather than downloaded. */
export function attachmentImageUrl(file: string, tree: string | null, preview?: string | null) {
  const params = new URLSearchParams({ inline: "1" });
  if (tree) params.set("tree", tree);
  if (preview) params.set("preview_view", preview);
  return `media/${file}?${params}`;
}
