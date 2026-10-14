const fs = require('fs');
const path = require('path');

/**
 * Static file handler for the packaged app's local HTTP server.
 *
 * Lives in its own module so it can be exercised directly by plain Node --
 * it serves the whole renderer (index.html plus a ~2.9MB bundle), so a bug
 * here is a blank window for every user, and that is not something to verify
 * only by launching the app and looking at it.
 *
 * `distPath` is the built renderer; `getMediaDir` is resolved per request
 * because the bundled videos live outside dist (see main.js).
 */
function createStaticHandler({ distPath, getMediaDir }) {
  return (req, res) => {
  // 1. Decode URL to handle spaces (%20) and special characters in paths
  let decodedUrl = req.url;
  try {
    decodedUrl = decodeURIComponent(req.url);
  } catch (e) {
    console.error('[Production Server] Failed to decode URL:', req.url, e);
  }

  // 2. Strip query parameters (e.g., ?videoId=xxx)
  const parsedUrl = decodedUrl.split('?')[0];

  // The videos no longer live in dist/: they ship unpacked under
  // resources/videos so nothing has to read them out of the asar (see
  // getMediaDir). This route is only the fallback — normally the renderer
  // asks for them over knockdesk-media:// and never reaches this server.
  const isMediaRoute = parsedUrl.startsWith('/videos/');
  const rootDir = isMediaRoute ? getMediaDir() : distPath;
  const relativePath = isMediaRoute
    ? parsedUrl.slice('/videos/'.length)
    : (parsedUrl === '/' ? 'index.html' : parsedUrl);
  let filePath = path.join(rootDir, relativePath);

  // Security: prevent directory traversal (each root guards its own tree)
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const extname = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm', // MediaPipe gesture-control WASM (needs correct MIME for streaming compile)
    '.task': 'application/octet-stream' // MediaPipe model bundle
  };

  const contentType = mimeTypes[extname] || 'application/octet-stream';

  // Check if file exists
  fs.stat(filePath, (err, stats) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // A missing media file is a plain 404: handing the SPA's index.html
        // to a <video> element only turns it into an unreadable-format error.
        if (isMediaRoute) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        // SPA fallback - serve index.html for any unknown route
        fs.readFile(path.join(distPath, 'index.html'), (err, indexContent) => {
          if (err) {
            res.writeHead(500);
            res.end('Server Error');
          } else {
            // no-cache: an update ships new hashed asset names, and a
            // cached shell pointing at the old ones renders nothing.
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
            res.end(indexContent, 'utf-8');
          }
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
      return;
    }

    // Support HTTP Range Requests for streaming media (like MP4)
    const range = req.headers.range;
    if (range && (contentType.startsWith('video/') || contentType.startsWith('audio/'))) {
      const totalSize = stats.size;
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      if (start >= totalSize || end >= totalSize) {
        res.writeHead(416, {
          'Content-Range': `bytes */${totalSize}`
        });
        res.end();
        return;
      }

      const chunkSize = (end - start) + 1;
      const stream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      });

      stream.pipe(res);
    } else if (contentType.startsWith('video/') || contentType.startsWith('audio/')) {
      // Media without a Range header (the player's very first request).
      // Streamed rather than read into a Buffer — the walkthrough is ~92MB
      // and readFile would hold all of it in the main process's heap before
      // a single frame was sent. Accept-Ranges is what tells the player it
      // may seek instead of downloading the whole file first.
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      // Standard file delivery.
      //
      // Streamed, not readFile'd: the app bundle is ~2.9MB and this server
      // lives in the main process, so buffering whole files here competes
      // with everything else that process has to do during boot.
      //
      // The validator turns every launch after the first into a handful of
      // 304s instead of re-sending the whole bundle. Vite's /assets/ names
      // carry a content hash, so those can be cached hard; anything else
      // (index.html above all) must revalidate, or an updated app would go
      // on serving the previous build's HTML — which points at asset names
      // that no longer exist, i.e. a blank window.
      const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
      const isHashedAsset = parsedUrl.startsWith('/assets/');
      const headers = {
        'Content-Type': contentType,
        'ETag': etag,
        'Cache-Control': isHashedAsset
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      };

      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }

      headers['Content-Length'] = stats.size;
      res.writeHead(200, headers);
      const stream = fs.createReadStream(filePath);
      stream.on('error', (streamErr) => {
        console.error('[Production Server] Stream failed:', filePath, streamErr.code);
        res.destroy();
      });
      stream.pipe(res);
    }
  });
  };
}

module.exports = { createStaticHandler };
