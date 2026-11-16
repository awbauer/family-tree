// Document keys identify the upload class independently of editable media metadata.
export function documentType(file: unknown) {
  if (typeof file !== "string") return null;
  return /^reports\/[\w-]+$/.test(file) ? "report" : /^attachments\/[\w-]+$/.test(file) ? "attachment" : null;
}

export const FILE_LIMIT = 20 * 1024 * 1024;
export const REPORT_LIMIT = 1024 * 1024;

export function documentsFor(bundle: { research: { media?: Record<string, { file: string; caption?: string; type?: string }[]> } }, person: string) {
  return (bundle.research.media?.[person] || []).filter((item) => documentType(item.file));
}
