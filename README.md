# F1 Telemetry

Live dashboard for **F1 25** UDP telemetry, with a speaking race engineer. You can run it as a web page (`node server.js`) or as a Windows desktop app (Electron).

| | Command |
|---|---|
| Web version, live | `node server.js` then open http://localhost:3000 |
| Web version, fake data | `node server.js --demo` |
| Desktop app (development) | `npm install` once, then `npm start` (or `npm run start:demo`) |
| Build the Windows installer and portable .exe | `npm run dist` (output in `dist\`) |

Game settings (F1 25 > Settings > Telemetry Settings): UDP Telemetry **On**, Broadcast **Off**, IP **127.0.0.1**, Port **20777**, Send Rate 30 or 60 Hz, UDP Format **2025**.

---

## Engineer voice (Piper)

By default the engineer uses your browser's built-in speech. If you install **Piper**, a free offline neural text-to-speech engine, the engineer uses a natural-sounding voice played through a team-radio effect (band-pass filter, light distortion, compression, crackle and squelch). If Piper is missing or fails, the dashboard switches back to browser speech by itself, and the engineer caption says why.

### 1. Download Piper for Windows

The original Piper project (github.com/rhasspy/piper) was archived in October 2025. Development moved to `OHF-Voice/piper1-gpl`, which is a Python package without a ready-made `.exe`. The standalone Windows build is still the last release of the original project:

- https://github.com/rhasspy/piper/releases/tag/2023.11.14-2 → download **`piper_windows_amd64.zip`**

Unzip it. It contains a `piper` folder with `piper.exe`, several `.dll` files and an `espeak-ng-data` folder. Copy **everything** from that folder into the project's `piper\` folder. `piper.exe` needs its DLLs and `espeak-ng-data` beside it.

```
f1telemetry\
  server.js
  index.html
  piper\
    piper.exe
    onnxruntime.dll, espeak-ng.dll, piper_phonemize.dll, ...
    espeak-ng-data\
    voices\
      en_GB-alan-medium.onnx
      en_GB-alan-medium.onnx.json
```

### 2. Download a voice (English, UK, male)

Voices are hosted at https://huggingface.co/rhasspy/piper-voices (browse to `en/en_GB/`). Every voice needs **two files**, the `.onnx` model (about 60 MB for "medium") and its `.onnx.json` config. Put both in `piper\voices\` and keep the file names unchanged.

The UK English voices currently listed are alan, alba, aru, cori, jenny_dioco, northern_english_male, semaine, southern_english_female and vctk. The two male voices that suit a race engineer:

| Voice | Qualities | Files (under `en/en_GB/…`) |
|---|---|---|
| **alan** (recommended) | low, medium | `alan/medium/en_GB-alan-medium.onnx` + `.onnx.json` |
| **northern_english_male** | medium | `northern_english_male/medium/en_GB-northern_english_male-medium.onnx` + `.onnx.json` |

Direct download links follow this pattern (on the Hugging Face page, click a file and then **download**):
`https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx`

You can listen to samples first at https://rhasspy.github.io/piper-samples/.

### 3. Test Piper from the command line

```bat
cd C:\Users\roland.regacho\Pictures\f1telemetry\piper
echo Box this lap, box this lap. | piper.exe --model voices\en_GB-alan-medium.onnx --output_file test.wav
start test.wav
```

If you hear the sentence, start the dashboard. At start-up the server prints `Engineer voice: Piper with 1 voice(s): en_GB-alan-medium`. Turn the radio on in the top bar and choose the voice under "Local neural (Piper)" in the voice list.

### 4. Settings

The **FX** button next to the volume slider opens:

- **Radio effect**: 0 is a clean studio voice and 1 is heavy team radio. The effect applies only to Piper voices, because browser speech can't be routed through Web Audio. At 0 the squelch bursts are off as well.
- **Speaking speed**: 0.7× to 1.4×. For Piper this sets `length_scale = 1 / speed`; for browser speech it scales the rate.
- **Test radio**: speaks a short test message.

The voice, volume, effect, speed and radio on/off choices are remembered in your browser.

For deeper tuning, edit the `CONFIG` block at the top of `server.js`:

| Setting | Piper flag | Effect |
|---|---|---|
| `lengthScale` (1.0) | `--length_scale` | Above 1 is slower, below 1 is faster. The speed slider divides this value. |
| `noiseScale` (0.667) | `--noise_scale` | Variation in the voice. Lower (about 0.4) is steadier and flatter; higher is more expressive but can wobble. |
| `noiseW` (0.8) | `--noise_w` | Variation in phoneme timing. Lower is more even and robotic; higher is more natural rhythm. |
| `cacheMB` (200) | | Size cap of `tts-cache\`. The least recently used clips are deleted first. |
| `timeoutMs`, `maxParallel`, `maxChars` | | Limits per sentence. |

Changing these values changes the cache key, so new clips are generated automatically.

### How it works

- `GET /tts/voices` lists the installed voices and reports whether Piper was found.
- `GET /tts?voice=<id>&speed=<x>&text=<sentence>` runs `piper.exe` (text on stdin, WAV to a file) and returns `audio/wav`. Each clip is cached in `tts-cache\`, keyed by a hash of voice + settings + text, so repeated lines like "Radio check" are instant. Requests for the same sentence that arrive at the same time share one Piper run.
- The page fetches one sentence at a time and preloads the next while the current one plays.

### Adding more voices

Download another `.onnx` + `.onnx.json` pair into `piper\voices\` and open the FX panel (or reload the page). The voice appears in the list. Multi-speaker voices (aru, semaine, vctk) use speaker 0. In the desktop app you can also drop voices into `Documents\F1Telemetry\piper\voices\`.

### Voices that need Piper 1.5+

Voices added or retrained in 2025, such as `en_US-mike-medium`, were made with Piper 1.5 or later. Their `.onnx.json` has `"piper_version": "1.5.0"` or higher. The 2023 `piper.exe` can't read them: it crashes with code 3221226505 ("Phonemes must be one codepoint"). The dashboard detects these voices and says so in the caption. The newer Piper is a Python package; it plays both the new and the older voices. Install it into the project's `piper\py` folder:

1. Install Python 3.9 or newer if you don't have it: from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), or with `winget install Python.Python.3.12`.
2. Run these commands:

```bat
cd C:\Users\roland.regacho\Pictures\f1telemetry
py -m venv piper\py
piper\py\Scripts\python -m pip install piper-tts
echo Box this lap. | piper\py\Scripts\piper.exe -m piper\voices\en_US-mike-medium.onnx -f test.wav
start test.wav
```

When `piper\py\Scripts\piper.exe` exists, the server uses it instead of `piper\piper.exe`. You don't need to restart; reload the page. The FX panel shows which engine is active. To use a Piper installed elsewhere, set the environment variable `F1T_PIPER_EXE` to its full path.

Each sentence takes about 1 to 2 seconds the first time (Piper loads the voice for every sentence); repeated lines come from the cache instantly, and the next sentence is prepared while the current one plays.

In the packaged desktop app, the `py` folder is bundled too. It relies on the Python installed on your PC, so a copy of the app on another PC needs that PC's own `piper\py`. You can create it inside `Documents\F1Telemetry\piper\`.

### Troubleshooting the voice

| Symptom | Fix |
|---|---|
| Caption says "Piper unavailable: Piper not found" | `piper.exe` is not directly in the `piper\` folder (check for an extra `piper\piper\` level after unzipping). |
| "no Piper voices" | Put both the `.onnx` and `.onnx.json` in `piper\voices\`. A download sometimes saves the json as `.json.txt`; rename it. |
| "Piper exited with code 3221225781" (or -1073741515) | A DLL is missing. Copy the whole unzipped folder, not only `piper.exe`. If that doesn't fix it, install the Microsoft Visual C++ Redistributable (x64). |
| "Piper was blocked from starting" or no sound and the antivirus flags it | Windows Defender or SmartScreen can quarantine `piper.exe`. Restore it and add the `piper` folder as an exclusion. If Windows blocked the zip, right-click it, choose Properties > **Unblock**, then unzip again. |
| "needs the newer Piper 1.5+", or "crashed (code 0xC0000409)" / code 3221226505 | The voice was made for Piper 1.5+. Install it as described in "Voices that need Piper 1.5+", or use an older voice such as `en_GB-alan-medium`. |
| "Piper failed: … Load model … failed" | The `.onnx` download is incomplete (an HTML page or a few KB). Download it again. |
| "audio not enabled yet, click the page once" | Browsers only allow sound after a click. Click anywhere. The desktop app doesn't need this. |

After a Piper error the dashboard uses browser speech for 30 seconds, then tries Piper again.

---

## Desktop app (Electron)

### Install, run, build (Windows, Command Prompt)

Install Node.js LTS from https://nodejs.org first. Then:

```bat
cd C:\Users\roland.regacho\Pictures\f1telemetry
npm install
npm start
npm run start:demo
npm run dist
```

- `npm install` installs Electron and electron-builder into `node_modules\`. Run it once.
- `npm start` runs the desktop app with live data from the game; `npm run start:demo` runs it with fake data.
- `npm run dist` builds `dist\F1-Telemetry-Setup-1.0.0.exe` (installer) and `dist\F1-Telemetry-1.0.0-portable.exe`.

`node server.js` still works on its own exactly as before. It writes next to itself and listens on 3000/20777.

### What the app does

- Starts `server.js` in a separate process (Electron `utilityProcess`), waits until it reports that its ports are open, then opens the window. On quit it asks the server to close and stops it after 1.5 s if needed. If the server crashes, you can restart it from a dialog.
- **Data folder**: `Documents\F1Telemetry` (laps.csv, traces, TTS cache, `server.log`). The app passes it to the server via `F1T_DATA_DIR`. Use File > Open data folder. To use another folder, set `"dataDir"` in the settings file. To keep your existing laps, copy `laps.csv` and `traces\` into the data folder.
- **Settings file**: `%APPDATA%\F1 Telemetry\settings.json` (File > Open settings file). It holds `httpPort`, `udpPort`, `dataDir`, window position, and the always-on-top and overlay state. Command-line `--http-port` / `--udp-port` override it.
- **Window**: remembers its size, position and maximised state. F11 fullscreen (Esc leaves it), **Ctrl+Shift+T** always on top, **Ctrl+Shift+O** overlay mode. Overlay mode is borderless and on top; drag it by the header bar. Reload with Ctrl+R; Developer tools with Ctrl+Shift+I.
- **Audio** starts without a click (autoplay policy is relaxed in the app), so if the radio was on last time, the engineer is ready immediately.
- **Ports**: if HTTP port 3000 is taken, a dialog offers the next free port and saves it. If UDP 20777 is taken (SimHub, Crew Chief, another copy…), a dialog explains it and offers Try again or another UDP port. If you use another UDP port, set the same port in the game.
- **First run**: a dialog shows the game's telemetry settings and the Windows Firewall note. You can see it again under Help.

### Piper in the packaged app

`npm run dist` copies the project's `piper\` folder into the app as `resources\piper\` (electron-builder `extraResources`). Files inside the app archive (`app.asar`) can't be executed, so Piper has to live outside it. At run time the app tells the server where Piper is via `F1T_PIPER_DIR`:

- development (`npm start`): `<project>\piper`
- installed or portable: `<install folder>\resources\piper`

The server also looks in `Documents\F1Telemetry\piper\` for `piper.exe` and in `Documents\F1Telemetry\piper\voices\` for voices. That way you can add voices without rebuilding. If `piper\` only contains the README files, the app falls back to browser speech. The installer gets about 90 MB larger per medium voice you bundle.

### Icon

`build\icon.png` (512×512) is a placeholder. Replace it with your own 512×512 PNG (at least 256×256) before `npm run dist`; electron-builder converts it to `.ico`.

### Troubleshooting the app

| Symptom | Fix |
|---|---|
| Blank or black window | The server didn't start. Check File > Open server log and look for a port message. Ctrl+R reloads. If it persists, run `npm run web:demo` to see whether the server works on its own. |
| No data arriving | The game needs UDP Format 2025, IP 127.0.0.1 and the same port as the app (Help > About shows it). Allow the app in Windows Firewall (Control Panel > Windows Defender Firewall > Allow an app; for `npm start` the program is `node_modules\electron\dist\electron.exe`). Close other telemetry tools or forward to a second port. |
| "Port in use" dialog at every start | Another copy is still running (check the tray and Task Manager for "F1 Telemetry" or `node.exe`), or another program owns the port. Pick the offered port. |
| SmartScreen "Windows protected your PC" | The exe isn't code-signed. Click **More info > Run anyway**. Antivirus tools sometimes flag unsigned Electron builds or `piper.exe`; add an exclusion for the install folder. |
| No sound | Check the volume slider and that the radio is on. Open the FX panel to see the engine status. Windows volume mixer: "F1 Telemetry". |
| `npm run dist` fails downloading | It downloads Electron and NSIS on the first build. Check your proxy or firewall and try again. |
