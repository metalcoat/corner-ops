# Corner Deli door alarm (Windows tray program)

`CornerDeliDoorAlarm.exe` sits in the Windows system tray on the always-on store PC and
plays a loud ding-dong (`chime.wav`, the POS "Door chime" sound, 2× by default) each time the
entrance camera records a walk-in. It polls `GET /api/pos/greeter` on the store server every
2 seconds. That endpoint is read-only, needs no login, is served only on the store network,
and returns just the newest walk-in's id, kind and age in seconds.

It is also the only place curbside check-ins alert (the greeter TV out front stays quiet). It polls
`GET /api/pos/greeter/arrivals` every 2 seconds; for each customer who tapped I'M HERE it plays the
curbside bell (`curbside.wav`) once and adds a card (car "Red SUV", name, order number) to an
always-on-top panel in the right-hand camera column of SmartPSS. Cars stack; text wraps and shrinks
to fit. The CURBSIDE header and the border flash red/yellow, the cards stay steady. The panel never
takes focus, has no taskbar button and lets clicks through (nobody touches that screen). A card goes
away only when staff tap DELIVERED TO CAR on the POS (or the order is completed, or after 20 minutes),
because the server stops listing it. Customers already waiting when the program starts do alert. The
tray's Mute only silences the walk-in chime. The "Test curbside alert" card clears itself after 30 s.

- Green tray dot: listening. Red: can't reach the server (walk-ins won't sound). Grey: muted.
- Right-click the dot: version, Test chime, Test curbside alert, Mute walk-in chime for 10 minutes /
  Unmute, Open walk-ins dashboard, Quit.
- Walk-ins from before it started, or more than 20 s old when it hears about them, don't ring.
- The version (`version` in `main.go`) is in the tray menu and the log; bump it for each new download.
- `config.json` next to the .exe (created on first run): `{"server": "http://192.168.1.237:3000", "repeat": 2,
  "popup": {"x": 1395, "y": 60, "width": 475, "height": 920}}`. `popup` is where the curbside panel may go,
  in pixels of a 1920x1080 screen (scaled on other resolutions); it is only as tall as its cards need.
  Leave it out to use those defaults.
- `door-alarm.log` next to the .exe records connection problems and each walk-in.

## Build (on the store server)

```sh
cd tools/door-alarm-windows
docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp -e GOTOOLCHAIN=local -v "$PWD":/src -w /src golang:1.23-bookworm \
  sh -c 'go test ./... && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui -s -w" -o CornerDeliDoorAlarm.exe .'
python3 -c "import zipfile; z=zipfile.ZipFile('../../public/downloads/CornerDeliDoorAlarm.zip','w',zipfile.ZIP_DEFLATED); [z.write(f) for f in ('CornerDeliDoorAlarm.exe','SETUP.txt')]"
```

The download is then `http://192.168.1.237:3000/downloads/CornerDeliDoorAlarm.zip` on the store network.
