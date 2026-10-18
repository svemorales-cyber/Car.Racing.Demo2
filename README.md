# KOD Racing 3D

A 3D arcade street racer that runs in the browser (Three.js). There's no build step: open `index.html` or host it on GitHub Pages.

`KOD_Racing_3D.zip` holds the same game as a single file (`KOD_Racing_3D.html`).

## Features
- **Track**: a smooth 1.3 km circuit with curbs, ad-board walls, a start gantry with countdown lights, a grandstand, street lamps, a city skyline, trees and mountains.
- **Drifting**: hold Space while cornering to slide. The car leaves skid marks and tyre smoke, you get drift points, and the nitro bar fills.
- **Nitro**: press Shift to boost. You get blue flames, speed lines and a wider field of view. Driving over the blue boost pads refills nitro and gives a burst of speed.
- **Super start**: press gas just before "GO!" for a launch boost.
- **Smarter bots**: they follow a racing line, brake for corners, overtake, use nitro on straights and bump into you.
- **Options**: 1/3/5 laps, 3 difficulties, and day/sunset/night. At night the lamps light the road, building windows glow and your car has a working headlight.
- **HUD**: minimap, lap timer, best lap, position, gear, a wrong-way warning, a results table at the end, and records saved in your browser.
- **Sound**: engine sound that changes pitch with gear and speed, plus tyre squeal, crashes and countdown beeps. All sound is generated in the browser, so there are no sound files.
- **Touch controls** on phones.
- **Rain**: a wet, reflective road with puddles, falling rain, drops on the screen, spray behind the cars, and lightning with thunder. The car has less grip and longer braking (handled in the C++ physics), and the bots drive more carefully.
- **Finish replay**: after the finish line you see the last seconds again with cinematic camera angles (trackside, low, orbit, helicopter) and slow motion at the finish line. Press Enter or click to skip.
- **Damage**: hits against walls and other cars dent the bodywork and fill the damage bar. A damaged car smokes, catches fire when badly hurt, loses top speed and pulls to one side (C++ physics).
- **Music**: a synthwave track generated live in the browser that gets more intense on the last lap. You can turn it off in the menu.
- **Controls written in C++** and compiled to WebAssembly (see below).

## Controls
| Key | Action |
|---|---|
| W / ↑ | Gas |
| S / ↓ | Brake / reverse |
| A D / ← → | Steer |
| Space | Drift (handbrake) |
| Shift | Nitro |
| C | Change camera (chase / far / hood) |
| R | Put the car back on the track |
| M | Mute |
| Esc / P | Pause |

## Files
| File | Contents |
|---|---|
| `index.html` | Page layout: HUD, menu, pause screen, touch buttons |
| `css/style.css` | All styles |
| `controls/controls.cpp` | **C++ controls:** key bindings, keyboard/touch input state, and the car's driving physics (gas, brake, steering, drift, nitro, rain grip, damage) |
| `controls/controls.wasm` | `controls.cpp` compiled to WebAssembly; this is what the browser runs |
| `controls/build.sh` | Rebuilds `controls.wasm` from `controls.cpp` |
| `js/game.js` | Everything else: track, graphics, bots, sound, camera. It loads `controls.wasm` and calls it every frame |

## Changing the controls (C++)
1. Edit `controls/controls.cpp`. For example, change the `ACTION_KEYS` table to rebind keys, or change `TOP_SPEED` / `GRIP` to change how the car drives.
2. Rebuild: `./controls/build.sh`. You need `clang` and `wasm-ld`: on Ubuntu run `sudo apt install clang lld`, on macOS run `brew install llvm`, on Windows install LLVM from llvm.org.
3. Upload the new `controls.wasm` together with `controls.cpp`.

Keys are matched by their physical position (`KeyboardEvent.code`), so the controls also work with a Bulgarian (Cyrillic) keyboard layout.

## Running it
The browser only loads `controls.wasm` and `js/game.js` from a web server, so the game will not start if you just double-click `index.html`.
- **GitHub Pages:** upload all files, then go to Settings → Pages → Deploy from branch → `main` / root. The game will be at `https://<your-username>.github.io/<repo-name>/`.
- **On your computer:** start a small local server in this folder, for example `npx http-server` or `python -m http.server`, then open the address it prints.
