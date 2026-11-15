#!/usr/bin/env python3
"""DJBOX – lokaler Server für die Player-Box.

Liest die Sammlung aus MUSIC_ROOT, liefert Cover, Audio (AIFF -> FLAC),
Wellenform/BPM-Analysen, Einstellungen und USB-MIDI-Events (per SSE).
Nur Python-Standardbibliothek + ffmpeg/ffprobe.
"""
import array
import hashlib
import json
import math
import os
import queue
import re
import select
import shutil
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MUSIC_ROOT = os.environ.get("DJBOX_MUSIC", "/mnt/musik")
HOST = os.environ.get("DJBOX_HOST", "127.0.0.1")
PORT = int(os.environ.get("DJBOX_PORT", "8765"))
# Optional: Bibliothek von einem Navidrome/Subsonic-Server statt aus dem Dateisystem
ND_URL = os.environ.get("DJBOX_NAVIDROME_URL", "").rstrip("/")
ND_USER = os.environ.get("DJBOX_NAVIDROME_USER", "")
ND_PASS = os.environ.get("DJBOX_NAVIDROME_PASS", "")
REMOTE = bool(ND_URL)
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(APP_DIR, "static")
CACHE = os.path.expanduser("~/.cache/djbox")
CONF_DIR = os.path.expanduser("~/.config/djbox")
COVER_DIR = os.path.join(CACHE, "covers")
AUDIO_DIR = os.path.join(CACHE, "audio")
ANALYSIS_DIR = os.path.join(CACHE, "analysis")
REMOTE_DIR = os.path.join(CACHE, "remote")  # Originaldateien vom Navidrome
LIB_FILE = os.path.join(CACHE, "library.json")
SETTINGS_FILE = os.path.join(CONF_DIR, "settings.json")
AUDIO_CACHE_LIMIT = 15 * 1024**3  # 15 GB für umgewandelte AIFF-Dateien

AUDIO_EXT = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".aif", ".aiff", ".aifc"}
NATIVE_EXT = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus"}
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}
MIME = {".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav", ".m4a": "audio/mp4",
        ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg",
        ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json", ".jpg": "image/jpeg",
        ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2"}

for d in (COVER_DIR, AUDIO_DIR, ANALYSIS_DIR, REMOTE_DIR, CONF_DIR):
    os.makedirs(d, exist_ok=True)


def hid(s):
    return hashlib.sha1(s.encode("utf-8", "surrogateescape")).hexdigest()[:16]


def nice_cmd(cmd):
    return ["nice", "-n", "12"] + cmd


# ───────────────────────── Navidrome (Subsonic-API) ─────────────────────────
def nd_url(endpoint, **params):
    salt = os.urandom(6).hex()
    q = {"u": ND_USER, "t": hashlib.md5((ND_PASS + salt).encode()).hexdigest(), "s": salt,
         "v": "1.16.1", "c": "djbox", "f": "json", **params}
    return f"{ND_URL}/rest/{endpoint}.view?" + urllib.parse.urlencode(q)


def nd_json(endpoint, **params):
    with urllib.request.urlopen(nd_url(endpoint, **params), timeout=60) as r:
        resp = json.load(r)["subsonic-response"]
    if resp.get("status") != "ok":
        raise RuntimeError(resp.get("error", {}).get("message", "Subsonic-Fehler"))
    return resp


def nd_download(endpoint, dest, **params):
    """Lädt eine Ressource atomar nach dest (falls noch nicht vorhanden)."""
    if os.path.exists(dest):
        return dest
    tmp = dest + ".tmp"
    with urllib.request.urlopen(nd_url(endpoint, **params), timeout=120) as r, open(tmp, "wb") as f:
        if "json" in r.headers.get("Content-Type", ""):  # Fehlerantwort statt Datei
            raise RuntimeError("Navidrome lieferte keine Datei")
        shutil.copyfileobj(r, f)
    os.replace(tmp, dest)
    return dest


def track_src(t):
    """Lokaler Dateipfad eines Tracks (Remote: Original wird in den Cache geladen)."""
    if not REMOTE:
        return os.path.join(MUSIC_ROOT, t["rel"])
    dest = os.path.join(REMOTE_DIR, t["id"] + "." + (t["ext"] or "bin"))
    try:
        return nd_download("stream", dest, id=t["sid"], format="raw")
    except Exception as e:
        print("download error:", e, flush=True)
        return None


# ───────────────────────── Library ─────────────────────────
class Library:
    def __init__(self):
        self.lock = threading.Lock()
        self.tracks = {}   # id -> track
        self.albums = {}   # id -> album
        self.status = {"scanning": False, "done": 0, "total": 0, "updated": 0}
        self._probe_cache = {}
        try:
            with open(LIB_FILE) as f:
                data = json.load(f)
            if REMOTE:
                r = data.get("remote", {})
                self.tracks, self.albums = r.get("tracks", {}), r.get("albums", {})
            else:
                self._probe_cache = data.get("probe", {})
                self._build(self._probe_cache_entries())
        except Exception:
            pass

    def _probe_cache_entries(self):
        return [(rel, v["meta"]) for rel, v in self._probe_cache.items()]

    @staticmethod
    def probe(path):
        try:
            out = subprocess.run(
                nice_cmd(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration:format_tags:stream=codec_type,sample_rate",
                          "-of", "json", path]),
                capture_output=True, timeout=60).stdout
            j = json.loads(out or b"{}")
        except Exception:
            j = {}
        fmt = j.get("format", {})
        tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
        for s in j.get("streams", []):
            if s.get("codec_type") == "audio":
                for k, v in (s.get("tags") or {}).items():
                    tags.setdefault(k.lower(), v)
        bpm = None
        for k in ("tbpm", "bpm", "tempo"):
            if k in tags:
                try:
                    bpm = round(float(str(tags[k]).replace(",", ".")), 1) or None
                except ValueError:
                    pass
                break
        has_art = any(s.get("codec_type") == "video" for s in j.get("streams", []))
        tn = re.match(r"\d+", str(tags.get("track", "")))
        return {
            "title": tags.get("title"), "artist": tags.get("artist"),
            "album": tags.get("album"), "albumartist": tags.get("album_artist") or tags.get("albumartist"),
            "genre": tags.get("genre"), "year": (tags.get("date") or tags.get("year") or "")[:4] or None,
            "track": int(tn.group()) if tn else None, "bpm": bpm, "key": tags.get("initialkey") or tags.get("tkey"),
            "duration": float(fmt.get("duration") or 0), "art": has_art,
        }

    def scan(self):
        if self.status["scanning"]:
            return
        self.status.update(scanning=True, done=0, total=0)
        try:
            files = []
            for dirpath, dirnames, filenames in os.walk(MUSIC_ROOT):
                dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
                for fn in filenames:
                    if fn.startswith("._") or fn.startswith("."):
                        continue
                    if os.path.splitext(fn)[1].lower() in AUDIO_EXT:
                        full = os.path.join(dirpath, fn)
                        try:
                            st = os.stat(full)
                        except OSError:
                            continue
                        files.append((os.path.relpath(full, MUSIC_ROOT), st.st_size, int(st.st_mtime)))
            self.status["total"] = len(files)
            todo = []
            new_cache = {}
            for rel, size, mt in files:
                c = self._probe_cache.get(rel)
                if c and c["size"] == size and c["mtime"] == mt:
                    new_cache[rel] = c
                    self.status["done"] += 1
                else:
                    todo.append((rel, size, mt))

            def work(item):
                rel, size, mt = item
                meta = self.probe(os.path.join(MUSIC_ROOT, rel))
                self.status["done"] += 1
                return rel, {"size": size, "mtime": mt, "meta": meta}

            with ThreadPoolExecutor(3) as ex:
                for i, (rel, v) in enumerate(ex.map(work, todo)):
                    new_cache[rel] = v
                    if i % 100 == 99:  # Zwischenstand sichtbar machen
                        self._probe_cache = {**self._probe_cache, **new_cache}
                        self._build(self._probe_cache_entries())
            self._probe_cache = new_cache
            self._build(self._probe_cache_entries())
            tmp = LIB_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"probe": new_cache}, f)
            os.replace(tmp, LIB_FILE)
        finally:
            self.status["scanning"] = False
            self.status["updated"] = int(time.time())
            threading.Thread(target=prefetch_covers, daemon=True).start()

    def scan_remote(self):
        if self.status["scanning"]:
            return
        self.status.update(scanning=True, done=0, total=0)
        try:
            albums_raw, offset = [], 0
            while True:
                lst = nd_json("getAlbumList2", type="alphabeticalByName", size=500, offset=offset)
                chunk = lst.get("albumList2", {}).get("album", [])
                albums_raw += chunk
                if len(chunk) < 500:
                    break
                offset += 500
            self.status["total"] = len(albums_raw)
            tracks, albums = {}, {}

            def fetch(a):
                return nd_json("getAlbum", id=a["id"]).get("album", {})

            with ThreadPoolExecutor(4) as ex:
                for i, al in enumerate(ex.map(fetch, albums_raw)):
                    self.status["done"] += 1
                    songs = al.get("song", [])
                    if not songs:
                        continue
                    aid = hid("nd:" + al["id"])
                    paths = [x.get("path", "") for x in songs]
                    folder = os.path.dirname(paths[0])
                    parts = paths[0].split("/")
                    crate = parts[0] if len(parts) > 2 else "—"
                    a = albums[aid] = {
                        "id": aid, "nid": al["id"], "folder": folder, "crate": crate,
                        "title": al.get("name") or "", "artist": al.get("artist") or "",
                        "year": str(al["year"]) if al.get("year") else None,
                        "genres": sorted({g.get("name") for g in al.get("genres", []) if g.get("name")}
                                         or ({al["genre"]} if al.get("genre") else set())),
                        "tracks": [], "added": 0,
                    }
                    try:
                        a["added"] = int(time.mktime(time.strptime(al["created"][:19], "%Y-%m-%dT%H:%M:%S")))
                    except Exception:
                        pass
                    for x in sorted(songs, key=lambda x: (x.get("discNumber") or 1, x.get("track") or 999)):
                        rel = x.get("path") or x["id"]
                        t = {
                            "id": hid("nd:" + x["id"]), "sid": x["id"], "rel": rel, "album": aid, "crate": crate,
                            "title": x.get("title") or "", "artist": x.get("artist") or "",
                            "genre": x.get("genre") or "", "bpm": x.get("bpm") or None, "key": None,
                            "track": x.get("track"), "duration": x.get("duration") or 0,
                            "ext": (x.get("suffix") or os.path.splitext(rel)[1].lstrip(".")).lower(),
                            "art": bool(x.get("coverArt")), "file": os.path.basename(rel),
                        }
                        tracks[t["id"]] = t
                        a["tracks"].append(t["id"])
                    if i % 100 == 99:
                        with self.lock:
                            self.tracks, self.albums = dict(tracks), dict(albums)
            with self.lock:
                self.tracks, self.albums = tracks, albums
            tmp = LIB_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"remote": {"tracks": tracks, "albums": albums}}, f)
            os.replace(tmp, LIB_FILE)
        finally:
            self.status["scanning"] = False
            self.status["updated"] = int(time.time())
            threading.Thread(target=prefetch_covers, daemon=True).start()

    @staticmethod
    def split_name(name):
        m = re.split(r"\s+[-–—]\s+", name, maxsplit=1)
        if len(m) == 2:
            return m[0].strip(), m[1].strip()
        return None, name

    def _build(self, entries):
        tracks, albums = {}, {}
        for rel, meta in entries:
            folder = os.path.dirname(rel)
            parts = rel.split(os.sep)
            crate = parts[0] if len(parts) > 1 else "—"
            aid = hid(folder or ".")
            fname = os.path.splitext(parts[-1])[0]
            f_artist, f_title = self.split_name(re.sub(r"^\d+[\s._-]+", "", fname))
            t = {
                "id": hid(rel), "rel": rel, "album": aid, "crate": crate,
                "title": meta.get("title") or f_title or fname,
                "artist": meta.get("artist") or f_artist or "",
                "genre": meta.get("genre") or "", "bpm": meta.get("bpm"), "key": meta.get("key"),
                "track": meta.get("track"), "duration": meta.get("duration") or 0,
                "ext": os.path.splitext(rel)[1].lower().lstrip("."), "art": meta.get("art"),
                "file": parts[-1],
            }
            tracks[t["id"]] = t
            a = albums.get(aid)
            if not a:
                base = os.path.basename(folder) if folder else crate
                d_artist, d_title = self.split_name(base)
                a = albums[aid] = {
                    "id": aid, "folder": folder, "crate": crate,
                    "title": meta.get("album") or d_title or base,
                    "artist": meta.get("albumartist") or d_artist or meta.get("artist") or "",
                    "year": meta.get("year"), "genres": set(), "tracks": [], "added": 0,
                }
            if meta.get("genre"):
                a["genres"].add(meta["genre"])
            a["tracks"].append(t["id"])
            a["added"] = max(a["added"], self._probe_cache.get(rel, {}).get("mtime", 0))
        for a in albums.values():
            a["genres"] = sorted(a["genres"])
            a["tracks"].sort(key=lambda i: (tracks[i]["track"] or 999, tracks[i]["file"].lower()))
            artists = {tracks[i]["artist"] for i in a["tracks"]}
            if not a["artist"]:
                a["artist"] = artists.pop() if len(artists) == 1 else "Various"
        with self.lock:
            self.tracks, self.albums = tracks, albums

    def payload(self):
        with self.lock:
            return {"tracks": self.tracks, "albums": self.albums, "status": self.status}


LIB = Library()


# ───────────────────────── Cover ─────────────────────────
_cover_sem = threading.Semaphore(2)


def cover_path(aid):
    return os.path.join(COVER_DIR, aid + ".jpg")


def make_cover(aid):
    out = cover_path(aid)
    none = out + ".none"
    if os.path.exists(out):
        return out
    if os.path.exists(none):
        return None
    a = LIB.albums.get(aid)
    if not a:
        return None
    if REMOTE:
        try:
            with _cover_sem:
                return nd_download("getCoverArt", out, id=a["nid"], size=400)
        except Exception:
            return None
    src = None
    folder = os.path.join(MUSIC_ROOT, a["folder"])
    try:
        imgs = [f for f in os.listdir(folder)
                if not f.startswith(".") and os.path.splitext(f)[1].lower() in IMG_EXT]
    except OSError:
        imgs = []
    if imgs:
        pref = sorted(imgs, key=lambda f: (0 if re.search(r"cover|folder|front", f, re.I) else 1, f.lower()))
        src = os.path.join(folder, pref[0])
    else:
        for tid in a["tracks"]:
            if LIB.tracks.get(tid, {}).get("art"):
                src = os.path.join(MUSIC_ROOT, LIB.tracks[tid]["rel"])
                break
    if not src:
        open(none, "w").close()
        return None
    with _cover_sem:
        tmp = out + ".tmp.jpg"
        r = subprocess.run(nice_cmd(["ffmpeg", "-v", "error", "-y", "-i", src, "-an", "-frames:v", "1",
                                     "-vf", "scale=400:400:force_original_aspect_ratio=increase,crop=400:400",
                                     "-q:v", "4", tmp]), capture_output=True, timeout=60)
        if r.returncode == 0 and os.path.exists(tmp):
            os.replace(tmp, out)
            return out
    open(none, "w").close()
    return None


def prefetch_covers():
    for aid in list(LIB.albums):
        try:
            make_cover(aid)
        except Exception:
            pass


# ───────────────────────── Audio ─────────────────────────
_tc_locks = {}
_tc_guard = threading.Lock()


def audio_file(tid, force_tc=False):
    t = LIB.tracks.get(tid)
    if not t:
        return None, None
    src = track_src(t)
    if not src:
        return None, None
    ext = "." + t["ext"] if REMOTE else os.path.splitext(src)[1].lower()
    if ext in NATIVE_EXT and not force_tc:
        return src, MIME[ext]
    out = os.path.join(AUDIO_DIR, tid + ".flac")
    with _tc_guard:
        lk = _tc_locks.setdefault(tid, threading.Lock())
    with lk:
        if not os.path.exists(out):
            tmp = out + ".tmp.flac"
            r = subprocess.run(nice_cmd(["ffmpeg", "-v", "error", "-y", "-i", src, "-map", "0:a:0",
                                         "-c:a", "flac", "-compression_level", "0", tmp]),
                               capture_output=True, timeout=600)
            if r.returncode != 0:
                return None, None
            os.replace(tmp, out)
            threading.Thread(target=trim_audio_cache, daemon=True).start()
    os.utime(out)
    return out, "audio/flac"


def trim_audio_cache():
    files = [os.path.join(AUDIO_DIR, f) for f in os.listdir(AUDIO_DIR) if f.endswith(".flac")]
    files = sorted(((os.stat(f).st_mtime, os.stat(f).st_size, f) for f in files))
    total = sum(s for _, s, _ in files)
    while files and total > AUDIO_CACHE_LIMIT:
        _, s, f = files.pop(0)
        os.remove(f)
        total -= s


# ───────────────────────── Analyse (Wellenform + BPM) ─────────────────────────
_an_sem = threading.Semaphore(1)


def decode(src, rate, extra_af=None):
    af = ["-af", extra_af] if extra_af else []
    p = subprocess.run(nice_cmd(["ffmpeg", "-v", "error", "-i", src, "-map", "0:a:0", "-ac", "1", *af,
                                 "-ar", str(rate), "-f", "s16le", "-"]), capture_output=True, timeout=300)
    a = array.array("h")
    a.frombytes(p.stdout[: len(p.stdout) // 2 * 2])
    return a


def estimate_bpm(src):
    fps = 200
    a = decode(src, 2000, "lowpass=f=160")
    if len(a) < 2000 * 20:
        return None
    hop = 2000 // fps
    env = [max(a[i:i + hop]) - min(a[i:i + hop]) for i in range(0, len(a) - hop, hop)]
    onset = [0.0] + [max(0, env[i] - env[i - 1]) for i in range(1, len(env))]
    mid = len(onset) // 2
    seg = onset[max(0, mid - fps * 45): mid + fps * 45]
    mean = sum(seg) / len(seg)
    seg = [x - mean for x in seg]
    ac = {}

    def acf(lag):
        if lag not in ac:
            ac[lag] = sum(map(lambda x, y: x * y, seg, seg[lag:])) / max(1, len(seg) - lag)
        return ac[lag]

    best, best_v, scores = None, None, {}
    for lag in range(int(fps * 60 / 180), int(fps * 60 / 70) + 1):
        # Schlag + halber Takt + ganzer Takt (4/4) stützen das echte Tempo
        v = acf(lag) + 0.5 * acf(lag * 2) + 0.5 * acf(lag * 4)
        bpm_l = 60 * fps / lag
        v *= math.exp(-0.5 * (math.log2(bpm_l / 125) / 0.45) ** 2)  # Club-Tempo bevorzugen
        scores[lag] = v
        if best_v is None or v > best_v:
            best, best_v = lag, v
    l = best
    if l - 1 in scores and l + 1 in scores:  # parabolische Verfeinerung
        y0, y1, y2 = scores[l - 1], scores[l], scores[l + 1]
        d = (y0 - 2 * y1 + y2)
        l = l + (0.5 * (y0 - y2) / d if d else 0)
    bpm = 60 * fps / l
    while bpm < 85:
        bpm *= 2
    while bpm > 175:
        bpm /= 2
    return round(bpm, 1)


def analyze(tid):
    out = os.path.join(ANALYSIS_DIR, tid + ".json")
    if os.path.exists(out):
        with open(out) as f:
            return json.load(f)
    t = LIB.tracks.get(tid)
    if not t:
        return None
    with _an_sem:
        if os.path.exists(out):
            with open(out) as f:
                return json.load(f)
        src, _ = audio_file(tid) if t["ext"] in ("aif", "aiff", "aifc") else (track_src(t), None)
        if not src:
            return None
        a = decode(src, 4000)
        n = 4000
        peaks = []
        if a:
            step = max(1, len(a) // n)
            for i in range(0, step * n, step):
                s = a[i:i + step]
                peaks.append(max(max(s), -min(s)) if s else 0)
            m = max(peaks) or 1
            peaks = [round(p / m, 3) for p in peaks]
        bpm = t.get("bpm")
        est = None
        if not bpm:
            try:
                est = estimate_bpm(src)
            except Exception:
                est = None
        res = {"peaks": peaks, "bpm": bpm or est, "bpm_estimated": not bpm and est is not None,
               "duration": len(a) / 4000 if a else t["duration"]}
        with open(out, "w") as f:
            json.dump(res, f)
        return res


# ───────────────────────── Settings ─────────────────────────
DEFAULT_SETTINGS = {"automix_seconds": 16, "keylock": False, "midi_map": {}, "auto_source": "crate"}


def load_settings():
    try:
        with open(SETTINGS_FILE) as f:
            return {**DEFAULT_SETTINGS, **json.load(f)}
    except Exception:
        return dict(DEFAULT_SETTINGS)


def save_settings(s):
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, SETTINGS_FILE)


# ───────────────────────── Events (SSE) + MIDI ─────────────────────────
_clients = set()
_clients_lock = threading.Lock()


def broadcast(ev):
    data = json.dumps(ev)
    with _clients_lock:
        for q in list(_clients):
            try:
                q.put_nowait(data)
            except queue.Full:
                pass


MIDI_DEVS = {}  # path -> name


def midi_name(path):
    m = re.search(r"midiC(\d+)D(\d+)", path)
    try:
        with open(f"/proc/asound/card{m.group(1)}/id") as f:
            return f.read().strip()
    except Exception:
        return os.path.basename(path)


def midi_loop():
    fds = {}  # fd -> (path, parser state)
    last_scan = 0
    while True:
        now = time.time()
        if now - last_scan > 2:
            last_scan = now
            try:
                present = {os.path.join("/dev/snd", f) for f in os.listdir("/dev/snd") if f.startswith("midiC")}
            except OSError:  # kein ALSA (z. B. macOS): kein USB-MIDI
                present = set()
            open_paths = {v[0] for v in fds.values()}
            for p in present - open_paths:
                try:
                    fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK)
                    fds[fd] = [p, None, []]
                    MIDI_DEVS[p] = midi_name(p)
                    broadcast({"type": "mididev", "devices": list(MIDI_DEVS.values())})
                except OSError:
                    pass
        if not fds:
            time.sleep(1)
            continue
        r, _, _ = select.select(list(fds), [], [], 1)
        for fd in r:
            st = fds[fd]
            try:
                data = os.read(fd, 256)
            except OSError:
                data = b""
            if not data:
                os.close(fd)
                MIDI_DEVS.pop(st[0], None)
                del fds[fd]
                broadcast({"type": "mididev", "devices": list(MIDI_DEVS.values())})
                continue
            for b in data:
                if b >= 0xF8:  # Realtime (Clock etc.) ignorieren
                    continue
                if b & 0x80:
                    st[1] = b if b < 0xF0 else None
                    st[2] = []
                    continue
                if st[1] is None:
                    continue
                st[2].append(b)
                need = 1 if (st[1] & 0xF0) in (0xC0, 0xD0) else 2
                if len(st[2]) == need:
                    s = st[1]
                    d = st[2] + [0]
                    broadcast({"type": "midi", "dev": MIDI_DEVS.get(st[0], "?"), "s": s & 0xF0,
                               "ch": s & 0x0F, "d1": d[0], "d2": d[1]})
                    st[2] = []  # running status


# ───────────────────────── HTTP ─────────────────────────
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def send_file(self, path, ctype, cache=True):
        try:
            size = os.path.getsize(path)
            f = open(path, "rb")
        except OSError:
            return self.send_error(404)
        with f:
            rng = self.headers.get("Range")
            start, end = 0, size - 1
            m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
            if m and size:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                if start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                self.send_response(200)
            length = end - start + 1
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "max-age=86400" if cache else "no-cache")
            self.end_headers()
            f.seek(start)
            try:
                while length > 0:
                    chunk = f.read(min(262144, length))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    length -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        qs = urllib.parse.parse_qs(u.query)
        if p == "/api/library":
            return self.send_json(LIB.payload())
        if p == "/api/status":
            return self.send_json({**LIB.status, "midi": list(MIDI_DEVS.values()), "temp": cpu_temp()})
        if p == "/api/settings":
            return self.send_json(load_settings())
        if p.startswith("/api/cover/"):
            c = make_cover(p.rsplit("/", 1)[1])
            return self.send_file(c, "image/jpeg") if c else self.send_error(404)
        if p.startswith("/api/audio/"):
            path, ctype = audio_file(p.rsplit("/", 1)[1], force_tc="tc" in qs)
            return self.send_file(path, ctype) if path else self.send_error(404)
        if p.startswith("/api/analysis/"):
            r = analyze(p.rsplit("/", 1)[1])
            return self.send_json(r) if r else self.send_error(404)
        if p == "/api/events":
            return self.events()
        # statische Dateien
        rel = "index.html" if p in ("/", "") else urllib.parse.unquote(p.lstrip("/"))
        full = os.path.realpath(os.path.join(STATIC, rel))
        if not full.startswith(os.path.realpath(STATIC)) or not os.path.isfile(full):
            return self.send_error(404)
        return self.send_file(full, MIME.get(os.path.splitext(full)[1], "application/octet-stream"), cache=False)

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        if p == "/api/settings":
            try:
                s = {**load_settings(), **json.loads(body or b"{}")}
            except ValueError:
                return self.send_error(400)
            save_settings(s)
            return self.send_json(s)
        if p == "/api/rescan":
            threading.Thread(target=LIB.scan_remote if REMOTE else LIB.scan, daemon=True).start()
            return self.send_json({"ok": True})
        if p.startswith("/api/prepare/"):
            tid = p.rsplit("/", 1)[1]
            threading.Thread(target=lambda: (audio_file(tid), analyze(tid)), daemon=True).start()
            return self.send_json({"ok": True})
        self.send_error(404)

    def events(self):
        q = queue.Queue(maxsize=500)
        with _clients_lock:
            _clients.add(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(f"data: {json.dumps({'type': 'mididev', 'devices': list(MIDI_DEVS.values())})}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    d = q.get(timeout=15)
                    self.wfile.write(f"data: {d}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _clients_lock:
                _clients.discard(q)
            self.close_connection = True


def cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read()) / 1000)
    except Exception:
        return None


def periodic_scan():
    while True:
        if REMOTE or os.path.isdir(MUSIC_ROOT):
            try:
                LIB.scan_remote() if REMOTE else LIB.scan()
            except Exception as e:
                print("scan error:", e, flush=True)
        time.sleep(1800)


if __name__ == "__main__":
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg fehlt")
    threading.Thread(target=periodic_scan, daemon=True).start()
    threading.Thread(target=midi_loop, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), H)
    srv.daemon_threads = True
    print(f"DJBOX läuft auf http://{HOST}:{PORT}  (Musik: {ND_URL if REMOTE else MUSIC_ROOT})", flush=True)
    srv.serve_forever()
