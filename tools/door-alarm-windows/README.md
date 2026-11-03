# Corner Deli door alarm (Windows tray program)

`CornerDeliDoorAlarm.exe` sits in the Windows system tray on the always-on store PC and
plays a loud ding-dong (`chime.wav`, the POS "Door chime" sound, 2× by default) each time the
entrance camera records a walk-in. It polls `GET /api/pos/greeter` on the store server every
2 seconds. That endpoint is read-only, needs no login, is served only on the store network,
and returns just the newest walk-in's id, kind and age in seconds.

It is also the only place curbside check-ins alert (the greeter TV out front stays quiet). It polls
`GET /api/pos/greeter/arrivals` every 2 seconds; for each customer who tapped I'M HERE it plays the
curbside bell (`curbside.wav`) and opens a flashing red/yellow always-on-top popup in the middle of
the screen with the car ("Red SUV"), the customer's name and the order number, one row and Dismiss
button per customer. The bell repeats every 20 s until every row is dismissed; a row also goes away
by itself when the order is completed or after 20 minutes (the server stops listing it). Customers
already waiting when the program starts do alert. Mute only silences the walk-in chime.

- Green tray dot: listening. Red: can't reach the server (walk-ins won't sound). Grey: muted.
- Right-click the dot: version, Test chime, Test curbside alert, Mute walk-in chime for 10 minutes /
  Unmute, Open walk-ins dashboard, Quit.
- Walk-ins from before it started, or more than 20 s old when it hears about them, don't ring.
- The version (`version` in `main.go`) is in the tray menu and the log; bump it for each new download.
- `config.json` next to the .exe (created on first run): `{"server": "http://192.168.1.237:3000", "repeat": 2}`.
- `door-alarm.log` next to the .exe records connection problems and each walk-in.

## Build (on the store server)

```sh
cd tools/door-alarm-windows
docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp -e GOTOOLCHAIN=local -v "$PWD":/src -w /src golang:1.23-bookworm \
  sh -c 'go test ./... && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui -s -w" -o CornerDeliDoorAlarm.exe .'
python3 -c "import zipfile; z=zipfile.ZipFile('../../public/downloads/CornerDeliDoorAlarm.zip','w',zipfile.ZIP_DEFLATED); [z.write(f) for f in ('CornerDeliDoorAlarm.exe','SETUP.txt')]"
```

The download is then `http://192.168.1.237:3000/downloads/CornerDeliDoorAlarm.zip` on the store network.
