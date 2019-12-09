import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as zlib from 'zlib';
import * as LRUCache from 'lru-cache';
import * as cp from 'child_process';

const PORT = 2615;
const HOST = 'api.iswaac.org';
const GZIP_SIZE = 4096;
const MAX_QUEUE_SIZE = 100;
const MAX_TASKS_COUNT = 1e4;
const QTASK_CHECK_INTERVAL = 1000;
const QTASK_TIMEOUT = 60e3;
const GIT_BASE_URL = 'https://github.com';
const BASH_SCRIPT = 'sh/tm3d';
const TASK_TEMP_DIR = '/tmp/sw3d/task';
const TASK_RES_JSON = `${TASK_TEMP_DIR}/json/tm3d.json`;
const RES_JSON_DIR = '/tmp/sw3d/json';
const RES_JSON_FILE = '3d.json';
const CERT_DIR = `/etc/letsencrypt/live/${HOST}`;
const CERT_KEYFILE = 'privkey.pem';
const CERT_CERFILE = 'cert.pem';
const CORS_ORIGIN = 'Access-Control-Allow-Origin';
const CONTENT_TYPE = 'Content-Type';
const CONTENT_ENCODING = 'Content-Encoding';
// e.g. /json/microsoft/TypeScript/src
const VALID_URL = /^\/json(\/[\w][\w-._]*){2,}$/;

interface SResp {
  statusCode?: number;
  statusMessage?: string;
  headers?: any;
  text?: string;
  html?: string;
  json?: any;
  body?: string | Buffer;
}

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusMessage = '',
    public readonly description = '',
  ) {
    super(`HTTP ${statusCode} ${statusMessage}: ${description}`);
  }
}

let log = {
  d(...args) {
    console.debug(...args);
  },
  i(...args) {
    console.info(...args);
  },
  w(...args) {
    console.warn(...args);
  },
  e(...args) {
    console.error(...args);
  },
};

enum QTaskState {
  NONE,
  QUEUED,
  RUNNING,
  READY,
  FAILED,
}

/**
 * Lifecycle of a task:
 * 
 *    --> Queued --> Processing --> Ready
 *                       |
 *                       v
 *                     Failed
 * 
 *  - Queued: in-memory 100 tasks FIFO queue,
 *      not backed up to disk, lost on crash;
 *      a timer picks tasks from the queue.
 * 
 *  - Processing: only 1 task is being processed
 *      at a time; intermediate data gets written
 *      to /tmp/sw3d/task; consists of stages:
 * 
 *        1. git clone -> *.ts sources
 *        2. tsc -> ast.json
 *        3. d3.treemap -> treemap.json
 *        4. 3d layout -> layout.json
 * 
 *  - Ready: the 3d layout json is saved to
 *      /tmp/sw3d/json/<owner>/<project>/<path>/3d.json
 * 
 *  - Failed: the error is kept in memory and
 *      is lost on process exit.
 */
class QTask {
  static readonly tqueue: QTask[] = [];
  static readonly rtasks = new LRUCache<string, QTask>(MAX_TASKS_COUNT);
  static qwatcher?: NodeJS.Timer;
  static tpending?: QTask;
  static tprocess?: cp.ChildProcess;
  static tpromise?: Promise<string>;

  public duration = 0;
  public error?: Error;

  static get(id: string) {
    let t = QTask.rtasks.get(id)
      || new QTask(id);
    QTask.rtasks.set(id, t);
    return t;
  }

  private static startQueueWatcher() {
    if (QTask.qwatcher) return;
    QTask.qwatcher = setInterval(
      QTask.checkQueue,
      QTASK_CHECK_INTERVAL);
  }

  private static checkQueue() {
    if (!QTask.tqueue.length || QTask.tpending)
      return;
    let [t] = QTask.tqueue.splice(0, 1);
    QTask.tpending = t;
    t.process();
  }

  private constructor(public readonly id: string) { }

  get state(): QTaskState {
    if (this.error)
      return QTaskState.FAILED;
    if (this === QTask.tpending)
      return QTaskState.RUNNING;
    if (this.qpos > 0)
      return QTaskState.QUEUED;
    if (this.duration > 0 || this.hasJsonFile())
      return QTaskState.READY;
    return QTaskState.NONE;
  }

  get qpos() {
    return 1 + QTask.tqueue.indexOf(this);
  }

  get json() {
    let jsonpath = this.getJsonPath();
    return fs.readFileSync(jsonpath, 'utf8');
  }

  enqueue() {
    if (QTask.tqueue.length >= MAX_QUEUE_SIZE)
      throw new HttpError(500, 'Queue Full',
        `There are already ${QTask.tqueue.length} tasks in the queue`);

    log.i('task', this.id, 'enqueued');
    QTask.tqueue.push(this);
    QTask.startQueueWatcher();
  }

  private async process() {
    log.i('task', this.id, 'started');
    let { owner, project, relpath } = this.parseId();
    let time = Date.now();

    try {
      QTask.tpending = this;
      QTask.tpromise = new Promise((resolve, reject) => {
        let url = `${GIT_BASE_URL}/${owner}/${project}`;
        let command = `${BASH_SCRIPT} ${url} /${relpath} ${TASK_TEMP_DIR}`;
        let proc = cp.exec(command, (err, res) =>
          err ? reject(err) : resolve(res));

        QTask.tprocess = proc;
        log.i(`pid ${proc.pid}: ${command}`);

        let timer = setTimeout(() => {
          if (proc.pid !== QTask.tprocess?.pid)
            return;
          log.i(`pid ${proc.pid} timed out`);
          cp.exec(`kill ${proc.pid}`);
          reject(new Error('Timed out'));
        }, QTASK_TIMEOUT);

        proc.on('exit', () => clearTimeout(timer));
      });

      await QTask.tpromise;
      log.i('bash script finished');

      let jsonpath = this.getJsonPath();
      let jsondir = path.dirname(jsonpath);
      log.i(`moving the json file to ${jsonpath}`);
      cp.execSync(`mkdir -p ${jsondir}`);
      fs.renameSync(TASK_RES_JSON, jsonpath);
      log.i('task', this.id, 'finished');
    } catch (err) {
      log.e('bash script failed:', err);
      this.error = err;
    } finally {
      this.duration = Date.now() - time;
      log.i('task', this.id, 'done in', this.duration, 'ms');
      QTask.tpending = undefined;
      QTask.tpromise = undefined;
      QTask.tpromise = undefined;
    }
  }

  private getJsonPath() {
    let { owner, project, relpath } = this.parseId();
    return `${RES_JSON_DIR}/${owner}/${project}/${relpath}/${RES_JSON_FILE}`;
  }

  private hasJsonFile() {
    return fs.existsSync(this.getJsonPath());
  }

  private parseId() {
    let [owner, project, ...path] = this.id.split('/');
    return { owner, project, relpath: path.join('/') };
  }
}

async function executeHandler(req: http.IncomingMessage): Promise<SResp | null> {
  if (!req.url || !VALID_URL.test(req.url))
    throw new HttpError(400, 'URL');

  let id = req.url.split('/').slice(2).join('/');
  let task = QTask.get(id);

  switch (task.state) {
    case QTaskState.READY:
      return { body: task.json, headers: { [CONTENT_TYPE]: 'application/json' } };
    case QTaskState.FAILED:
      throw new HttpError(500, 'Task Failed', task.error + '');
    case QTaskState.QUEUED:
    case QTaskState.NONE:
      if (task.state == QTaskState.NONE)
        task.enqueue();
      return { statusCode: 201, statusMessage: 'Waiting', text: 'Position in queue: ' + task.qpos };
    case QTaskState.RUNNING:
      return { statusCode: 202, statusMessage: 'Running', text: 'Running' };
    default:
      throw new Error('Unexpected task state: ' + task.state);
  }
}

async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  log.i(req.method, req.url);
  res.setHeader(CORS_ORIGIN, '*');

  try {
    let rsp = await executeHandler(req);
    if (!rsp) throw new HttpError(400);

    if (typeof rsp.body == 'string') {
      if (GZIP_SIZE > 0 && rsp.body.length >= GZIP_SIZE) {
        let gtime = Date.now();
        let gzipped = await gzipText(rsp.body);
        gtime = Date.now() - gtime;
        rsp.body = gzipped;
        rsp.headers = {
          ...rsp.headers,
          [CONTENT_ENCODING]: 'gzip',
        };
      }
    }

    for (let name in rsp.headers || {}) {
      res.setHeader(name, rsp.headers[name]);
    }

    if (rsp.text) {
      res.setHeader(CONTENT_TYPE, 'text/plain');
      res.write(rsp.text);
    } else if (rsp.json) {
      res.setHeader(CONTENT_TYPE, 'application/json');
      res.write(JSON.stringify(rsp.json));
    } else if (rsp.html) {
      res.setHeader(CONTENT_TYPE, 'text/html');
      res.write(rsp.html);
    } else if (rsp.body) {
      res.write(rsp.body);
    }

    res.statusCode = rsp.statusCode || 200;
    res.statusMessage = rsp.statusMessage || '';
  } catch (err) {
    if (err instanceof HttpError) {
      res.statusCode = err.statusCode;
      res.statusMessage = err.statusMessage;
      res.write(err.description);
    } else {
      res.statusCode = 500;
      log.e('Failed:', err);
    }
  } finally {
    res.end();
    log.i('HTTP', res.statusCode);
  }
}

function gzipText(text: string) {
  return new Promise<Buffer>((resolve, reject) => {
    zlib.gzip(text, (err, buf) => {
      if (err) {
        reject(err);
      } else {
        resolve(buf);
      }
    });
  });
}

function createServer() {
  log.i('Checking the cert dir:', CERT_DIR);
  if (fs.existsSync(CERT_DIR)) {
    log.i('Starting HTTPS server.');
    let key = fs.readFileSync(path.join(CERT_DIR, CERT_KEYFILE));
    let cert = fs.readFileSync(path.join(CERT_DIR, CERT_CERFILE));
    return https.createServer({ key, cert }, handleHttpRequest);
  } else {
    log.i('SSL certs not found.');
    log.i('Starting HTTP server.');
    return http.createServer(handleHttpRequest);
  }
}

function startServer() {
  let server = createServer();
  server.listen(PORT);
  server.on('error', err => {
    log.e(err);
    process.exit(1);
  });
  server.on('listening', () => {
    log.w('Listening on port', PORT);
  });
}

startServer();