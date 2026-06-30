import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const services = path.dirname(fileURLToPath(import.meta.url));
const component = path.dirname(services);
const data = path.join(component, 'data');
const todosPath = path.join(data, 'todos.json');
const logPath = process.argv[2];

if (!logPath) {
  throw new Error('missing log path');
}

fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const log = (...values) => {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`);
  console.log(...values);
};

const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const readTodos = () => {
  try {
    return JSON.parse(fs.readFileSync(todosPath, 'utf8'));
  } catch {
    return [];
  }
};

const writeTodos = todos => {
  fs.writeFileSync(todosPath, JSON.stringify(todos, null, 2));
  log('writeTodos', { count: todos.length });
  return todos;
};

const readJson = request => new Promise((resolve, reject) => {
  request.setEncoding('utf8');
  request.on('data', chunk => request.body = `${request.body || ''}${chunk}`);
  request.on('end', () => {
    try {
      log('requestBody', request.body || '');
      resolve(request.body ? JSON.parse(request.body) : {});
    } catch (error) {
      reject(error);
    }
  });
  request.on('error', reject);
});

const send = (response, status, headers, body) => {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...headers
  });
  response.end(body);
};

const json = (response, status, value) => send(response, status, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(value));

const renderView = origin => {
  const todos = readTodos();
  const active = todos.filter(todo => !todo.done).length;
  const plural = active === 1 ? 'reminder' : 'reminders';
  const rows = todos.map((todo, index) => `
    <li class="todo-item ${todo.done ? 'is-done' : ''}" style="--row-index: ${index}">
      <label class="todo-checkline">
        <input class="todo-checkbox" type="checkbox" ${todo.done ? 'checked' : ''} onchange="
          this.closest('.todo-item').classList.toggle('is-done', this.checked);
          fetch('${origin}/api/todos/${encodeURIComponent(todo.id)}', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ done: this.checked })
          })
          .catch(error => this.closest('.todo-app').querySelector('[data-status]').textContent = error.message);
        ">
        <span class="todo-title">${escapeHtml(todo.text)}</span>
      </label>
      <button class="todo-delete" type="button" aria-label="Delete ${escapeHtml(todo.text)}" onclick="
        this.closest('.todo-item').classList.add('is-removing');
        setTimeout(() => {
          fetch('${origin}/api/todos/${encodeURIComponent(todo.id)}', { method: 'DELETE' })
            .catch(error => this.closest('.todo-app').querySelector('[data-status]').textContent = error.message);
        }, 180);
      ">×</button>
    </li>`).join('');

  return `<section class="todo-app">
  <style>
    .todo-app {
      width: min(430px, calc(100vw - 40px));
      margin: 34px auto;
      color: #1d1d1f;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
      animation: todo-app-in 220ms cubic-bezier(.2, .8, .2, 1) both;
    }

    .todo-shell {
      overflow: hidden;
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 30px;
      background: rgba(255, 255, 255, 0.88);
      box-shadow: 0 22px 70px rgba(0, 0, 0, 0.14), 0 2px 10px rgba(0, 0, 0, 0.06);
      backdrop-filter: blur(24px) saturate(1.18);
    }

    .todo-header {
      padding: 27px 26px 18px;
      background: linear-gradient(180deg, rgba(248, 248, 250, 0.94), rgba(255, 255, 255, 0.76));
      border-bottom: 1px solid rgba(0, 0, 0, 0.06);
    }

    .todo-kicker {
      margin: 0 0 5px;
      color: #8e8e93;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }

    .todo-heading {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
    }

    .todo-heading h1 {
      margin: 0;
      font-size: 34px;
      font-weight: 720;
      letter-spacing: -0.04em;
      line-height: 1;
    }

    .todo-count {
      min-width: 72px;
      padding: 6px 11px;
      border-radius: 999px;
      background: #f2f2f7;
      color: #6e6e73;
      font-size: 13px;
      font-weight: 650;
      text-align: center;
      transition: transform 160ms ease, background 160ms ease;
    }

    .todo-form {
      display: flex;
      gap: 10px;
      padding: 18px;
      background: rgba(242, 242, 247, 0.72);
      border-bottom: 1px solid rgba(0, 0, 0, 0.06);
    }

    .todo-input {
      min-width: 0;
      flex: 1;
      height: 44px;
      box-sizing: border-box;
      padding: 0 15px;
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 15px;
      outline: none;
      background: rgba(255, 255, 255, 0.96);
      color: #1d1d1f;
      font: inherit;
      font-size: 16px;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.03);
      transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
    }

    .todo-input:focus {
      border-color: rgba(0, 122, 255, 0.45);
      box-shadow: 0 0 0 4px rgba(0, 122, 255, 0.12), inset 0 1px 2px rgba(0, 0, 0, 0.03);
    }

    .todo-add {
      height: 44px;
      padding: 0 17px;
      border: 0;
      border-radius: 15px;
      background: #007aff;
      color: white;
      font: inherit;
      font-size: 16px;
      font-weight: 650;
      cursor: pointer;
      box-shadow: 0 8px 18px rgba(0, 122, 255, 0.26);
      transition: transform 120ms ease, opacity 120ms ease, box-shadow 120ms ease;
    }

    .todo-add:active {
      transform: scale(0.96);
      box-shadow: 0 4px 10px rgba(0, 122, 255, 0.18);
    }

    .todo-add:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .todo-list {
      list-style: none;
      margin: 0;
      padding: 8px 0;
      background: rgba(255, 255, 255, 0.8);
    }

    .todo-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 56px;
      margin: 0;
      padding: 0 18px 0 22px;
      border-bottom: 1px solid rgba(60, 60, 67, 0.12);
      animation: todo-row-in 260ms cubic-bezier(.2, .8, .2, 1) both;
      animation-delay: calc(min(var(--row-index), 8) * 24ms);
      transition: opacity 170ms ease, transform 170ms ease, min-height 170ms ease, padding 170ms ease;
    }

    .todo-item:last-child {
      border-bottom: 0;
    }

    .todo-item.is-removing {
      min-height: 0;
      opacity: 0;
      padding-top: 0;
      padding-bottom: 0;
      transform: translateX(18px) scale(0.98);
    }

    .todo-checkline {
      display: flex;
      align-items: center;
      min-width: 0;
      flex: 1;
      gap: 12px;
      cursor: pointer;
    }

    .todo-checkbox {
      width: 22px;
      height: 22px;
      margin: 0;
      accent-color: #34c759;
      cursor: pointer;
      transition: transform 140ms ease;
    }

    .todo-checkbox:active {
      transform: scale(0.88);
    }

    .todo-title {
      overflow: hidden;
      color: #1d1d1f;
      font-size: 17px;
      letter-spacing: -0.012em;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color 160ms ease, opacity 160ms ease, text-decoration-color 160ms ease;
    }

    .todo-item.is-done .todo-title {
      color: #8e8e93;
      opacity: 0.78;
      text-decoration: line-through;
      text-decoration-color: rgba(142, 142, 147, 0.7);
    }

    .todo-delete {
      width: 30px;
      height: 30px;
      margin-left: 12px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #c7c7cc;
      font-size: 24px;
      line-height: 1;
      cursor: pointer;
      opacity: 0.72;
      transition: background 120ms ease, color 120ms ease, opacity 120ms ease, transform 120ms ease;
    }

    .todo-delete:hover {
      background: #f2f2f7;
      color: #ff3b30;
      opacity: 1;
    }

    .todo-delete:active {
      transform: scale(0.9);
    }

    .todo-empty {
      padding: 38px 24px 42px;
      color: #8e8e93;
      font-size: 16px;
      text-align: center;
      animation: todo-row-in 240ms cubic-bezier(.2, .8, .2, 1) both;
    }

    .todo-footer {
      min-height: 18px;
      padding: 11px 18px 15px;
      border-top: 1px solid rgba(0, 0, 0, 0.06);
      background: rgba(248, 248, 250, 0.76);
      color: #8e8e93;
      font-size: 12px;
      text-align: center;
    }

    .todo-footer:empty {
      padding: 7px 18px;
    }

    @keyframes todo-app-in {
      from { opacity: 0; transform: translateY(6px) scale(0.995); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes todo-row-in {
      from { opacity: 0; transform: translateY(8px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @media (prefers-reduced-motion: reduce) {
      .todo-app,
      .todo-item,
      .todo-empty {
        animation: none;
      }

      .todo-item,
      .todo-title,
      .todo-checkbox,
      .todo-add,
      .todo-delete,
      .todo-input,
      .todo-count {
        transition: none;
      }
    }
  </style>
  <div class="todo-shell">
    <header class="todo-header">
      <p class="todo-kicker">Today</p>
      <div class="todo-heading">
        <h1>Reminders</h1>
        <span class="todo-count">${active} ${plural}</span>
      </div>
    </header>
    <form class="todo-form" onsubmit="
      event.preventDefault();
      if (!this.text.value.trim()) return;
      this.querySelector('button').disabled = true;
      this.querySelector('.todo-input').style.transform = 'scale(0.99)';
      fetch('${origin}/api/todos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: this.text.value })
      })
      .catch(error => {
        this.querySelector('button').disabled = false;
        this.querySelector('.todo-input').style.transform = '';
        this.closest('.todo-app').querySelector('[data-status]').textContent = error.message;
      });
    ">
      <input class="todo-input" name="text" type="text" placeholder="New reminder" autocomplete="off">
      <button class="todo-add" type="submit">Add</button>
    </form>
    <ul class="todo-list">${rows || '<li class="todo-empty">No reminders</li>'}</ul>
    <div class="todo-footer" data-status></div>
  </div>
</section>`;
};

// The component shell (component.html) gives us a #todo-root region; this
// service streams the rendered list into it as an <lqpatch> on fd 3 — the
// harness's view-patch channel — so each change lands live with no file write.
// stdout/stderr stay free for the logging above.
let viewOrigin = '';
const writeView = () => {
  // The component renders rendered.html through a <liquidos-file>; rewriting that
  // file IS the whole view channel — the watcher morphs each change into the DOM,
  // the same path the agent's file writes take. No fd 3, no lqpatch.
  fs.writeFileSync(path.join(component, 'rendered.html'), renderView(viewOrigin));
  log('writeView', { origin: viewOrigin });
};

const server = http.createServer((request, response) => {
  log('request', request.method, request.url);

  if (request.method === 'OPTIONS') {
    return send(response, 204, {}, '');
  }

  if (request.method === 'GET' && request.url === '/api/todos') {
    return json(response, 200, readTodos());
  }

  if (request.method === 'POST' && request.url === '/api/todos') {
    return readJson(request)
      .then(body => {
        const todos = writeTodos([...readTodos(), { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text: String(body.text || '').trim() || 'Untitled todo', done: false }]);
        writeView();
        return json(response, 201, todos);
      })
      .catch(error => json(response, 400, { error: error.message }));
  }

  if (request.method === 'PATCH' && request.url.startsWith('/api/todos/')) {
    return readJson(request)
      .then(patch => {
        const todos = writeTodos(readTodos().map(todo => todo.id === decodeURIComponent(request.url.split('/').pop() || '') ? { ...todo, ...patch } : todo));
        writeView();
        return json(response, 200, todos);
      })
      .catch(error => json(response, 400, { error: error.message }));
  }

  if (request.method === 'DELETE' && request.url.startsWith('/api/todos/')) {
    const todos = writeTodos(readTodos().filter(todo => todo.id !== decodeURIComponent(request.url.split('/').pop() || '')));
    writeView();
    return json(response, 200, todos);
  }

  return json(response, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  viewOrigin = `http://127.0.0.1:${server.address().port}`;
  log('started', viewOrigin);
  writeView();
});

process.on('SIGTERM', () => {
  log('SIGTERM');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('SIGINT');
  server.close(() => process.exit(0));
});
