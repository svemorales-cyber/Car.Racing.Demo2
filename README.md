# KOD Racing - T 

A 3D arcade street racer that runs in the browser (Three.js). There's no build step: open `index.html` or host it on GitHub Pages.

## Main menu
The game opens in the workshop with your car on the turntable, like the menus of console racing games. Everything is in one place: **Race** (a quick race against bots), **Multiplayer**, **Garage** (cars, paint, tuning), **Settings** and **Controls**. After a race the results show up in the same menu.

## Playing with friends (multiplayer)
1. Open **Multiplayer**, type your name and press **CREATE ROOM**. You get a 5-letter room code.
2. Send the code to your friends, or press **Copy invite link** and send them the link (it opens the game with the code filled in).
3. They open the game, go to **Multiplayer**, enter the code and press **JOIN**. Up to 4 players fit in a room.
4. The host picks laps, difficulty, time of day, weather and whether bots fill the empty grid slots, then presses **START RACE**. Everyone starts together, sees the others' cars with their names above them, and gets the same results table at the end.

How it works: the players' browsers connect directly to each other (WebRTC, using the PeerJS library). The free PeerJS server is only used to find the room. The host's browser runs the bots and passes the positions on, so **the host has to keep the game open** for the whole race. Nothing has to be installed or hosted: it works from GitHub Pages. On a few strict networks (some school, office or mobile networks) a direct connection isn't possible; then try another network. If the free PeerJS server is ever down you can run your own (`npx peerjs --port 9000`) and open the game with `?peer=your-server:9000` added to the address.

## Features
- **Track**: a smooth 1.3 km circuit with curbs, ad-board walls, a start gantry with countdown lights, a grandstand full of 3D spectators (some stand up and cheer), street lamps, a city skyline, trees and mountains.
- **Tyre physics** (C++): each axle has a slip angle and a tyre curve that peaks and then falls off, so grip builds up, reaches a limit and then lets go. Steering, braking and throttle share the same grip (friction circle), and weight moves to the rear when you accelerate and to the front when you brake. Turn in too fast and the front washes wide (understeer); too much power or lifting mid-corner swings the rear out (oversteer). Each car has its own weight balance and drivetrain: front-engined cars push wide, the rear-engined RENNER rotates, and the all-wheel-drive KAZE R34, RENNER and TORO put their power down cleanly where the rear-drive cars can slide. In the rain the tyres have less grip, let go earlier and slide more once they have. The little tyre icon next to the damage bar shows how much grip each axle is using: green has grip left, yellow is at the limit and red is sliding. Light stability control and anti-lock brakes stop the car from spinning on every mistake.
- **Drifting**: pull the handbrake (Space) or give it too much gas in a rear-drive car and the tail steps out. Stay on the gas to keep the slide going. Steer into the corner for more angle, counter-steer to straighten up, or let go of the steering and the car catches the slide by itself. You get skid marks, tyre smoke and drift points, and the nitro bar fills.
- **Nitro**: press Shift to boost. You get blue flames, speed lines and a wider field of view. Driving over the blue boost pads refills nitro and gives a burst of speed.
- **Super start**: press gas just before "GO!" for a launch boost.
- **Smarter bots**: they follow a racing line, brake for corners, overtake, use nitro on straights and bump into you.
- **Options**: 1/3/5 laps, 3 difficulties, and day/sunset/night. At night the lamps light the road, building windows glow and your car has a working headlight.
- **Speedometer**: an analog km/h dial like in Need for Speed or Assetto Corsa. It has a needle, a rev ring that lights up blue → yellow → red with a flashing shift light, a digital speed readout, the current gear and a nitro gauge. The dial's scale follows your car's top speed, so upgraded cars get a bigger scale.
- **HUD**: minimap, lap timer, best lap, position, a damage bar, a wrong-way warning, a results table at the end, and records saved in your browser.
- **Realistic graphics**: filmic tone mapping, and the sky lights and reflects off everything. The sky has a scattering-style gradient, a sun halo and puffy cumulus clouds lit from the sun side (dark undersides, bright silver edges) with thin cirrus above. Distant things fade into an aerial-perspective haze that thins with altitude and turns warm when you look towards the sun. The asphalt has stone grain, sealed cracks, resurfaced sections, polished tyre lines and worn paint. The grass verges are mown in light and dark stripes, and further out they turn into a rough meadow with straw-coloured patches, tufts and wildflowers. Trees grow in groves and come in four kinds (oak, birch, poplar and pine) with leaf, needle and bark textures that stay full at any distance. Buildings come in glass, brick, concrete and ribbon-window office styles with several colour variants, blinds and curtains in the windows, weathering streaks, shop fronts, roof units and randomly lit windows at night. The mountains have forest cover, rock bands and snow caps. Cars have glossy clear-coat paint, reflective glass, tyres with tread and sidewall lettering, mirrors, a grille, number plates, exhaust tips and door lines. All textures are generated in code, so there are no image files.
- **Sound**: engine sound that changes pitch with gear and speed, plus tyre squeal, crashes and countdown beeps. All sound is generated in the browser, so there are no sound files.
- **Touch controls** on phones.
- **Rain**: a wet, reflective road with puddles, falling rain, drops on the screen, spray behind the cars, and lightning with thunder. The car has less grip and longer braking (handled in the C++ physics), and the bots drive more carefully.
- **Finish replay**: after the finish line you see the last seconds again with cinematic camera angles (trackside, low, orbit, helicopter) and slow motion at the finish line. Press Enter or click to skip.
- **Damage**: hits against walls and other cars dent the bodywork where they hit (lights, mirrors, grille and wing move with the panel they are on) and fill the damage bar. Wall collisions use the car's real outline, so a car that hits the barrier sideways or backwards can't poke through it, and the camera stays on the track side of the fence. A damaged car smokes, catches fire when badly hurt, loses top speed and pulls to one side (C++ physics).
- **Cars**: seven models with curved bodies built in code, each inspired by a real car (the names are made up): VELOCE GT4 (mid-engine coupe), KAZE R34 (Japanese turbo coupe), RYU S15 (drift coupe), STALLION GT (V8 fastback in the style of a Mustang), RENNER TURBO S (rear-engine coupe in the style of a 911 Turbo S), TORO V10 (wedge supercar in the style of a Huracán) and APEX HYPER (hypercar). Each has its own lights, intakes, exhausts, an interior seen through the glass, and detailed wheels.
- **Garage**: a workshop (block walls, roller doors, tool cabinets, tyre racks, a car lift) whose reflections show up in the paint. It has with a category menu (Car, Paint, Wheels, Aero, Performance, Setup), a car carousel, performance class badges and live stats (top speed, 0-100 km/h, horsepower, handling, braking, nitro). Hovering an upgrade shows its gain in green. You can choose the paint colour, finish (gloss, metallic or matte), rims, caliper colour and rear wing.
- **Tuning**: seven upgrade categories (engine, turbo, nitro, tyres, brakes, suspension, weight reduction) with 5 stages each, bought with the credits you win in races. There are also two setup sliders: gearing (acceleration ↔ top speed) and balance (grip ↔ drift). Fully upgraded, a car gains about 30% top speed and more than twice the acceleration. All of this is computed in the C++ physics.
- **Settings** (from the main menu or the pause screen): graphics quality, sound on/off, music on/off, volume and camera. **Graphics High / Low**: High adds ambient occlusion (soft contact shadows where things touch), bloom, a colour grade with vignette, bigger and sharper sun shadows, live reflections of the surroundings on your car, and about 38,000 grass tufts. Low turns these off for weaker computers and phones; phones start on Low.
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
| `controls/controls.cpp` | **C++ controls:** key bindings, keyboard/touch input state, and the car's driving physics (tyre model, weight transfer, understeer/oversteer, drift, nitro, rain grip, damage), plus the stats of every car and the effect of upgrades and spoilers |
| `controls/controls.wasm` | `controls.cpp` compiled to WebAssembly; this is what the browser runs |
| `controls/build.sh` | Rebuilds `controls.wasm` from `controls.cpp` |
| `js/game.js` | Everything else: track, graphics, bots, sound, camera. It loads `controls.wasm` and calls it every frame |

## Changing the controls (C++)
1. Edit `controls/controls.cpp`. For example, change the `kActionKeys` table to rebind keys, or change a car's numbers in the `kModels` table (top speed, acceleration, grip...) to change how it drives.
2. Rebuild: `sh controls/build.sh`. You need `clang` and `wasm-ld`: on Ubuntu run `sudo apt install clang lld`, on macOS run `brew install llvm`, on Windows install LLVM from llvm.org.
3. Upload the new `controls.wasm` together with `controls.cpp`.

Keys are matched by their physical position (`KeyboardEvent.code`), so the controls also work with a Bulgarian (Cyrillic) keyboard layout.

## Running it
The browser only loads `controls.wasm` and `js/game.js` from a web server, so the game will not start if you just double-click `index.html`.
- **GitHub Pages:** upload all files, then go to Settings → Pages → Deploy from branch → `main` / root. The game will be at `https://<your-username>.github.io/<repo-name>/`.
- **On your computer:** start a small local server in this folder, for example `npx http-server` or `python -m http.server`, then open the address it prints.
