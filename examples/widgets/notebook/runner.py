#!/usr/bin/env python3
"""Notebook kernel and store for the Hatch notebook widget. Standard library only.

One long-lived process per notebook window. It owns the notebook file (cells and their last outputs) and one Python
namespace that every cell runs in. Protocol: one JSON object per line on stdin (requests) and stdout (events).

Requests ("t"):
  hello                          answer with `hello` and the whole notebook
  cells   {cells:[{id,type,source}]}   replace the cell list (outputs of known ids are kept), saved at once
  run     {id, source}           queue a code cell
  stop                           interrupt the running cell and drop the queue
  restart                        fresh namespace (new kernel id)
Events: ready, hello, notebook, start, out, done, state, killed (and `chunk` pieces of any line over 100 kB).
Usage: runner.py DATA_DIR   (notebook.json is kept there)
"""
import ast, base64, builtins, io, json, os, queue, signal, sys, threading, time, traceback, uuid

CAP = int(os.environ.get('HATCH_NOTEBOOK_CAP', 10 * 1024 * 1024))   # stored output per cell (the variable is for tests)
LIVE_CAP = 1024 * 1024        # live `out` events per cell (the final `done` carries everything up to CAP)
CHUNK = 100_000               # longer lines are sent in pieces
KILL_AFTER = 5.0              # seconds a cell may ignore an interrupt before the kernel is killed
TABLE_ROWS = 500

_proto = os.fdopen(os.dup(1), 'w', encoding='utf-8', newline='\n')   # the protocol channel
_in = os.fdopen(os.dup(0), 'rb')
_out_lock = threading.Lock()
_mid = [0]


def emit(obj):
    s = json.dumps(obj, separators=(',', ':'))
    with _out_lock:
        if len(s) <= CHUNK:
            _proto.write(s + '\n')
        else:
            _mid[0] += 1
            parts = [s[i:i + CHUNK] for i in range(0, len(s), CHUNK)]
            for i, d in enumerate(parts):
                _proto.write(json.dumps({'t': 'chunk', 'mid': _mid[0], 'i': i, 'n': len(parts), 'd': d}) + '\n')
        _proto.flush()


# ---- notebook model and file ----
class Notebook:
    def __init__(self, directory):
        self.dir = directory
        self.path = os.path.join(directory, 'notebook.json')
        self.lock = threading.RLock()
        self.cells, self.kernel = [], None   # kernel: id of the kernel that produced the stored outputs
        self.load()

    def load(self):
        try:
            with open(self.path, encoding='utf-8') as f:
                d = json.load(f)
            cells = []
            for c in d.get('cells', []):
                if isinstance(c, dict) and isinstance(c.get('id'), str):
                    cells.append({'id': c['id'], 'type': 'markdown' if c.get('type') == 'markdown' else 'code',
                                  'source': str(c.get('source', '')), 'outputs': c.get('outputs') if isinstance(c.get('outputs'), list) else [],
                                  'count': c.get('count') if isinstance(c.get('count'), int) else None})
            self.cells, self.kernel = cells, d.get('kernel')
        except FileNotFoundError:
            pass
        except Exception as e:  # a damaged file must not stop the kernel: keep it aside and start empty
            try:
                os.replace(self.path, self.path + '.broken')
            except OSError:
                pass
            sys.stderr.write('notebook file unreadable (%s); moved to notebook.json.broken\n' % e)

    def save(self):
        with self.lock:
            os.makedirs(self.dir, exist_ok=True)
            tmp = self.path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump({'version': 1, 'kernel': self.kernel, 'cells': self.cells}, f, ensure_ascii=False)
            os.replace(tmp, self.path)

    def find(self, cid):
        for c in self.cells:
            if c['id'] == cid:
                return c
        return None

    def set_cells(self, incoming):
        with self.lock:
            old = {c['id']: c for c in self.cells}
            new = []
            for c in incoming:
                if not isinstance(c, dict) or not isinstance(c.get('id'), str):
                    continue
                prev = old.get(c['id'], {})
                new.append({'id': c['id'], 'type': 'markdown' if c.get('type') == 'markdown' else 'code', 'source': str(c.get('source', '')),
                            'outputs': prev.get('outputs', []), 'count': prev.get('count')})
            self.cells = new
            self.save()


# ---- output capture and rendering ----
class Collector:
    """Collects one cell's outputs, merging consecutive text of the same stream and stopping at CAP."""
    def __init__(self, cid):
        self.cid, self.items, self.size, self.live, self.truncated = cid, [], 0, 0, False

    def add(self, item, size):
        if self.size + size > CAP:
            self.truncated = True
            return False
        self.size += size
        self.items.append(item)
        return True

    def text(self, name, text):
        if not text:
            return
        room = CAP - self.size
        if len(text) > room:
            text, self.truncated = text[:max(room, 0)], True
        if self.items and self.items[-1].get('t') == 'stream' and self.items[-1]['name'] == name:
            self.items[-1]['text'] += text
        elif text:
            self.items.append({'t': 'stream', 'name': name, 'text': text})
        self.size += len(text)
        if self.live < LIVE_CAP and text:
            self.live += len(text)
            emit({'t': 'out', 'id': self.cid, 'name': name, 'text': text})

    def finish(self):
        if self.truncated:
            self.items.append({'t': 'note', 'text': 'output truncated: more than %s' % (('%d MB' % (CAP // (1024 * 1024))) if CAP >= 1024 * 1024 else ('%d bytes' % CAP))})
        return self.items


class Stream(io.TextIOBase):
    def __init__(self, name, get):
        self.name, self.get = name, get

    def writable(self):
        return True

    def write(self, s):
        col = self.get()
        if col is not None:
            col.text(self.name, str(s))
        return len(s)

    def flush(self):
        pass


_scalar = (str, int, float, bool, type(None))


def _cell(v):
    return v if isinstance(v, (int, float, bool)) or v is None else str(v)


def as_table(v):
    """A simple table for a list or dict of plain data, else None."""
    if isinstance(v, (list, tuple)) and v and all(isinstance(r, dict) for r in v) and all(isinstance(x, _scalar) for r in v for x in r.values()):
        cols = []
        for r in v:
            for k in r:
                if str(k) not in cols:
                    cols.append(str(k))
        return {'columns': cols, 'rows': [[_cell(r.get(c)) for c in cols] for r in v[:TABLE_ROWS]], 'total': len(v)}
    if isinstance(v, (list, tuple)) and v and all(isinstance(r, (list, tuple)) for r in v) and all(isinstance(x, _scalar) for r in v for x in r):
        n = max(len(r) for r in v)
        return {'columns': [str(i) for i in range(n)], 'rows': [[_cell(x) for x in r] + [None] * (n - len(r)) for r in v[:TABLE_ROWS]], 'total': len(v)}
    if isinstance(v, dict) and v and all(isinstance(x, _scalar) for x in v.values()):
        return {'columns': ['key', 'value'], 'rows': [[str(k), _cell(x)] for k, x in list(v.items())[:TABLE_ROWS]], 'total': len(v)}
    if isinstance(v, dict) and v and all(isinstance(x, (list, tuple)) and all(isinstance(y, _scalar) for y in x) for x in v.values()):
        n = max(len(x) for x in v.values())
        return {'columns': [str(k) for k in v], 'rows': [[_cell(x[i]) if i < len(x) else None for x in v.values()] for i in range(min(n, TABLE_ROWS))], 'total': n}
    if isinstance(v, (list, tuple)) and v and all(isinstance(x, _scalar) for x in v):
        return {'columns': ['value'], 'rows': [[_cell(x)] for x in v[:TABLE_ROWS]], 'total': len(v)}
    return None


def render_value(v):
    t = as_table(v)
    if t is not None:
        item = {'t': 'table', 'columns': t['columns'], 'rows': t['rows']}
        if t['total'] > TABLE_ROWS:
            item['note'] = 'first %d of %d rows' % (TABLE_ROWS, t['total'])
        return item
    try:
        r = repr(v)
    except Exception as e:
        r = '<repr failed: %s>' % e
    return {'t': 'result', 'text': r}


def figures():
    """PNG data of every open matplotlib figure (closed afterwards); nothing when matplotlib was never imported."""
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None:
        return []
    out = []
    try:
        for num in plt.get_fignums():
            buf = io.BytesIO()
            plt.figure(num).savefig(buf, format='png', dpi=100, bbox_inches='tight')
            out.append(base64.b64encode(buf.getvalue()).decode('ascii'))
        plt.close('all')
    except Exception as e:
        sys.stderr.write('could not capture figures: %s\n' % e)
    return out


# ---- kernel ----
class Kernel:
    def __init__(self, nb):
        self.nb = nb
        self.q = queue.Queue()
        self.cur = None           # id of the running cell
        self.cur_col = None
        self.interrupted = False
        self.in_exec = False      # the interrupt signal is only sent while user code runs
        self.new_namespace()

    def new_namespace(self):
        self.id = uuid.uuid4().hex[:12]
        self.ns = {'__name__': '__main__', '__builtins__': builtins}
        self.count = 0

    def state(self):
        return {'t': 'state', 'kernel': self.id, 'busy': self.cur, 'queued': [i[1] for i in list(self.q.queue) if i[0] == 'run']}

    def run_cell(self, cid, source):
        nb = self.nb
        col = Collector(cid)
        self.cur, self.cur_col, self.interrupted = cid, col, False
        self.count += 1
        n = self.count
        with nb.lock:
            c = nb.find(cid)
            if c is not None:
                c['source'], c['outputs'], c['count'] = source, [], None
            nb.kernel = self.id
        emit({'t': 'start', 'id': cid, 'n': n})
        emit(self.state())
        t0, status = time.time(), 'ok'
        real_out, real_err, real_in = sys.stdout, sys.stderr, sys.stdin
        sys.stdout, sys.stderr, sys.stdin = Stream('stdout', lambda: self.cur_col), Stream('stderr', lambda: self.cur_col), io.StringIO('')
        try:
            try:
                self.in_exec = True
                if self.interrupted:   # Stop arrived before the code started
                    raise KeyboardInterrupt()
                tree = ast.parse(source, '<cell>', 'exec')
                last = None
                if tree.body and isinstance(tree.body[-1], ast.Expr):
                    last = ast.Expression(tree.body.pop().value)
                    ast.fix_missing_locations(last)
                exec(compile(tree, '<cell>', 'exec'), self.ns)
                if last is not None:
                    v = eval(compile(last, '<cell>', 'eval'), self.ns)
                    if v is not None:
                        self.ns['_'] = v
                        item = render_value(v)
                        col.add(item, len(json.dumps(item, default=str)))
            except KeyboardInterrupt:
                status = 'interrupted'
                col.add({'t': 'error', 'text': 'KeyboardInterrupt: stopped'}, 30)
            except SystemExit as e:
                col.add({'t': 'note', 'text': 'exit(%s) ignored: the kernel keeps running' % (e.code,)}, 40)
            except BaseException as e:
                status = 'error'
                tb = e.__traceback__.tb_next if e.__traceback__ else None   # drop the runner's own frame
                col.add({'t': 'error', 'text': ''.join(traceback.format_exception(type(e), e, tb))}, 2000)
        finally:
            self.in_exec = False
            sys.stdout, sys.stderr, sys.stdin = real_out, real_err, real_in
        for data in figures():
            col.add({'t': 'image', 'mime': 'image/png', 'data': data}, len(data))
        outputs = col.finish()
        with nb.lock:
            c = nb.find(cid)
            if c is not None:
                c['outputs'], c['count'] = outputs, n
            nb.save()
        self.cur = self.cur_col = None
        emit({'t': 'done', 'id': cid, 'n': n, 'status': status, 'ms': int((time.time() - t0) * 1000), 'outputs': outputs})
        emit(self.state())

    def loop(self):
        while True:
            try:
                item = self.q.get()
                if item[0] == 'run':
                    self.run_cell(item[1], item[2])
                elif item[0] == 'restart':
                    self.new_namespace()
                    with self.nb.lock:
                        self.nb.kernel = self.id
                        self.nb.save()
                    emit({'t': 'restarted', 'kernel': self.id})
                    emit(self.state())
            except KeyboardInterrupt:
                continue   # the interrupt arrived between cells

    def stop(self):
        with self.q.mutex:
            self.q.queue.clear()
        cid = self.cur
        if cid is None:
            emit(self.state())
            return
        self.interrupted = True
        if self.in_exec:
            signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)   # to the thread that runs the cell, so a blocking sleep or read is interrupted too
        def watchdog():
            time.sleep(KILL_AFTER)
            if self.cur == cid:   # still inside the same cell: it ignores interrupts (a C extension, a blocking call)
                with self.nb.lock:
                    c = self.nb.find(cid)
                    if c is not None:
                        c['outputs'] = (self.cur_col.items if self.cur_col else []) + [{'t': 'error', 'text': 'the cell did not react to Stop; the kernel was killed'}]
                        c['count'] = None
                    self.nb.save()
                emit({'t': 'killed', 'id': cid})
                os._exit(0)
        threading.Thread(target=watchdog, daemon=True).start()


def mpl_available():
    import importlib.util
    try:
        return importlib.util.find_spec('matplotlib') is not None
    except Exception:
        return False


def main():
    directory = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.environ.setdefault('MPLBACKEND', 'Agg')
    signal.signal(signal.SIGINT, signal.default_int_handler)
    # the protocol owns fds 0 and 1; code in cells (and the programs it starts) must not touch them
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    sys.path.insert(0, os.getcwd())
    nb = Notebook(directory)
    k = Kernel(nb)
    emit({'t': 'ready', 'kernel': k.id})

    def reader():
        for raw in _in:
            try:
                m = json.loads(raw.decode('utf-8'))
            except Exception:
                continue
            t = m.get('t') if isinstance(m, dict) else None
            if t == 'hello':
                with nb.lock:
                    lost = bool(nb.kernel and nb.kernel != k.id and any(c['count'] is not None or c['outputs'] for c in nb.cells))
                    cells = json.loads(json.dumps(nb.cells))
                emit({'t': 'hello', 'kernel': k.id, 'lost': lost, 'busy': k.cur, 'python': sys.version.split()[0], 'mpl': mpl_available()})
                emit({'t': 'notebook', 'cells': cells})
                emit(k.state())
            elif t == 'cells' and isinstance(m.get('cells'), list):
                nb.set_cells(m['cells'])
            elif t == 'run' and isinstance(m.get('id'), str):
                k.q.put(('run', m['id'], str(m.get('source', ''))))
                emit(k.state())
            elif t == 'stop':
                k.stop()
            elif t == 'restart':
                k.stop()
                k.q.put(('restart',))
        os._exit(0)   # stdin closed: the server is gone

    threading.Thread(target=reader, daemon=True).start()
    k.loop()


if __name__ == '__main__':
    main()
