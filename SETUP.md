# F1 Telemetry: install and run (Windows)

Step-by-step instructions for setting up the dashboard on a Windows PC, from a clean machine to a running app. Commands are for **Command Prompt** (`cmd`). Press Win+R, type `cmd` and press Enter.

The project folder used below is:

```
C:\Users\roland.regacho\Pictures\f1telemetry
```

If your copy is somewhere else, use that path instead.

---

## 0. What you need

| Requirement | Needed for | Required? |
|---|---|---|
| **Node.js** (LTS version) | Running the dashboard server, and the desktop app | Yes |
| **F1 25** with UDP telemetry on | Live data (demo mode works without the game) | For live use |
| **Piper** engine + a voice | Natural engineer voice (otherwise the browser voice is used) | Optional |
| **Python 3.9+** | Only for voices made for Piper 1.5+ (e.g. `en_US-mike-medium`) | Optional |
| Internet | First-time installs; Google Fonts (falls back to system fonts offline) | First time |

The steps:

1. Install Node.js (once)
2. Set up the game's telemetry (once)
3. Run the dashboard in the browser, **or**
4. Run it as the desktop app
5. Set up the engineer voice (optional)
6. Build the Windows installer (optional)

---

## 1. Install Node.js

1. Go to https://nodejs.org and download the **LTS** Windows installer (`.msi`).
2. Run it and keep the default options.
3. Open a **new** Command Prompt and check:

   ```bat
   node -v
   npm -v
   ```

   Both should print a version number. If you get "not recognized", sign out and back in (or restart), then try again.

You can also install it with `winget install OpenJS.NodeJS.LTS`.

---

## 2. Set up F1 25 telemetry

In F1 25 go to **Settings > Telemetry Settings** and set:

| Setting | Value |
|---|---|
| UDP Telemetry | **On** |
| UDP Broadcast Mode | **Off** |
| UDP IP Address | **127.0.0.1** |
| UDP Port | **20777** |
| UDP Send Rate | **30 Hz** or **60 Hz** |
| UDP Format | **2025** |

The first time the dashboard runs, **Windows Firewall** may ask whether Node.js (or "F1 Telemetry") may communicate on networks. Click **Allow** for Private networks. If you clicked Cancel by mistake, see Troubleshooting.

---

## 3. Run the dashboard in your browser

The browser version needs nothing installed besides Node.js (no `npm install`).

```bat
cd C:\Users\roland.regacho\Pictures\f1telemetry
node server.js
```

You should see:

```
Dashboard: http://localhost:3000  (listening for game on UDP 20777)
Engineer voice: ...
```

Open **http://localhost:3000** in Chrome or Edge, then start a session in the game. The Link indicator in the top bar turns **LIVE** when data arrives.

- **Stop** the server with **Ctrl+C** in the Command Prompt window.
- **Test without the game**: `node server.js --demo` uses fake data on a made-up circuit, with rivals and pit stops.
- **Shortcut scripts** (same thing): `npm run web` and `npm run web:demo`.

Options (rarely needed):

```bat
node server.js --http-port 3001 --udp-port 20778 --data-dir D:\F1Data
```

| Option | Default | What it does |
|---|---|---|
| `--http-port` | 3000 | Web port of the dashboard page |
| `--udp-port` | 20777 | Port the game sends telemetry to (must match the game setting) |
| `--data-dir` | project folder | Where `laps.csv`, `traces\` and `tts-cache\` are saved |
| `--piper-dir` | `piper\` in the project | Where the Piper voice engine is |

**Saved data** (in the project folder): `laps.csv` (every completed lap) and `traces\` (per-lap telemetry for the Lap analysis panel). Demo mode writes `laps-demo.csv` and `traces-demo\` instead.

---

## 4. Run it as the desktop app (Electron)

The desktop app is the same dashboard in its own window, with always-on-top, overlay mode and fullscreen.

### 4.1 Install the app's requirements (once)

```bat
cd C:\Users\roland.regacho\Pictures\f1telemetry
npm install
```

This downloads Electron and electron-builder into `node_modules\`, about 300 MB, which takes a few minutes. You only need to run it again if `package.json` changes or you delete `node_modules\`.

### 4.2 Start the app

```bat
npm start
```

For fake data, run `npm run start:demo`.

On the first start a setup dialog repeats the game settings from section 2. Click OK.

### 4.3 Using the app

| Action | How |
|---|---|
| Fullscreen | **F11** (Esc to leave) |
| Always on top | **Ctrl+Shift+T** or View > Always on top |
| Overlay mode (borderless, on top) | **Ctrl+Shift+O**. Drag the window by its top bar. |
| Reload the page | **Ctrl+R** |
| Developer tools | **Ctrl+Shift+I** |
| Open saved laps | File > Open data folder (**Ctrl+Shift+D**) |
| Change ports / data folder | File > Open settings file, edit, restart the app |
| See server messages | File > Open server log |
| Setup help again | Help > Game and firewall setup |

**Where the app keeps things:**

- Laps, traces, TTS cache, `server.log`: `Documents\F1Telemetry\`
- Settings (ports, window position…): `%APPDATA%\F1 Telemetry\settings.json`

The app doesn't use the `laps.csv` and `traces\` in the project folder. To keep your history, copy them into `Documents\F1Telemetry\` once, with the app closed.

If port 3000 or 20777 is already taken (another telemetry program, or `node server.js` still running), the app shows a dialog and offers a free port. If you accept another **UDP** port, set the same port in the game.

Only run one at a time: either `node server.js` **or** the app. Both want the same ports.

---

## 5. Engineer voice (optional)

Switch the radio on with **Radio off/on** in the top bar. Choose a voice in the dropdown next to it. Use **FX** for the radio-effect strength, speaking speed and a test button.

Without Piper, the engineer uses the browser or Windows voices. They work, but sound robotic and get no radio effect. Piper gives a natural neural voice.

### 5.1 The Piper engine

**Current state of your folder:** `piper\piper.exe` (the 2023 Windows release) is already installed, with English pronunciation data.

To install it on another PC:

1. Download `piper_windows_amd64.zip` from https://github.com/rhasspy/piper/releases/tag/2023.11.14-2.
2. Right-click the zip, choose **Properties**, tick **Unblock** if it's shown, and click OK.
3. Extract it, and copy **everything inside** its `piper` folder (piper.exe, the `.dll` files, `espeak-ng-data`) into the project's `piper\` folder. The result must be `f1telemetry\piper\piper.exe`, not `piper\piper\piper.exe`.

### 5.2 Voices

Voices live at https://huggingface.co/rhasspy/piper-voices; samples are at https://rhasspy.github.io/piper-samples/.

1. Browse to a voice, for example `en/en_GB/alan/medium/`.
2. Download **both** files: `en_GB-alan-medium.onnx` and `en_GB-alan-medium.onnx.json`. Keep their names unchanged.
3. Put them in `f1telemetry\piper\voices\`.
4. Reload the dashboard (or click **FX**). The voice appears under "Local neural (Piper)".

**Current state:** `piper\voices\en_US-mike-medium` is installed. It's a newer voice, so it needs step 5.3.

**Which engine does a voice need?** Open its `.onnx.json` in Notepad and look for `"piper_version"`:

- `1.0.0` (most voices, including `en_GB-alan-medium` and `en_GB-northern_english_male-medium`): works with `piper.exe`.
- `1.5.0` or higher (for example `en_US-mike-medium`): needs Piper 1.5+ (step 5.3).

### 5.3 Piper 1.5+ (needed for the mike voice)

The newer Piper is a Python package. It plays both old and new voices. Install it once:

**a) Install Python** (skip if `py --version` already prints 3.9 or newer):

```bat
winget install Python.Python.3.12
```

Or download it from https://www.python.org/downloads/ and tick **"Add python.exe to PATH"** in the installer. Then open a **new** Command Prompt.

**b) Install Piper into the project's `piper\py` folder:**

```bat
cd C:\Users\roland.regacho\Pictures\f1telemetry
py -m venv piper\py
piper\py\Scripts\python -m pip install piper-tts
```

**c) Test it:**

```bat
echo Box this lap, box this lap. | piper\py\Scripts\piper.exe -m piper\voices\en_US-mike-medium.onnx -f test.wav
start test.wav
```

If you hear the sentence, Piper works.

**d) Use it:** restart the server (Ctrl+C, then `node server.js`) or the app, reload the page, and choose **Mike (en-US)**. When it's in use, the FX panel says "Speaking with Piper".

When `piper\py\Scripts\piper.exe` exists, the server uses it automatically instead of `piper\piper.exe`.

### 5.4 Test the old engine from the command line (optional)

```bat
cd C:\Users\roland.regacho\Pictures\f1telemetry\piper
echo Box this lap. | piper.exe --model voices\en_GB-alan-medium.onnx --output_file test.wav
start test.wav
```

### 5.5 Tuning

- **FX panel**: Radio effect (0 = clean voice, 1 = heavy team radio) and Speaking speed (0.7× to 1.4×).
- **Deeper settings**: the `CONFIG` block at the top of `server.js`:
  - `noiseScale` (default 0.667): lower is steadier, higher is more expressive.
  - `noiseW` (default 0.8): rhythm variation.
  - `cacheMB` (default 200): size of the speech cache.

  Restart the server after editing.
- Generated sentences are cached in `tts-cache\`. Deleting that folder is safe; it fills up again.

---

## 6. Build the Windows installer (optional)

Requires step 4.1 (`npm install`). Put the Piper engine and the voices you want bundled in `piper\` first: everything in `piper\` is copied into the app.

```bat
cd C:\Users\roland.regacho\Pictures\f1telemetry
npm run dist
```

Output in `dist\`:

- `F1-Telemetry-Setup-1.0.0.exe`: installer. It asks for an install folder and creates a desktop shortcut.
- `F1-Telemetry-1.0.0-portable.exe`: runs without installing.

The first build downloads extra tools, so it needs internet and takes a few minutes. `npm run dist:dir` builds an unpacked folder (`dist\win-unpacked\`) for quick testing.

The exe isn't code-signed, so Windows SmartScreen shows "Windows protected your PC". Click **More info > Run anyway**.

If you bundle `piper\py` (Piper 1.5+), it uses the Python installed on this PC. On another PC, install Python there and create `Documents\F1Telemetry\piper\py` with the commands from 5.3, but with that folder in the paths.

Replace `build\icon.png` (512×512 PNG) with your own icon before building, if you like.

---

## 7. Troubleshooting

| Problem | What to do |
|---|---|
| `'node' is not recognized` | Install Node.js (section 1), then open a **new** Command Prompt. |
| `HTTP port 3000 is already in use` | Another copy is running (close it), or start with `node server.js --http-port 3001` and open http://localhost:3001. |
| `UDP port 20777 is already in use` | Another telemetry program (SimHub, Crew Chief…) or a second copy is running. Close it, or use `--udp-port 20778` and set the same port in the game. |
| Dashboard says Waiting / NO DATA with the game running | Check the game settings (section 2), especially **UDP Format 2025** and IP **127.0.0.1**. Allow Node.js / F1 Telemetry in Windows Firewall: Control Panel > Windows Defender Firewall > *Allow an app through firewall* > tick **Private** for "Node.js JavaScript Runtime" (or "F1 Telemetry"; for `npm start` it's `node_modules\electron\dist\electron.exe`). |
| Message about "UDP format" | The game is sending an older format. Set UDP Format to 2025. |
| Desktop app shows a blank window | File > Open server log. Usually a port message. Ctrl+R to reload. |
| `npm install` fails | Check the internet connection or proxy, then run it again. Deleting `node_modules\` first gives a clean retry. |
| Engineer silent | Radio must be **on**, the volume slider up, and you must click the page once (browser only). The engineer only talks on straights or when stopped, except for urgent calls. |
| Caption: "Piper not found" | `piper.exe` must be directly in `f1telemetry\piper\` (section 5.1). |
| Caption: "needs the newer Piper 1.5+" or crash code 3221226505 | The voice needs Piper 1.5+ (section 5.3), or pick a `1.0.0` voice. |
| Caption: "exited with code 3221225781" | A Piper DLL is missing. Re-copy the full Piper folder, or install the Microsoft Visual C++ Redistributable (x64). |
| Caption: "Piper was blocked from starting" | The antivirus quarantined `piper.exe`. Restore it and add the `piper` folder as an exclusion. |
| `py` not recognized | Install Python (5.3a) with "Add to PATH", then open a new Command Prompt. |
| `pip install piper-tts` fails | Check the internet connection. Make sure Python is 64-bit and 3.9 or newer (`py --version`). |
| SmartScreen warning on the built exe | It's unsigned. Click More info > Run anyway. |

More detail on how things work: `README.md`.

---

## Quick reference

```bat
cd C:\Users\roland.regacho\Pictures\f1telemetry
node server.js
node server.js --demo
npm install
npm start
npm run start:demo
npm run dist
```

- `node server.js`: browser version, live (then open http://localhost:3000). `node server.js --demo` uses fake data.
- `npm install`: one-time setup for the desktop app.
- `npm start`: desktop app, live. `npm run start:demo` uses fake data.
- `npm run dist`: builds the installer and portable exe.
