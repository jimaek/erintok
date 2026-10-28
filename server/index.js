// Dependencies
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const send = require("send");

// Server configuration
const PORT = 80;
const APP_DIR = "/srv";
const MEDIA_DIR = "/srv/videos";

// User configuration (environment variables)
const env = (name, fallback) => process.env[name] ?? fallback;
const exitWithError = (message) => {
  console.error(message);
  process.exit(1);
};
const AUTH_ENABLED = env("AUTH_ENABLED", "true") === "true";
const AUTH_SECRET = env("AUTH_SECRET", "");
// Hash of "secure-password", the default value of previous versions
const PUBLIC_AUTH_SECRET =
  "$2a$14$qRW8no8UDmSwIWM6KHwdRe1j/LMrxoP4NSM756RVodqeUq5HzG6t.";

if (AUTH_ENABLED && [PUBLIC_AUTH_SECRET, ""].includes(AUTH_SECRET))
  exitWithError(
    "AUTH_SECRET must be set to the bcrypt hash of your own password (or set AUTH_ENABLED to false).",
  );
if (AUTH_ENABLED && !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(AUTH_SECRET))
  exitWithError(
    "AUTH_SECRET is not a valid bcrypt hash. Make sure it has no surrounding quotes, and that its dollar signs were not interpolated.",
  );
if (process.env.PUBLIC_URL)
  console.warn(
    "PUBLIC_URL is no longer used: Erin listens on port 80 over plain HTTP. Put a reverse proxy in front of it for HTTPS.",
  );

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

// Helpers - Responses
const reply = (res, statusCode, headers = {}) => {
  res.writeHead(statusCode, headers);
  res.end();
};
const replyJSON = (res, data) => {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
};
const replyIndex = (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": INDEX_HTML.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : INDEX_HTML);
};

// Serves a file with support for HEAD, Range and conditional requests
const replyFile = (req, res, root, filePath, options = {}) =>
  send(req, encodeURI(filePath), { root, index: false, ...options })
    .on("error", (err) => {
      if (err.status >= 500 || !err.status) console.error(err);
      if (res.headersSent) res.destroy();
      else reply(res, err.status ?? 500);
    })
    .pipe(res);

// Helpers - Files
// Returns null when the file doesn't exist (any other error is thrown)
const statIfExists = (filePath) =>
  fsp.stat(filePath).catch((err) => {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(err.code)) return null;
    throw err;
  });
const isInside = (filePath, dir) =>
  filePath === dir || filePath.startsWith(`${dir}${path.sep}`);

const listDirectory = async (dirPath) => {
  const items = [];
  for (const entry of await fsp.readdir(dirPath, { withFileTypes: true })) {
    // Follow symbolic links, and skip broken ones
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      const stats = await statIfExists(path.join(dirPath, entry.name));
      if (!stats) continue;
      isDir = stats.isDirectory();
    }

    items.push({
      name: isDir ? `${entry.name}/` : entry.name,
      url: `./${encodeURIComponent(entry.name)}${isDir ? "/" : ""}`,
      is_dir: isDir,
      is_symlink: entry.isSymbolicLink(),
    });
  }

  // Directories first, then alphabetical order
  return items.sort(
    (a, b) =>
      b.is_dir - a.is_dir ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
};

// Helpers - Authentication
const sha256 = (value) => crypto.createHash("sha256").update(value).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

// bcrypt is slow by design, so passwords are checked one at a time and excess attempts
// are rejected, preventing floods of login attempts from starving the server.
// The verified password is cached, so that returning users skip bcrypt altogether.
const MAX_PENDING_CHECKS = 5;
let pendingChecks = 0;
let checksQueue = Promise.resolve();
let verifiedPasswordDigest = null;

// Returns "granted", "denied", or "busy"
const checkPassword = async (password) => {
  const digest = sha256(password);
  if (
    verifiedPasswordDigest &&
    crypto.timingSafeEqual(digest, verifiedPasswordDigest)
  )
    return "granted";
  if (pendingChecks >= MAX_PENDING_CHECKS) return "busy";

  pendingChecks++;
  const check = checksQueue.then(() => bcrypt.compare(password, AUTH_SECRET));
  checksQueue = check.catch(() => {});
  try {
    if (!(await check)) return "denied";
    verifiedPasswordDigest = digest;
    return "granted";
  } finally {
    pendingChecks--;
  }
};

// Accepts either the hash provided as a query parameter, or Basic Authentication
// (in which case the hash is sent back to the client for subsequent requests)
// Returns "granted", "denied", or "busy"
const authenticate = async (req, res, url) => {
  if (safeEqual(url.searchParams.get("hash") ?? "", AUTH_SECRET))
    return "granted";

  const [scheme, credentials] = (req.headers.authorization ?? "").split(" ");
  if (scheme?.toLowerCase() !== "basic" || !credentials) return "denied";

  // Browsers encode credentials with btoa(), hence Latin-1
  const decoded = Buffer.from(credentials, "base64").toString("latin1");
  const separator = decoded.indexOf(":");
  if (separator === -1 || decoded.slice(0, separator) !== "Erin")
    return "denied";

  const access = await checkPassword(decoded.slice(separator + 1));
  if (access === "granted") res.setHeader("X-ERIN-HASH", AUTH_SECRET);
  return access;
};

// Handlers
const handleMedia = async (req, res, url, urlPath) => {
  if (!["GET", "HEAD"].includes(req.method))
    return reply(res, 405, { Allow: "GET, HEAD" });

  // Authentication (no WWW-Authenticate header, to prevent the browser's prompt)
  if (AUTH_ENABLED) {
    const access = await authenticate(req, res, url);
    if (access === "busy") return reply(res, 429, { "Retry-After": "5" });
    if (access === "denied") return reply(res, 401);
  }

  // File server
  const filePath = urlPath.slice("/media".length);
  const stats = await statIfExists(path.join(MEDIA_DIR, filePath));
  if (stats?.isDirectory()) {
    // HEAD is only used to check credentials : skip the listing
    if (req.method === "HEAD")
      return reply(res, 200, {
        "Content-Type": "application/json; charset=utf-8",
      });
    return replyJSON(res, await listDirectory(path.join(MEDIA_DIR, filePath)));
  }
  return replyFile(req, res, MEDIA_DIR, filePath, { dotfiles: "allow" });
};

const handleApp = (req, res, urlPath) => {
  if (!["GET", "HEAD"].includes(req.method))
    return reply(res, 405, { Allow: "GET, HEAD" });

  // React app
  if (!ASSET_EXTENSIONS.has(path.extname(urlPath).toLowerCase()))
    return replyIndex(req, res);

  // React assets (never exposing the media directory, which lives inside)
  if (isInside(path.join(APP_DIR, urlPath), MEDIA_DIR)) return reply(res, 404);
  return replyFile(req, res, APP_DIR, urlPath);
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
      return reply(res, 400);
    }

    if (urlPath.startsWith("/media/"))
      await handleMedia(req, res, url, urlPath);
    else handleApp(req, res, urlPath);
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.destroy();
    else reply(res, 500);
  }
});

server.listen(PORT, () => console.log(`Erin is listening on port ${PORT}`));

// Exit promptly when the container is stopped
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => process.exit(0));
