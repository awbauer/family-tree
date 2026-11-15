// HTTP helpers shared by the router and the agent routes.
export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "X-Robots-Tag": "noindex" }, extra) });
}
