#!/usr/bin/env python3
"""Corner Deli TV greeter for the Raspberry Pi 3 A+ on the front TV.

Chromium is too heavy for this Pi (512 MB), so this shows pictures full screen
instead: the logo with the order-online QR code and the Ogdensburg weather
(GET /api/pos/greeter/weather) take turns every 15 seconds, and "Welcome to Corner
Deli!" interrupts either for 8 seconds with a spoken greeting whenever the entrance
camera records a walk-in. The pictures and the greeting come from the app
(public/greeter/); walk-ins come from GET /api/pos/greeter, polled every 2 seconds.

On the weather slide it animates the weather (sun, moon and stars, clouds, rain,
snow, lightning, fog) in the sky beside the temperature and on each day card, at
about 12 frames a second. Only those areas are redrawn, so the Pi stays cool; where
they go comes from GET /api/pos/greeter/weather/info. All shapes are drawn here.
"""
import json
import math
import os
import subprocess
import sys
import threading
import time
import urllib.request

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402

SERVER = os.environ.get("GREETER_SERVER", "http://192.168.1.237:3000").rstrip("/")
CACHE = os.path.expanduser("~/greeter/cache")
POLL_SECONDS = 2
WELCOME_SECONDS = 8
# Like the web greeter: never greet a walk-in older than this (the Pi was offline or just started).
RECENT_SECONDS = 20
REFRESH_SECONDS = 6 * 60 * 60
# Idle slides take turns; the weather picture is fetched again this often.
ROTATE_SECONDS = 15
WEATHER_SECONDS = 20 * 60
FRAME_MS = 80
# The slides are drawn for this size; the TV is 1920x1080, so normally nothing is scaled.
SLIDE_W, SLIDE_H = 1920, 1080


def log(message):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)


def fetch(path, timeout=5):
    with urllib.request.urlopen(f"{SERVER}{path}", timeout=timeout) as response:
        return response.read()


def save(name, data):
    tmp = os.path.join(CACHE, name + ".tmp")
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, os.path.join(CACHE, name))


def refresh_weather():
    """The weather slide and what to animate on it; keeps the last good copies on failure."""
    try:
        data = fetch("/api/pos/greeter/weather", timeout=60)
        if not data.startswith(b"\x89PNG"):
            raise ValueError("not a picture")
        info = fetch("/api/pos/greeter/weather/info", timeout=60)
        json.loads(info)
        save("weather.png", data)
        save("weather.json", info)
    except Exception as error:  # noqa: BLE001
        log(f"could not refresh weather: {error}")


def refresh_assets():
    """Download the pictures and greeting; keep the last good copies if the server is away."""
    os.makedirs(CACHE, exist_ok=True)
    for name in ("idle.png", "welcome.png", "welcome.mp3"):
        try:
            save(name, fetch(f"/greeter/{name}", timeout=30))
        except Exception as error:  # noqa: BLE001 - any failure just keeps the cached copy
            log(f"could not refresh {name}: {error}")


# --- Weather drawings (Cairo) ------------------------------------------------------------
# Each takes a context already moved and scaled so the area is w x h, and the time t in seconds.

SUN = (0.97, 0.74, 0.20)
CLOUD = (0.93, 0.95, 0.96)
DARK_CLOUD = (0.55, 0.60, 0.66)
RAIN = (0.55, 0.78, 1.0)


def hash01(n):
    """Repeatable 0..1 pseudo-random number for particle n (no state, no randomness)."""
    return (math.sin(n * 12.9898 + 78.233) * 43758.5453) % 1.0


def sun(cr, x, y, r, t):
    cr.save()
    cr.translate(x, y)
    glow = 0.18 + 0.06 * math.sin(t * 1.6)
    cr.set_source_rgba(*SUN, glow)
    cr.arc(0, 0, r * 1.55, 0, 2 * math.pi)
    cr.fill()
    cr.rotate(t * 0.35)
    cr.set_source_rgba(*SUN, 0.95)
    cr.set_line_width(max(2, r * 0.13))
    cr.set_line_cap(1)  # round
    for i in range(12):
        a = i * math.pi / 6
        cr.move_to(math.cos(a) * r * 1.2, math.sin(a) * r * 1.2)
        cr.line_to(math.cos(a) * r * 1.5, math.sin(a) * r * 1.5)
    cr.stroke()
    cr.arc(0, 0, r, 0, 2 * math.pi)
    cr.fill()
    cr.restore()


def moon(cr, x, y, r):
    """A crescent: the full disc with an offset disc cut out of it."""
    cr.save()
    cr.push_group()
    cr.set_source_rgba(0.98, 0.95, 0.82, 0.95)
    cr.arc(x, y, r, 0, 2 * math.pi)
    cr.fill()
    cr.set_operator(0)  # CLEAR
    cr.arc(x + r * 0.5, y - r * 0.3, r * 0.85, 0, 2 * math.pi)
    cr.fill()
    cr.pop_group_to_source()
    cr.paint()
    cr.restore()


def stars(cr, w, h, t, count):
    for n in range(count):
        sx, sy = hash01(n) * w, hash01(n + 99) * h * 0.85
        alpha = 0.25 + 0.65 * (0.5 + 0.5 * math.sin(t * (0.8 + hash01(n + 7)) + n))
        cr.set_source_rgba(1, 1, 0.9, alpha)
        size = 2 + 3 * hash01(n + 3)
        cr.arc(sx, sy, size, 0, 2 * math.pi)
        cr.fill()


def cloud(cr, x, y, s, color, alpha=0.96):
    """A cloud about 2.6s wide and 1.2s tall, centered on x, y."""
    cr.save()
    # One path for all the puffs, so a see-through cloud doesn't show where they overlap.
    cr.set_source_rgba(*color, alpha)
    for dx, dy, r in ((-0.75, 0.15, 0.5), (-0.2, -0.25, 0.65), (0.5, -0.05, 0.55), (0.95, 0.25, 0.38)):
        cr.new_sub_path()
        cr.arc(x + dx * s, y + dy * s, r * s, 0, 2 * math.pi)
    cr.rectangle(x - 1.15 * s, y + 0.1 * s, 2.45 * s, 0.55 * s)
    cr.set_fill_rule(0)  # WINDING: overlapping parts fill once
    cr.fill()
    cr.restore()


def falling(cr, w, top, h, t, count, speed, snow):
    for n in range(count):
        px = hash01(n) * w
        phase = (t * speed / h + hash01(n + 50)) % 1.0
        py = top + phase * h
        if snow:
            px += math.sin(t * 1.3 + n) * 10
            cr.set_source_rgba(1, 1, 1, 0.9)
            cr.arc(px, py, 3 + 3 * hash01(n + 5), 0, 2 * math.pi)
            cr.fill()
        else:
            cr.set_source_rgba(*RAIN, 0.85)
            cr.set_line_width(3)
            cr.move_to(px, py)
            cr.line_to(px - 6, py + 22)
            cr.stroke()


def bolt(cr, x, y, s):
    cr.set_source_rgba(1, 0.92, 0.35, 1)
    points = ((0, 0), (-0.35, 0.75), (-0.05, 0.75), (-0.3, 1.5), (0.4, 0.55), (0.08, 0.55), (0.3, 0))
    cr.move_to(x + points[0][0] * s, y + points[0][1] * s)
    for px, py in points[1:]:
        cr.line_to(x + px * s, y + py * s)
    cr.close_path()
    cr.fill()


def fog(cr, w, h, t, bands):
    for i in range(bands):
        y = h * (0.25 + 0.6 * i / max(1, bands - 1))
        offset = math.sin(t * 0.4 + i * 1.7) * w * 0.08
        cr.set_source_rgba(0.85, 0.88, 0.9, 0.35)
        cr.set_line_width(h * 0.07)
        cr.set_line_cap(1)
        cr.move_to(w * 0.12 + offset, y)
        cr.line_to(w * 0.88 + offset, y)
        cr.stroke()


def draw_weather(cr, kind, w, h, t, small):
    """One weather animation filling a w x h area (the sky, or a card icon when small)."""
    cx, cy, s = w / 2, h / 2, min(w, h)
    drift = math.sin(t * 0.5) * s * 0.04
    if kind == "clear":
        sun(cr, cx, cy, s * (0.24 if small else 0.2), t)
    elif kind == "clear_night":
        if not small:
            stars(cr, w, h, t, 26)
        moon(cr, cx, cy, s * (0.28 if small else 0.22))
    elif kind == "partly_cloudy":
        sun(cr, cx - s * 0.12, cy - s * 0.1, s * (0.2 if small else 0.17), t)
        cloud(cr, cx + s * 0.1 + drift, cy + s * 0.14, s * (0.2 if small else 0.16), CLOUD)
    elif kind == "cloudy":
        if small:
            cloud(cr, cx + drift, cy, s * 0.22, CLOUD)
        else:
            span = w + s * 0.8
            for i, (fy, fs) in enumerate(((0.3, 0.14), (0.62, 0.18), (0.42, 0.11), (0.8, 0.13))):
                # Evenly spaced across the sky, all drifting right at the same slow pace.
                x = ((t * 14 + i * span / 4) % span) - s * 0.4
                cloud(cr, x, h * fy, s * fs, CLOUD, 0.85)
    elif kind in ("rain", "storm", "snow"):
        color = DARK_CLOUD if kind == "storm" else CLOUD
        if small:
            falling(cr, w * 0.7, cy, h * 0.45, t, 7, 90, kind == "snow")
            cloud(cr, cx + drift, cy - s * 0.12, s * 0.2, color)
        else:
            falling(cr, w, 0, h, t, 60 if kind != "snow" else 45, 260 if kind != "snow" else 70, kind == "snow")
            cloud(cr, cx + drift, cy - s * 0.12, s * 0.16, color)
        if kind == "storm" and (t % 3.2) < 0.35:
            if not small:
                cr.set_source_rgba(1, 1, 0.85, 0.18)
                cr.paint()
            bolt(cr, cx, cy, s * (0.2 if small else 0.16))
    elif kind == "fog":
        fog(cr, w, h, t, 3 if small else 5)


class Greeter(Gtk.Window):
    def __init__(self):
        super().__init__(title="Corner Deli greeter")
        self.area = Gtk.DrawingArea()
        self.area.connect("draw", self.on_draw)
        self.add(self.area)
        self.connect("destroy", Gtk.main_quit)
        self.surfaces = {}
        self.current = "idle"
        self.idle_slide = "idle"
        self.welcoming = False
        self.initialized = False
        self.last_id = 0
        self.hide_timer = None
        self.animations = []
        self.started = time.monotonic()
        self.draw_errors = 0
        self.fullscreen()
        self.show_all()
        self.hide_cursor()
        self.load_pictures()
        GLib.timeout_add_seconds(POLL_SECONDS, self.poll)
        GLib.timeout_add_seconds(REFRESH_SECONDS, self.refresh)
        GLib.timeout_add_seconds(ROTATE_SECONDS, self.rotate)
        GLib.timeout_add_seconds(WEATHER_SECONDS, self.refresh_weather)
        GLib.timeout_add(FRAME_MS, self.tick)

    def hide_cursor(self):
        window = self.get_window()
        if window:
            window.set_cursor(Gdk.Cursor.new_for_display(Gdk.Display.get_default(), Gdk.CursorType.BLANK_CURSOR))

    def load_pictures(self):
        """Turn each picture into a screen-ready surface once; the pixbufs are dropped after."""
        window = self.get_window()
        for name in ("idle", "welcome", "weather"):
            path = os.path.join(CACHE, f"{name}.png")
            if os.path.exists(path) and window:
                pixbuf = GdkPixbuf.Pixbuf.new_from_file(path)
                self.surfaces[name] = Gdk.cairo_surface_create_from_pixbuf(pixbuf, 1, window)
        try:
            with open(os.path.join(CACHE, "weather.json"), "r", encoding="utf-8") as handle:
                info = json.load(handle)
            self.animations = ([info["sky"]] if info.get("sky") else []) + list(info.get("cards", []))
        except Exception:  # noqa: BLE001 - no animations until weather info arrives
            self.animations = []
        self.area.queue_draw()
        return False

    def layout(self):
        """Scale and offset that fit a 1920x1080 slide on this screen."""
        width, height = self.area.get_allocated_width(), self.area.get_allocated_height()
        scale = min(width / SLIDE_W, height / SLIDE_H) or 1
        return scale, (width - SLIDE_W * scale) / 2, (height - SLIDE_H * scale) / 2

    def on_draw(self, _widget, cr):
        cr.set_source_rgb(0.06, 0.11, 0.08)
        cr.paint()
        surface = self.surfaces.get(self.current)
        if not surface:
            return False
        scale, ox, oy = self.layout()
        cr.save()
        cr.translate(ox, oy)
        cr.scale(scale, scale)
        cr.set_source_surface(surface, 0, 0)
        cr.paint()
        if self.current == "weather":
            t = time.monotonic() - self.started
            for item in self.animations:
                x, y, w, h = item["rect"]
                cr.save()
                cr.rectangle(x, y, w, h)
                cr.clip()
                cr.translate(x, y)
                try:
                    draw_weather(cr, item.get("kind", "clear"), w, h, t, small=w < 300)
                except Exception as error:  # noqa: BLE001 - a drawing bug must never blank the TV
                    self.draw_errors += 1
                    if self.draw_errors < 5:
                        log(f"weather animation failed: {error}")
                cr.restore()
        cr.restore()
        return False

    def tick(self):
        """Redraw only the animated areas, and only while the weather slide is showing."""
        if self.current == "weather" and self.animations:
            scale, ox, oy = self.layout()
            for item in self.animations:
                x, y, w, h = item["rect"]
                self.area.queue_draw_area(int(ox + x * scale), int(oy + y * scale), int(w * scale) + 2, int(h * scale) + 2)
        return True

    def show_picture(self, name):
        self.current = name
        self.area.queue_draw()
        return False

    def rotate(self):
        """Logo/QR and weather take turns while nobody is being welcomed."""
        if "weather" in self.surfaces:
            self.idle_slide = "weather" if self.idle_slide == "idle" else "idle"
        else:
            self.idle_slide = "idle"
        if not self.welcoming:
            self.show_picture(self.idle_slide)
        return True

    def refresh_weather(self):
        def work():
            refresh_weather()
            GLib.idle_add(self.load_pictures)

        threading.Thread(target=work, daemon=True).start()
        return True

    def refresh(self):
        def work():
            refresh_assets()
            GLib.idle_add(self.load_pictures)

        threading.Thread(target=work, daemon=True).start()
        return True

    def poll(self):
        threading.Thread(target=self.check_walk_in, daemon=True).start()
        return True

    def check_walk_in(self):
        try:
            latest = json.loads(fetch("/api/pos/greeter")).get("latest")
        except Exception as error:  # noqa: BLE001
            log(f"server not reachable: {error}")
            return
        walk_in_id = int(latest["id"]) if latest else 0
        first = not self.initialized
        self.initialized = True
        if walk_in_id <= self.last_id:
            return
        self.last_id = walk_in_id
        if first or not latest or latest.get("ageSeconds", 999) > RECENT_SECONDS:
            return
        log(f"greeting walk-in {walk_in_id}")
        GLib.idle_add(self.greet)

    def greet(self):
        self.welcoming = True
        self.show_picture("welcome")
        greeting = os.path.join(CACHE, "welcome.mp3")
        if os.path.exists(greeting):
            subprocess.Popen(
                ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", greeting],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        if self.hide_timer:
            GLib.source_remove(self.hide_timer)
        self.hide_timer = GLib.timeout_add_seconds(WELCOME_SECONDS, self.back_to_idle)
        return False

    def back_to_idle(self):
        self.hide_timer = None
        self.welcoming = False
        self.show_picture(self.idle_slide)
        return False


def main():
    refresh_assets()
    refresh_weather()
    window = Greeter()
    if "--greet" in sys.argv:  # show the welcome once a few seconds after start, to check picture and sound
        GLib.timeout_add_seconds(3, window.greet)
    if "--weather" in sys.argv:  # stay on the weather slide, to check the animations
        window.idle_slide = "weather"
        window.show_picture("weather")
    Gtk.main()


if __name__ == "__main__":
    main()
