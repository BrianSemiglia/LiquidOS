import http from "node:http"
import { readFile, writeFile, rename, stat } from "node:fs/promises"

const truthPath = new URL("../data/truth.json", import.meta.url)
const viewPath = new URL("../view.json", import.meta.url)
const temporaryViewPath = new URL("../view.json.tmp", import.meta.url)

const log = (...values) =>
  console.log(new Date().toISOString(), "renderer:", ...values)

const escapeHtml = value =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const clampPercent = value =>
  Math.max(0, Math.min(100, Number(value) || 0))

const readTruth = () =>
  readFile(truthPath, "utf8")
    .then(JSON.parse)
    .catch(error => ({
      inputDeviceName: "Microphone",
      level: 0,
      peak: 0,
      active: false,
      status: "waiting",
      updatedAt: "not updated yet",
      error: error.message
    }))

const writeView = origin =>
  writeFile(temporaryViewPath, JSON.stringify({
    html: `
      <style>
        .microphone-activity-hud {
          width: 510px;
          padding: 22px 28px 24px;
          border-radius: 34px;
          color: rgba(255,255,255,.92);
          background: rgba(34,34,35,.72);
          border: 1px solid rgba(255,255,255,.12);
          box-shadow: 0 24px 70px rgba(0,0,0,.44), inset 0 1px 0 rgba(255,255,255,.08);
          backdrop-filter: blur(32px) saturate(1.35);
          -webkit-backdrop-filter: blur(32px) saturate(1.35);
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
          -webkit-font-smoothing: antialiased;
          display: grid;
          gap: 20px;
        }

        .microphone-activity-device {
          color: rgba(255,255,255,.46);
          font-size: 22px;
          font-weight: 650;
          letter-spacing: -.03em;
          line-height: 1;
        }

        .microphone-activity-row {
          display: grid;
          grid-template-columns: 26px 1fr 54px;
          align-items: center;
          gap: 16px;
        }

        .microphone-activity-icon {
          color: rgba(255,255,255,.72);
          display: grid;
          place-items: center;
        }

        .microphone-activity-icon svg {
          width: 25px;
          height: 25px;
          display: block;
        }

        .microphone-activity-track {
          position: relative;
          height: 8px;
          border-radius: 999px;
          background: rgba(255,255,255,.075);
          overflow: visible;
        }

        .microphone-activity-fill {
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 0%;
          border-radius: inherit;
          background: rgba(255,255,255,.62);
          transition: width 70ms linear;
        }

        .microphone-activity-peak {
          position: absolute;
          top: -3px;
          bottom: -3px;
          left: 0%;
          width: 2px;
          border-radius: 999px;
          background: rgba(255,255,255,.82);
          opacity: .75;
          transition: left 90ms linear;
        }

        .microphone-activity-ticks {
          position: absolute;
          inset: 0;
          display: grid;
          grid-template-columns: repeat(17, 1fr);
          align-items: center;
          pointer-events: none;
        }

        .microphone-activity-ticks span {
          width: 4px;
          height: 4px;
          border-radius: 999px;
          justify-self: center;
          background: rgba(255,255,255,.08);
        }

        .microphone-activity-state {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          color: rgba(255,255,255,.5);
          font-size: 13px;
          font-weight: 650;
          letter-spacing: -.02em;
        }

        .microphone-activity-dot {
          width: 9px;
          height: 9px;
          border-radius: 999px;
          background: rgba(255,255,255,.24);
        }

        .microphone-activity-dot.is-live {
          background: rgba(52,199,89,.95);
          box-shadow: 0 0 18px rgba(52,199,89,.7);
        }

        .microphone-activity-error {
          border-radius: 10px;
          padding: 8px 10px;
          color: rgba(255,210,207,.96);
          background: rgba(255,69,58,.18);
          font-size: 12px;
          line-height: 1.35;
        }
      </style>

      <section class="microphone-activity-hud" data-stream-origin="${escapeHtml(origin)}">
        <img
          alt=""
          src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
          style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none"
          onload="(() => {
            const root = this.closest('.microphone-activity-hud');
            if (!root || root.dataset.streamStarted) return;
            root.dataset.streamStarted = 'true';
            const setText = (selector, value) => { const element = root.querySelector(selector); if (element) element.textContent = value; };
            const setStyle = (selector, key, value) => { const element = root.querySelector(selector); if (element) element.style[key] = value; };
            const source = new EventSource(root.dataset.streamOrigin + '/events');
            source.onmessage = event => {
              const truth = JSON.parse(event.data);
              const level = Math.max(0, Math.min(100, Number(truth.level) || 0));
              const peak = Math.max(0, Math.min(100, Number(truth.peak) || 0));
              setText('.microphone-activity-device', truth.inputDeviceName || 'Microphone');
              setText('.microphone-activity-status', truth.active ? 'live' : (truth.status || 'idle'));
              setStyle('.microphone-activity-fill', 'width', level + '%');
              setStyle('.microphone-activity-peak', 'left', peak + '%');
              root.querySelector('.microphone-activity-dot')?.classList.toggle('is-live', !!truth.active);
              root.querySelector('.microphone-activity-error')?.remove();
              if (truth.error) root.insertAdjacentHTML('beforeend', '<div class=&quot;microphone-activity-error&quot;>' + String(truth.error).replace(/[&<>]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[character])) + '</div>');
            };
            source.onerror = () => setText('.microphone-activity-status', 'offline');
          })()"
        >

        <div class="microphone-activity-device">Microphone</div>

        <div class="microphone-activity-row">
          <div class="microphone-activity-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M12 14.5a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v5a3.5 3.5 0 0 0 3.5 3.5Z" fill="currentColor"/>
              <path d="M5.5 10.8a6.5 6.5 0 0 0 13 0M12 17.3V21M8.5 21h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </div>

          <div class="microphone-activity-track">
            <div class="microphone-activity-fill"></div>
            <div class="microphone-activity-peak"></div>
            <div class="microphone-activity-ticks" aria-hidden="true">
              ${Array.from({ length: 17 }, () => "<span></span>").join("")}
            </div>
          </div>

          <div class="microphone-activity-state">
            <span class="microphone-activity-dot"></span>
            <span class="microphone-activity-status">starting</span>
          </div>
        </div>
      </section>
    `
  }, null, 2) + "\n").then(() => rename(temporaryViewPath, viewPath))

let lastModified = 0
let sequence = 0
let clients = []

const send = (response, value) =>
  response.write(`data: ${JSON.stringify(value)}\n\n`)

const broadcast = value =>
  clients.forEach(response => send(response, value))

const server = http.createServer((request, response) => {
  if (request.url === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "access-control-allow-origin": "*"
    })
    clients = [...clients, response]
    request.on("close", () => clients = clients.filter(client => client !== response))
    return readTruth().then(truth => send(response, { ...truth, sequence }))
  }

  if (request.url === "/truth") {
    return readTruth().then(truth => {
      response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" })
      response.end(JSON.stringify({ ...truth, sequence }))
    })
  }

  response.writeHead(404)
  response.end("Not found")
})

const poll = () =>
  stat(truthPath)
    .then(file => {
      if (file.mtimeMs === lastModified) return
      lastModified = file.mtimeMs
      return readTruth().then(truth => {
        sequence += 1
        broadcast({ ...truth, sequence })
        log("streamed truth", `sequence=${sequence}`, `level=${clampPercent(truth.level)}`, `peak=${clampPercent(truth.peak)}`)
      })
    })
    .catch(error => log("poll error", error.message))

server.listen(0, "127.0.0.1", () => {
  writeView(`http://127.0.0.1:${server.address().port}`)
    .then(() => log("wrote view.json once", `origin=http://127.0.0.1:${server.address().port}`))
    .then(() => readTruth().then(truth => broadcast({ ...truth, sequence })))
    .catch(error => log("view write error", error.message))

  setInterval(poll, 80)
  log("stream server listening", `http://127.0.0.1:${server.address().port}`)
})
