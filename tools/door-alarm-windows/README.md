# Corner Deli door alarm (Windows tray program)

`CornerDeliDoorAlarm.exe` sits in the Windows system tray on the always-on PC up front and
plays a loud ding-dong (`chime.wav`, the POS "Door chime" sound, 2× by default) each time the
entrance camera records a walk-in. It polls `GET /api/pos/greeter` on the store server every
2 seconds. That endpoint is read-only, needs no login, is served only on the store network,
and returns just the newest walk-in's id, kind and age in seconds.

- Green tray dot: listening. Red: can't reach the server (walk-ins won't sound). Grey: muted.
- Right-click the dot: Test chime, Mute for 10 minutes / Unmute, Open walk-ins dashboard, Quit.
- Walk-ins from before it started, or more than 20 s old when it hears about them, don't ring.
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
