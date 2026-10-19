# Corner Deli TV greeter (Raspberry Pi 3 A+)

`greeter.py` shows the Corner Deli logo with the order-online QR code full screen,
taking turns every 15 seconds with the Ogdensburg weather (`GET /api/pos/greeter/weather`,
a PNG the app draws from api.weather.gov, refreshed every 20 minutes), and switches to
"Welcome to Corner Deli!" with a spoken greeting for 8 seconds when the entrance camera
records a walk-in (`GET /api/pos/greeter`). The pictures and the
greeting are `public/greeter/idle.png`, `welcome.png` and `welcome.mp3` in the app;
the Pi downloads them at start and every 6 hours and keeps the last copies.

Chromium is not used: on this Pi (512 MB) it crashes. To change the screens, edit
`src/app/pos/greeter/` and re-render the two PNGs from `/pos/greeter` (1920×1080).

## Install (from the store server)

```sh
ssh -i ~/.ssh/corner_greeter_ed25519 chris@corner-greeter   # 192.168.6.217 on the TV Wi-Fi
mkdir -p ~/greeter && scp tools/greeter-pi/greeter.py chris@corner-greeter:greeter/
```

`~/.config/labwc/autostart` on the Pi:

```sh
/usr/bin/kanshi &
/usr/bin/lwrespawn /usr/bin/python3 /home/chris/greeter/greeter.py >> /home/chris/greeter/greeter.log 2>&1 &
```

Sound goes to HDMI (`wpctl set-default <HDMI sink>`); screen blanking is off
(`raspi-config nonint do_blanking 1`). `python3 greeter.py --greet` shows the welcome
once after start to check picture and sound.
