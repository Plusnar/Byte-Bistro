// Versioned assets must not change in place. The sizes also let us return a range
// without buffering a whole video when the static asset response omits its length.
const VIDEO_SIZES = {
  "chase-landscape-hq-v1.mp4": 21507237,
  "chase-landscape-hq-v1.webm": 16442174,
  "chase-portrait-hq-v1.mp4": 18183950,
  "chase-portrait-hq-v1.webm": 16585224,
};

export function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
      || start >= size || requestedEnd < start) return { unsatisfiable: true };
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function sliceStream(body, start, end) {
  const reader = body.getReader();
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (offset <= end) {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          const chunkStart = offset;
          offset += value.byteLength;
          const from = Math.max(0, start - chunkStart);
          const to = Math.min(value.byteLength, end + 1 - chunkStart);
          if (from < to) {
            controller.enqueue(value.subarray(from, to));
            if (offset > end) {
              controller.close();
              void reader.cancel().catch(() => {});
            }
            return;
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export async function onRequest(context) {
  const { request } = context;
  const name = new URL(request.url).pathname.split("/").pop();
  const size = VIDEO_SIZES[name];
  const value = request.headers.get("Range");
  if (request.method !== "GET" || !size || !value) return context.next();

  const range = parseRange(value, size);
  // Multiple or malformed ranges are ignored, as allowed by HTTP.
  if (!range) return context.next();
  if (range.unsatisfiable) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  const source = await context.next();
  if (source.status !== 200 || !source.body || source.headers.has("Content-Encoding")) return source;
  const actualLength = source.headers.get("Content-Length");
  if (actualLength && Number(actualLength) !== size) return source;
  const ifRange = request.headers.get("If-Range");
  if (ifRange && ifRange !== source.headers.get("ETag") && ifRange !== source.headers.get("Last-Modified")) return source;

  const headers = new Headers(source.headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(sliceStream(source.body, range.start, range.end), { status: 206, headers });
}
