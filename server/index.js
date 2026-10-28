// Dependencies
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { pipeline } = require("node:stream");
const bcrypt = require("bcryptjs");

// Server configuration
const PORT = 80;
const APP_DIR = "/srv";
const MEDIA_DIR = "/srv/videos";

// User configuration (environment variables)
const env = (name, fallback) => process.env[name] ?? fallback;
const AUTH_ENABLED = env("AUTH_ENABLED", "true") === "true";
const AUTH_SECRET = env(
  "AUTH_SECRET",
  "$2a$14$qRW8no8UDmSwIWM6KHwdRe1j/LMrxoP4NSM756RVodqeUq5HzG6t.",
);

if (AUTH_ENABLED && !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(AUTH_SECRET)) {
  console.error(
    "AUTH_SECRET is not a valid bcrypt hash. Make sure it has no surrounding quotes, and that its dollar signs were not interpolated.",
  );
  process.exit(1);
}

// React variables, injected into index.html
const REACT_VARIABLES = {
  __USE_SECRET__: String(AUTH_ENABLED),
  __APP_TITLE__: env("APP_TITLE", "Erin - TikTok feed for your own media"),
  __AUTOPLAY_ENABLED__: env("AUTOPLAY_ENABLED", "false"),
  __IMAGE_DISPLAY_DURATION__: env("IMAGE_DISPLAY_DURATION", "5"),
  __START_MUTED__: env("START_MUTED", "true"),
  __PROGRESS_BAR_POSITION__: env("PROGRESS_BAR_POSITION", "bottom"),
  __IGNORE_HIDDEN_PATHS__: env("IGNORE_HIDDEN_PATHS", "false"),
  __USE_CUSTOM_SKIN__: env("USE_CUSTOM_SKIN", "false"),
  __SCROLL_DIRECTION__: env("SCROLL_DIRECTION", "vertical"),
  __VIDEO_START_POSITION__: env("VIDEO_START_POSITION", "start"),
};
const INDEX_HTML = Buffer.from(
  Object.entries(REACT_VARIABLES).reduce(
    (html, [placeholder, value]) => html.replaceAll(placeholder, () => value),
    fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8"),
  ),
);

// Static files that are served as-is (every other path serves the React app)
const ASSET_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".ico",
  ".json",
  ".webmanifest",
  ".jpg",
  ".png",
]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".ogg": "video/ogg",
  ".png": "image/png",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
};

// Helpers - Responses
const send = (res, statusCode, headers = {}) => {
  res.writeHead(statusCode, headers);
  res.end();
};
const sendJSON = (req, res, data) => {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(req.method === "HEAD" ? undefined : body);
};
const sendIndex = (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": INDEX_HTML.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : INDEX_HTML);
};

// Helpers - Files
const statOrNull = (filePath) => fsp.stat(filePath).catch(() => null);
const isInside = (filePath, dir) =>
  filePath === dir || filePath.startsWith(`${dir}${path.sep}`);

const isNotModified = (req, etag, mtime) => {
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch)
    return ifNoneMatch
      .split(",")
      .some((tag) => ["*", etag].includes(tag.trim().replace(/^W\//, "")));

  const ifModifiedSince = Date.parse(req.headers["if-modified-since"]);
  return Math.floor(mtime.getTime() / 1000) * 1000 <= ifModifiedSince;
};

// Returns { start, end }, null when the whole file should be sent, or false when unsatisfiable
// (multiple ranges are not supported, so the whole file is sent instead)
const parseRange = (header, size) => {
  const [, first, last] = /^bytes=(\d*)-(\d*)$/.exec(header ?? "") ?? [];
  if (!first && !last) return null;

  // Suffix range : the last N bytes
  if (!first)
    return Number(last) > 0 && size > 0
      ? { start: Math.max(size - Number(last), 0), end: size - 1 }
      : false;

  if (last && Number(last) < Number(first)) return null;
  if (Number(first) >= size) return false;
  return {
    start: Number(first),
    end: last ? Math.min(Number(last), size - 1) : size - 1,
  };
};

const sendFile = (req, res, filePath, stats) => {
  const etag = `"${stats.mtime.getTime().toString(36)}${stats.size.toString(36)}"`;
  const lastModified = stats.mtime.toUTCString();

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", lastModified);
  res.setHeader(
    "Content-Type",
    MIME_TYPES[path.extname(filePath).toLowerCase()] ??
      "application/octet-stream",
  );

  if (isNotModified(req, etag, stats.mtime)) return send(res, 304);

  // Range requests (required for video seeking, especially on Safari)
  const ifRange = req.headers["if-range"];
  const range =
    !ifRange || [etag, lastModified].includes(ifRange)
      ? parseRange(req.headers.range, stats.size)
      : null;
  if (range === false)
    return send(res, 416, { "Content-Range": `bytes */${stats.size}` });

  const { start, end } = range || { start: 0, end: stats.size - 1 };
  if (range) {
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stats.size}`);
  }
  res.setHeader("Content-Length", end - start + 1);

  if (req.method === "HEAD" || end < start) return res.end();
  pipeline(fs.createReadStream(filePath, { start, end }), res, () => {});
};

const listDirectory = async (dirPath) => {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      // Follow symbolic links, and skip broken ones
      const stats = await statOrNull(path.join(dirPath, entry.name));
      if (!stats) return null;

      const isDir = stats.isDirectory();
      return {
        name: isDir ? `${entry.name}/` : entry.name,
        size: stats.size,
        url: `./${encodeURIComponent(entry.name)}${isDir ? "/" : ""}`,
        mod_time: stats.mtime.toISOString(),
        is_dir: isDir,
        is_symlink: entry.isSymbolicLink(),
      };
    }),
  );

  // Directories first, then alphabetical order
  return items
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.is_dir - a.is_dir ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
};

// Helpers - Authentication
const safeEqual = (a, b) => {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
};

// Accepts either the hash provided as a query parameter, or Basic Authentication
// (in which case the hash is sent back to the client for subsequent requests)
const authenticate = async (req, res, url) => {
  if (safeEqual(url.searchParams.get("hash") ?? "", AUTH_SECRET)) return true;

  const [scheme, credentials] = (req.headers.authorization ?? "").split(" ");
  if (scheme?.toLowerCase() !== "basic" || !credentials) return false;

  // Browsers encode credentials with btoa(), hence Latin-1
  const decoded = Buffer.from(credentials, "base64").toString("latin1");
  const separator = decoded.indexOf(":");
  if (separator === -1 || decoded.slice(0, separator) !== "Erin") return false;
  if (!(await bcrypt.compare(decoded.slice(separator + 1), AUTH_SECRET)))
    return false;

  res.setHeader("X-ERIN-HASH", AUTH_SECRET);
  return true;
};

// Handlers
const handleMedia = async (req, res, url, urlPath) => {
  // CORS
  res.setHeader("Vary", "Origin");
  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Authorization, X-ERIN-HASH",
    );
  }

  // CORS - Preflight
  if (req.method === "OPTIONS")
    return send(res, 204, {
      "Access-Control-Allow-Methods": "GET, HEAD",
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Max-Age": "3600",
    });

  if (!["GET", "HEAD"].includes(req.method))
    return send(res, 405, { Allow: "GET, HEAD, OPTIONS" });

  // Authentication (no WWW-Authenticate header, to prevent the browser's prompt)
  if (AUTH_ENABLED && !(await authenticate(req, res, url)))
    return send(res, 401);

  // File server
  const filePath = path.join(MEDIA_DIR, urlPath.slice("/media".length));
  const stats = await statOrNull(filePath);
  if (stats?.isDirectory())
    return sendJSON(req, res, await listDirectory(filePath));
  if (!stats?.isFile()) return send(res, 404);
  return sendFile(req, res, filePath, stats);
};

const handleApp = async (req, res, urlPath) => {
  if (!["GET", "HEAD"].includes(req.method))
    return send(res, 405, { Allow: "GET, HEAD" });

  // React app
  if (!ASSET_EXTENSIONS.has(path.extname(urlPath).toLowerCase()))
    return sendIndex(req, res);

  // React assets (never exposing the media directory, which lives inside)
  const filePath = path.join(APP_DIR, urlPath);
  const stats = isInside(filePath, MEDIA_DIR)
    ? null
    : await statOrNull(filePath);
  if (!stats?.isFile()) return send(res, 404);
  return sendFile(req, res, filePath, stats);
};

// Server
const server = http.createServer(async (req, res) => {
  try {
    let url, urlPath;
    try {
      url = new URL(`http://localhost${req.url}`);
      // Decoded and normalized, which prevents path traversal ("/../" can't go above "/")
      urlPath = path.posix.normalize(decodeURIComponent(url.pathname));
    } catch {
      return send(res, 400);
    }

    if (urlPath.startsWith("/media/"))
      await handleMedia(req, res, url, urlPath);
    else await handleApp(req, res, urlPath);
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.destroy();
    else send(res, 500);
  }
});

server.listen(PORT, () => console.log(`Erin is listening on port ${PORT}`));

// Exit promptly when the container is stopped
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => process.exit(0));
