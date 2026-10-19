#!/usr/bin/env python3
"""Corner Deli TV greeter for the Raspberry Pi 3 A+ on the front TV.

Chromium is too heavy for this Pi (512 MB), so this shows pictures full screen
instead: the logo with the order-online QR code and the Ogdensburg weather
(GET /api/pos/greeter/weather) take turns every 15 seconds, and "Welcome to Corner
Deli!" interrupts either for 8 seconds with a spoken greeting whenever the entrance
camera records a walk-in. The pictures and the greeting come from the app
(public/greeter/); walk-ins come from GET /api/pos/greeter, polled every 2 seconds. Run from labwc's autostart under
lwrespawn; see README.md next to this file.
"""
import json
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


def log(message):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)


def fetch(path, timeout=5):
    with urllib.request.urlopen(f"{SERVER}{path}", timeout=timeout) as response:
        return response.read()


def refresh_weather():
    """The weather slide; keeps the last good picture if the server can't make a new one."""
    try:
        data = fetch("/api/pos/greeter/weather", timeout=60)
        if not data.startswith(b"\x89PNG"):
            raise ValueError("not a picture")
        tmp = os.path.join(CACHE, "weather.png.tmp")
        with open(tmp, "wb") as handle:
            handle.write(data)
        os.replace(tmp, os.path.join(CACHE, "weather.png"))
    except Exception as error:  # noqa: BLE001
        log(f"could not refresh weather: {error}")


def refresh_assets():
    """Download the pictures and greeting; keep the last good copies if the server is away."""
    os.makedirs(CACHE, exist_ok=True)
    for name in ("idle.png", "welcome.png", "welcome.mp3"):
        try:
            data = fetch(f"/greeter/{name}", timeout=30)
            tmp = os.path.join(CACHE, name + ".tmp")
            with open(tmp, "wb") as handle:
                handle.write(data)
            os.replace(tmp, os.path.join(CACHE, name))
        except Exception as error:  # noqa: BLE001 - any failure just keeps the cached copy
            log(f"could not refresh {name}: {error}")


class Greeter(Gtk.Window):
    def __init__(self):
        super().__init__(title="Corner Deli greeter")
        self.image = Gtk.Image()
        self.add(self.image)
        self.connect("destroy", Gtk.main_quit)
        self.connect("configure-event", lambda *_: self.show_picture(self.current))
        self.pictures = {}
        self.current = "idle"
        self.idle_slide = "idle"
        self.welcoming = False
        self.initialized = False
        self.last_id = 0
        self.hide_timer = None
        self.load_pictures()
        self.fullscreen()
        self.show_all()
        self.hide_cursor()
        GLib.timeout_add_seconds(POLL_SECONDS, self.poll)
        GLib.timeout_add_seconds(REFRESH_SECONDS, self.refresh)
        GLib.timeout_add_seconds(ROTATE_SECONDS, self.rotate)
        GLib.timeout_add_seconds(WEATHER_SECONDS, self.refresh_weather)

    def hide_cursor(self):
        window = self.get_window()
        if window:
            window.set_cursor(Gdk.Cursor.new_for_display(Gdk.Display.get_default(), Gdk.CursorType.BLANK_CURSOR))

    def load_pictures(self):
        for name in ("idle", "welcome", "weather"):
            path = os.path.join(CACHE, f"{name}.png")
            if os.path.exists(path):
                self.pictures[name] = GdkPixbuf.Pixbuf.new_from_file(path)
        self.scaled = {}
        self.show_picture(self.current)

    def show_picture(self, name):
        self.current = name
        source = self.pictures.get(name)
        if not source:
            return False
        width, height = self.get_size()
        key = (name, width, height)
        if key not in self.scaled:
            scale = min(width / source.get_width(), height / source.get_height())
            self.scaled[key] = source.scale_simple(
                max(1, int(source.get_width() * scale)), max(1, int(source.get_height() * scale)), GdkPixbuf.InterpType.BILINEAR
            )
        self.image.set_from_pixbuf(self.scaled[key])
        return False

    def rotate(self):
        """Logo/QR and weather take turns while nobody is being welcomed."""
        if "weather" in self.pictures:
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
    style = Gtk.CssProvider()
    style.load_from_data(b"window { background-color: #0f1d14; }")
    Gtk.StyleContext.add_provider_for_screen(
        Gdk.Screen.get_default(), style, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )
    window = Greeter()
    if "--greet" in sys.argv:  # show the welcome once a few seconds after start, to check picture and sound
        GLib.timeout_add_seconds(3, window.greet)
    Gtk.main()


if __name__ == "__main__":
    main()
