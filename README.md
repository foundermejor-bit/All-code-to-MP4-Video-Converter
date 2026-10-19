# Framewise — HTML → Video (Render + Docker)
Express queue → headless Chromium (Puppeteer, virtual clock, frame-by-frame) → FFmpeg → MP4/WebM/GIF.

## Deploy on Render
1. Push this folder to a GitHub repo (root = this folder).
2. Render → **New → Blueprint** (uses `render.yaml`) — or **New → Web Service → Docker**, health check path `/healthz`.
3. Do **not** set `PORT`; Render injects it (Dockerfile default 10000).
4. Optional env vars: `ACCESS_PASSWORD` (HTTP Basic password for the whole site, user name ignored), `MAX_PIXELS` (default 2073600 = 1080p; larger requests are auto-downscaled),
   `MAX_FRAMES` 1800, `MAX_FILE_MB` 2, `CONCURRENCY` 1, `MAX_PER_USER` 5, `MAX_QUEUE` 20, `JOB_TIMEOUT_SEC` 600, `RESULT_TTL_MIN` 60, `DATA_DIR`.
5. Storage: none needed. Files live in the container's temp dir (ephemeral), are deleted after `RESULT_TTL_MIN`, and the job list resets on restart/redeploy.
6. Memory: Chromium + FFmpeg are heavy. Free/512 MB plans may crash on large renders; use ≥2 GB RAM for 1080p and keep `CONCURRENCY=1`. Free instances also sleep when idle. Check Render's current plan specs.

## Local
`docker build -t framewise . && docker run -p 10000:10000 framewise` → http://localhost:10000

## Security model
- Uploaded HTML is never run by Node; only inside a throwaway Chromium (non-root container user, `--no-sandbox` because Docker has no user namespaces).
- Page network is filtered: only public http(s); loopback/private/link-local blocked, `file://` blocked, WebSocket/WebRTC disabled, dialogs/popups closed.
- Limits: 10 files × 2 MB, `.html/.htm` only, random server-side filenames, per-IP rate limits, per-user and global queue caps, job timeout.
- Per-visitor jobs via random session ID; downloads use unguessable 128-bit IDs.
- Residual risks: DNS-rebinding can bypass the hostname check; a malicious page can burn CPU until the timeout; anyone with the URL can queue jobs unless `ACCESS_PASSWORD` is set.
  Don't deploy in a Render workspace that has private internal services you can't expose.
