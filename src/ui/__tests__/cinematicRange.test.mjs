import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { onRequest, parseRange } from "../../../functions/assets/ui/cinematic/[file].js";

const names = [
  "chase-landscape-hq-v1.mp4",
  "chase-landscape-hq-v1.webm",
  "chase-portrait-hq-v1.mp4",
  "chase-portrait-hq-v1.webm",
];

function context(name, range, headers = {}) {
  const request = new Request(`https://example.test/assets/ui/cinematic/${name}`, {
    headers: { ...(range ? { Range: range } : {}), ...headers },
  });
  const next = () => Promise.resolve(new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), {
    headers: { ETag: '"version-one"', "Content-Type": "video/mp4" },
  }));
  return { request, next };
}

describe("cinematic byte ranges", () => {
  it("parses bounded, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=8-100", 10)).toEqual({ start: 8, end: 9 });
    expect(parseRange("bytes=0-1,3-4", 10)).toBeNull();
    expect(parseRange("bytes=10-", 10)).toEqual({ unsatisfiable: true });
  });

  it.each(names)("returns the correct range and recorded size for %s", async (name) => {
    const size = statSync(new URL(`../../../public/assets/ui/cinematic/${name}`, import.meta.url)).size;
    const response = await onRequest(context(name, "bytes=2-5"));
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 2-5/${size}`);
    expect(response.headers.get("Content-Length")).toBe("4");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4, 5]);
  });

  it("returns 416 for an unsatisfiable range", async () => {
    const response = await onRequest(context(names[0], "bytes=999999999-"));
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toMatch(/^bytes \*\/\d+$/);
  });

  it("falls back to the full response for unsupported ranges and mismatched validators", async () => {
    expect((await onRequest(context(names[0], "bytes=0-1,3-4"))).status).toBe(200);
    expect((await onRequest(context(names[0], "bytes=0-1", { "If-Range": '"old"' }))).status).toBe(200);
    expect((await onRequest(context(names[0], null))).status).toBe(200);
  });
});
