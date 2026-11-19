#!/usr/bin/env python3
"""Backend of the Wallpaper shuffle widget (python3 standard library only).

Usage: wallpaper.py STATE_DIR COMMAND [ARG]      (the widget's exec sources call this; DATA = <script dir>/data)
  list          print the widget state as JSON (images, job, settings); also starts a due auto-change
  fetch         start a download in the background and return at once (the job reports progress in job.json)
  pick NAME     set an image as the Hatch background
  fav NAME      toggle the favorite star of an image
  del NAME      delete an image (favorites too; the widget asks twice)
  auto MINUTES  auto-change interval, 0 = off (persisted in settings.json)
  dark on|off   skip images that are too dark (needs an image tool, see luminance())

Sources, tried in this order, each up to TRIES times with a short backoff:
  picsum.photos  random photo, author via its info endpoint
  bing.com       the last few Bing home page photos (HPImageArchive), title and credit from its JSON
  loremflickr    random landscape photo from Flickr (no metadata)
A download goes to a temporary file, is checked (JPEG signature, complete, landscape, sane size) and only then renamed
into place, so a failed run never leaves a partial image. Test hooks (environment): WALLPAPER_PICSUM, WALLPAPER_BING,
WALLPAPER_FLICKR (base URLs), WALLPAPER_SOURCES (comma list, order), WALLPAPER_BACKOFF (seconds multiplier),
WALLPAPER_TIMEOUT (seconds), WALLPAPER_MIN_BYTES.
"""
import contextlib
import fcntl
import json
import os
import random
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

MAX_KEEP = 30                      # newest non-favorite images kept
INTERVALS = (0, 15, 30, 60, 180, 360, 720, 1440)
TRIES = 2
W, H = 1920, 1080
DARK_BELOW = 45                    # mean luminance (0-255) under which an image is "too dark" for terminal text
MAX_BYTES = 30 * 1024 * 1024
MIN_BYTES = int(os.environ.get('WALLPAPER_MIN_BYTES', 20 * 1024))
TIMEOUT = float(os.environ.get('WALLPAPER_TIMEOUT', 20))
BACKOFF = float(os.environ.get('WALLPAPER_BACKOFF', 1))
NAME_RE = re.compile(r'^[a-z]+-[A-Za-z0-9_-]{1,60}-\d{9,11}\.jpg$')

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
STATE = ''


class Fail(Exception):
    """A readable reason for one failed attempt."""


# ---- small helpers ----
def now():
    return int(time.time())


def out(obj):
    sys.stdout.write(json.dumps(obj, separators=(',', ':')))


def write_json(path, obj):
    fd, tmp = tempfile.mkstemp(prefix='.tmp-', dir=DATA)
    with os.fdopen(fd, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path) as f:
            v = json.load(f)
        return v if isinstance(v, type(default)) else default
    except (OSError, ValueError):
        return default


@contextlib.contextmanager
def locked():
    """Serialises read-modify-write of settings.json and job.json between the page's calls and the download job."""
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, '.lock'), 'w') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def settings():
    s = read_json(os.path.join(DATA, 'settings.json'), {})
    s.setdefault('auto', 0); s.setdefault('next', 0); s.setdefault('favorites', []); s.setdefault('skipDark', True)
    s.setdefault('current', '')
    return s


def save_settings(s):
    write_json(os.path.join(DATA, 'settings.json'), s)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def job():
    j = read_json(os.path.join(DATA, 'job.json'), {})
    # a running job whose process died (killed, reboot) must not stay "running" forever
    if j.get('state') == 'running' and not (alive(j.get('pid', 0)) and now() - j.get('started', 0) < 300):
        j = {'state': 'error', 'msg': 'the download was interrupted (the process ended unexpectedly); try again', 'at': now()}
    return j


def set_job(**kw):
    write_json(os.path.join(DATA, 'job.json'), kw)


def images():
    """Newest first: [{n, ts, fav, m}]; m is the sidecar (source, author, ...) or None for images without one."""
    favs = set(settings()['favorites'])
    items = []
    try:
        names = os.listdir(DATA)
    except OSError:
        return []
    for n in names:
        if not NAME_RE.match(n):
            continue
        try:
            st = os.stat(os.path.join(DATA, n))
        except OSError:
            continue
        m = read_json(os.path.join(DATA, n[:-4] + '.json'), {}) or None
        items.append({'n': n, 'ts': int(st.st_mtime), 'fav': n in favs, 'm': m})
    items.sort(key=lambda i: (-i['ts'], i['n']))
    return items


def remove_image(name):
    for f in (name, name[:-4] + '.json'):
        with contextlib.suppress(OSError):
            os.remove(os.path.join(DATA, f))


def rotate():
    """Keep favorites and the newest MAX_KEEP others; drop the rest."""
    with locked():
        keep = [i for i in images() if not i['fav']]
        for i in keep[MAX_KEEP:]:
            remove_image(i['n'])
        s = settings(); names = {i['n'] for i in images()}
        s['favorites'] = [f for f in s['favorites'] if f in names]
        save_settings(s)


def clean_tmp():
    for n in os.listdir(DATA) if os.path.isdir(DATA) else []:
        p = os.path.join(DATA, n)
        if n.startswith('.tmp-') and now() - os.path.getmtime(p) > 600:
            with contextlib.suppress(OSError):
                os.remove(p)


# ---- state ----
def luminance_tool():
    return next((t for t in ('magick', 'convert', 'gm', 'djpeg') if shutil.which(t)), None)


def state():
    s = settings(); imgs = images()
    for i in imgs:
        i.pop('ts')
    return {'images': imgs, 'current': s['current'], 'job': job(), 'auto': s['auto'], 'next': s['next'], 'now': now(),
            'skipDark': s['skipDark'], 'darkTool': luminance_tool() is not None, 'keep': MAX_KEEP, 'intervals': list(INTERVALS)}


def start_job(reason):
    """Spawns the detached download job unless one runs; returns True if started."""
    with locked():
        j = job()
        if j.get('state') == 'running':
            return False
        child = subprocess.Popen([sys.executable, os.path.abspath(__file__), STATE, '_job', reason], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        set_job(state='running', pid=child.pid, started=now(), step='starting', reason=reason)
    return True


def cmd_list():
    os.makedirs(DATA, exist_ok=True)
    clean_tmp()
    s = settings()
    if s['auto'] and s['next'] and now() >= s['next']:
        with locked():
            s = settings(); s['next'] = now() + s['auto'] * 60; save_settings(s)  # claim this slot first: one starter only
        start_job('auto')
    out(state())


# ---- background ----
def set_background(name):
    path = os.path.join(DATA, name)
    exe = shutil.which('hatch')
    if not exe:
        raise Fail('the hatch command is not on the server PATH; install it (install.sh) or set the background by hand')
    r = subprocess.run([exe, 'set', 'background', path, '--state', STATE], capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        raise Fail('hatch set background failed: ' + (r.stderr.strip() or r.stdout.strip() or 'exit %d' % r.returncode)[:200])
    with locked():
        s = settings(); s['current'] = name; save_settings(s)


def arg_name(arg):
    if not arg or not NAME_RE.match(arg) or not os.path.isfile(os.path.join(DATA, arg)):
        raise Fail('no such image: %s' % (arg or '(none)'))
    return arg


# ---- download ----
def describe_error(e):
    if isinstance(e, urllib.error.HTTPError):
        return 'HTTP %d %s' % (e.code, e.reason)
    r = getattr(e, 'reason', e)
    if isinstance(r, socket.gaierror):
        return 'cannot resolve the host name (no internet or DNS problem)'
    if isinstance(r, (socket.timeout, TimeoutError)) or isinstance(e, (socket.timeout, TimeoutError)):
        return 'timed out after %ds' % TIMEOUT
    if isinstance(r, ConnectionRefusedError):
        return 'connection refused'
    if isinstance(r, ssl.SSLError):
        return 'TLS error: %s' % r
    if isinstance(e, (ConnectionError, OSError)):
        return 'network error: %s' % (str(r) or type(r).__name__)
    return str(e) or type(e).__name__


def http_get(url, limit):
    """Returns (bytes, final url, headers); raises Fail with a readable reason."""
    req = urllib.request.Request(url, headers={'User-Agent': 'hatch-wallpaper-shuffle/1'})
    deadline = time.time() + TIMEOUT * 2
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            chunks, size = [], 0
            while True:
                c = r.read(65536)
                if not c:
                    break
                size += len(c)
                if size > limit:
                    raise Fail('the response is larger than %d MB' % (limit // 1048576))
                if time.time() > deadline:
                    raise Fail('too slow (more than %ds in total)' % (TIMEOUT * 2))
                chunks.append(c)
            body = b''.join(chunks)
            want = r.headers.get('Content-Length')
            if want and want.isdigit() and int(want) != len(body) and not r.headers.get('Content-Encoding'):
                raise Fail('the download was cut off (%d of %s bytes)' % (len(body), want))
            return body, r.geturl(), r.headers
    except Fail:
        raise
    except Exception as e:  # noqa: BLE001 - every network failure becomes a sentence
        raise Fail(describe_error(e)) from e


def jpeg_size(b):
    """(width, height) from the first SOF marker; raises Fail if b is not a complete JPEG."""
    if b[:3] != b'\xff\xd8\xff':
        head = b[:24].decode('latin-1').strip()
        raise Fail('not a JPEG (starts with %r)' % (head if head.isprintable() else b[:4].hex()))
    if b'\xff\xd9' not in b[-64:]:
        raise Fail('the JPEG is incomplete (no end marker)')
    i = 2
    while i + 4 <= len(b):
        if b[i] != 0xFF:
            i += 1
            continue
        m = b[i + 1]
        if m == 0xFF:
            i += 1
            continue
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        (ln,) = struct.unpack('>H', b[i + 2:i + 4])
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack('>HH', b[i + 5:i + 9])
            return w, h
        if m == 0xDA:
            break
        i += 2 + ln
    raise Fail('the JPEG has no readable size')


def validate(b):
    if b[:3] != b'\xff\xd8\xff':
        jpeg_size(b)  # raises the "not a JPEG (starts with ...)" reason first: it explains an error page better than its size
    if len(b) < MIN_BYTES:
        raise Fail('the file is only %d bytes (an error page or a broken image?)' % len(b))
    w, h = jpeg_size(b)
    if w < 1000 or h < 560 or w <= h:
        raise Fail('the image is %dx%d, expected a landscape image of at least 1000x560' % (w, h))
    return w, h


def luminance(path):
    """Mean brightness 0-255 of an image, or None when no tool to measure it exists (magick, convert, gm or djpeg)."""
    t = luminance_tool()
    try:
        if t in ('magick', 'convert', 'gm'):
            cmd = ([t, 'convert'] if t == 'gm' else [t]) + [path, '-resize', '1x1!', '-colorspace', 'Gray', '-format', '%[fx:mean*255]', 'info:']
            return float(subprocess.run(cmd, capture_output=True, text=True, timeout=20, check=True).stdout.strip())
        if t == 'djpeg':  # 1/8 scale grayscale PGM, mean of the pixel bytes
            r = subprocess.run(['djpeg', '-grayscale', '-scale', '1/8', '-pnm', path], capture_output=True, timeout=20, check=True).stdout
            px = re.sub(rb'^P5\s+\d+\s+\d+\s+\d+\s', b'', r, count=1)
            return sum(px) / len(px) if px else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return None


def fetch_picsum():
    base = os.environ.get('WALLPAPER_PICSUM', 'https://picsum.photos')
    body, _, hdr = http_get('%s/%d/%d' % (base, W, H), MAX_BYTES)
    pid = re.sub(r'[^A-Za-z0-9_-]', '', hdr.get('Picsum-Id') or '') or 'x'
    meta = {'id': pid, 'page': 'https://picsum.photos/id/%s/info' % pid}
    try:  # author is nice to have, never a reason to fail
        info = json.loads(http_get('%s/id/%s/info' % (base, pid), 100000)[0])
        meta.update(author=info.get('author'), url=info.get('url'))
    except (Fail, ValueError, AttributeError):
        pass
    return body, meta


def fetch_bing():
    base = os.environ.get('WALLPAPER_BING', 'https://www.bing.com')
    raw, _, _ = http_get('%s/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=en-US' % base, 200000)
    try:
        items = json.loads(raw)['images']
    except (ValueError, KeyError, TypeError):
        raise Fail('the image list is not valid JSON (the service changed?)')
    if not items:
        raise Fail('the image list is empty')
    have = {i['m'].get('id') for i in images() if i['m'] and i['m'].get('source') == 'bing'}
    fresh = [x for x in items if re.sub(r'[^A-Za-z0-9_-]', '', str(x.get('urlbase', '')).rsplit('OHR.', 1)[-1])[:60] not in have] or items
    pick = random.choice(fresh)
    pid = re.sub(r'[^A-Za-z0-9_-]', '', str(pick.get('urlbase', '')).rsplit('OHR.', 1)[-1])[:60]
    if not pid:
        raise Fail('the image list has no usable entry')
    body, _, _ = http_get('%s%s_%dx%d.jpg' % (base, pick['urlbase'], W, H), MAX_BYTES)
    credit = str(pick.get('copyright') or '')
    return body, {'id': pid, 'author': re.sub(r'^.*\(©\s*|\)\s*$', '', credit) if '©' in credit else None,
                  'title': pick.get('title') or credit or None, 'url': pick.get('copyrightlink')}


def fetch_flickr():
    base = os.environ.get('WALLPAPER_FLICKR', 'https://loremflickr.com')
    body, final, _ = http_get('%s/%d/%d/landscape?lock=%d' % (base, W, H, random.randint(1, 99999)), MAX_BYTES)
    pid = re.sub(r'[^A-Za-z0-9_-]', '', os.path.basename(final.split('?')[0]).rsplit('.', 1)[0])[:60] or 'x'
    return body, {'id': pid}


SOURCES = {'picsum': ('picsum.photos', fetch_picsum), 'bing': ('bing.com', fetch_bing), 'flickr': ('loremflickr.com', fetch_flickr)}


def order():
    names = [n.strip() for n in os.environ.get('WALLPAPER_SOURCES', 'picsum,bing,flickr').split(',')]
    return [n for n in names if n in SOURCES]


def store(source, body, meta, w, h, lum):
    """Writes image + sidecar atomically under their final names; returns the file name."""
    pid = re.sub(r'[^A-Za-z0-9_-]', '', str(meta.get('id', 'x'))) or 'x'
    t = now()
    while os.path.exists(os.path.join(DATA, '%s-%s-%d.jpg' % (source, pid, t))):
        t += 1  # same image twice in one second
    name = '%s-%s-%d.jpg' % (source, pid, t)
    side = {'source': source, 'host': SOURCES[source][0], 'downloaded': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'width': w, 'height': h, 'bytes': len(body), 'luminance': None if lum is None else round(lum, 1)}
    side.update({k: v for k, v in meta.items() if v})
    write_json(os.path.join(DATA, name[:-4] + '.json'), side)
    return name


def run_job(reason):
    """The detached download: sources in order, retries, validation, dark check, rotation, set background."""
    me = os.getpid()
    errors = []          # one human line per failed attempt group: "picsum.photos: HTTP 503"
    skip_dark = settings()['skipDark'] and luminance_tool() is not None
    note = ''
    for key in order():
        host, fn = SOURCES[key]
        last, darks = None, 0
        attempt = 0
        while attempt < TRIES:
            attempt += 1
            set_job(state='running', pid=me, started=job().get('started', now()), reason=reason, step='%s (try %d of %d)' % (host, attempt, TRIES))
            tmp = os.path.join(DATA, '.tmp-%d-%s' % (me, key))
            try:
                body, meta = fn()
                w, h = validate(body)
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
                with os.fdopen(fd, 'wb') as f:
                    f.write(body)
                lum = luminance(tmp) if skip_dark else None
                if lum is not None and lum < DARK_BELOW:
                    darks += 1
                    last = 'got a too dark image (brightness %d of 255)' % lum
                    if darks < 3:        # another random pick is free: does not use up a try
                        attempt -= 1
                        continue
                    raise Fail(last)
                name = store(key, body, meta, w, h, lum)
                os.replace(tmp, os.path.join(DATA, name))
            except Fail as e:
                last = str(e)
                time.sleep(BACKOFF * (2 ** (attempt - 1)) if attempt < TRIES else 0)
                continue
            except Exception as e:  # noqa: BLE001
                last = 'unexpected error: %s' % e
                break
            finally:
                with contextlib.suppress(OSError):
                    os.remove(tmp)
            # saved: rotate, then use it
            rotate()
            try:
                set_background(name)
            except Fail as e:
                set_job(state='error', msg='saved %s but %s' % (name, e), at=now(), file=name)
                return finish_next(False)
            if errors:
                note = ' (after %s)' % '; '.join(errors)
            set_job(state='done', msg='new background from %s%s' % (host, note), at=now(), file=name)
            return finish_next(True)
        errors.append('%s: %s' % (host, last or 'failed'))
    set_job(state='error', msg='no source worked: ' + '; '.join(errors), at=now(), errors=errors)
    return finish_next(False)


def finish_next(ok):
    """After a failed run retry sooner than a whole interval."""
    with locked():
        s = settings()
        if s['auto'] and not ok:
            s['next'] = min(s['next'] or 1 << 60, now() + 600) if s['next'] else now() + 600
            save_settings(s)


def main(argv):
    global STATE
    if len(argv) < 3:
        sys.stderr.write('usage: wallpaper.py STATE_DIR list|fetch|pick|fav|del|auto|dark [ARG]\n')
        return 2
    STATE, cmd = argv[1], argv[2]
    arg = argv[3] if len(argv) > 3 else ''
    os.makedirs(DATA, exist_ok=True)
    try:
        if cmd == '_job':
            run_job(arg or 'manual')
            return 0
        if cmd == 'list':
            cmd_list(); return 0
        if cmd == 'fetch':
            start_job('manual')
        elif cmd == 'pick':
            set_background(arg_name(arg))
        elif cmd == 'fav':
            n = arg_name(arg)
            with locked():
                s = settings(); s['favorites'] = [f for f in s['favorites'] if f != n] + ([] if n in s['favorites'] else [n]); save_settings(s)
        elif cmd == 'del':
            n = arg_name(arg)
            with locked():
                remove_image(n)
                s = settings(); s['favorites'] = [f for f in s['favorites'] if f != n]
                if s['current'] == n:
                    s['current'] = ''
                save_settings(s)
        elif cmd == 'auto':
            if not arg.isdigit() or int(arg) not in INTERVALS:
                raise Fail('interval must be one of %s minutes' % ', '.join(map(str, INTERVALS)))
            with locked():
                s = settings(); s['auto'] = int(arg); s['next'] = now() + int(arg) * 60 if int(arg) else 0; save_settings(s)
        elif cmd == 'dark':
            if arg not in ('on', 'off'):
                raise Fail('dark takes on or off')
            with locked():
                s = settings(); s['skipDark'] = arg == 'on'; save_settings(s)
        else:
            raise Fail('unknown command %s' % cmd)
    except Fail as e:
        sys.stderr.write(str(e) + '\n')
        return 1
    cmd_list_quiet()
    return 0


def cmd_list_quiet():
    out(state())


if __name__ == '__main__':
    sys.exit(main(sys.argv))
