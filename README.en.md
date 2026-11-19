# Byte Bistro

[Português](README.md) · **English**

![A match in the wedding level](docs/images/jogando-casamento.jpg)

> 🚧 **Work in progress.** Features, levels and visuals are still changing.

### ▶️ [Play online: byte-bistro.pages.dev](https://byte-bistro.pages.dev)

Runs straight in the browser, nothing to install. Best on a computer with a keyboard, in an up-to-date Chrome or Edge.

---

## About

Byte Bistro is a cooperative 3D cooking game for **two players on the same screen**, in the style of *Overcooked*. The two cooks share one kitchen to prepare and serve the dishes that are ordered before time runs out: fetch ingredients, chop, cook, plate up and deliver.

The main level is a wedding reception whose guests are robots placing the orders. The game also has a **build mode**, inspired by *The Sims 4*, where anyone can build their own kitchen and surroundings and then play in them.

## Academic goal

The project was developed for the **Software Design and Architecture** course. The focus is not only the finished game but the **process of designing and evolving software**:

- turning a **concept** (a cooperative cooking game in the browser) into an architecture;
- building it **incrementally, part by part**: first the core game loop, then the full kitchen, the characters, the map editor, the 3D model pipeline and the scenery;
- splitting responsibilities into layers (core, scenes, game rules, systems, editor and interface), keeping the rules in code that does not depend on the graphics;
- treating content as **data**: levels and maps are JSON files, and each model pack describes itself in a `pack.json`, so new levels need no code changes.

## Set in São Bento do Sul

The game is set in **São Bento do Sul, Santa Catarina, Brazil**, as a way to showcase the city:

- the level picker is a miniature of the town, with the **Igreja Matriz** (main church), the square's bandstand and araucaria pines;
- the build-mode object packs were modelled from local references: the **Praça** (town square), the **Igreja Matriz** and the **Schlachtfest** festival, with half-timbered houses, stalls and bunting.

![Level picker featuring São Bento do Sul](docs/images/menu.jpg)

## How to play

1. In the menu, pick a level on the map, then the two cooks. The **PT | EN** button at the top of the menu (and on the pause screen) switches the whole game's language at once: Player 1 switches with `A`/`D` and Player 2 with the arrow keys.

   ![Choosing the cooks](docs/images/selecao-personagens.jpg)

2. Orders appear at the top of the screen, each showing the dish, its ingredients and the time left.
3. Take ingredients from the crates, **chop** them on the cutting board, **cook** them on the stove (pan or pot), **plate** them and **deliver** at the serving counter.
4. Dirty plates come back and must be **washed** at the sink. If something burns and catches fire, grab the **extinguisher**.
5. You can **throw** ingredients to your partner and work as a team. Fast, well-made dishes score more; expired orders cost points.

| Action | Player 1 | Player 2 |
| --- | --- | --- |
| Move | `W A S D` | Arrow keys |
| Run | Left `Shift` | `Numpad 0` |
| Dash (shoulders aside whoever is in the way) | `Space` | `Numpad .` |
| Call your partner | `Q` | `Numpad 1` |
| Pick up, drop, combine, deliver | `E` | `Enter` |
| Hold: chop, wash, extinguish · With an ingredient: aim, release to throw | `F` | Right `Shift` |
| Recipe book | `Tab` | — |
| Pause | `Esc` | — |

From **1 to 4 people play, each with their own phone as the controller**, no install needed: the game opens on a QR code (or a code to type at `byte-bistro.pages.dev/controller`). The first phone in is **P1**, who drives the menus with the arrows (**A** confirms, **B** goes back) and presses A to go on once everyone has joined. On the cook selection each player picks theirs on their own phone; in a match the phone becomes an analog stick plus **A** (grab), **X** (use), **B** (dash), **Y** (call), with Recipes and Pause in the middle. Gamepads still work in a match (the first drives Player 1, and so on). “Players” on the menu goes back to the QR code for someone to join or leave.

## Build mode

In the menu, **Create map** opens the editor, inspired by *The Sims 4*'s build mode. A finished map can be played right away.

![Build mode overview](docs/images/construcao-visao-geral.jpg)

- A **catalogue** of more than 1,600 objects, grouped in tabs and packs, with search.
- **Draw walls and floors** by clicking and dragging.
- **Walls up, cutaway or down**, to see inside while building.
- Camera and controls as in *The Sims 4*: the right button rotates and tilts, dragging the ground (left or wheel button) moves the view, the wheel zooms towards the cursor and the mouse at the screen edge slides the camera. `W A S D` move, `Q`/`E` rotate, `,`/`.` rotate the object and `9`/`0` raise and lower it.
- **Free placement**: any object goes anywhere, off the lot too (it becomes scenery) and on top of other objects, like a lamp on a table.
- **Top-down view** and grid.

![Walls and floors drawn by dragging](docs/images/construcao-paredes-e-pisos.jpg)

- **Recolour each part of an object** without going back to Blender. Colours are saved with the map.

![Colour tool](docs/images/construcao-cores.jpg)

![Top-down view](docs/images/construcao-vista-de-cima.jpg)

- Eyedropper, sledgehammer, copy and paste, undo and redo, and maps saved in the browser or exported as JSON.

![Playing the map built in the editor](docs/images/jogando-mapa-criado.jpg)

## Technologies

| Technology | Used for |
| --- | --- |
| **TypeScript** | All of the game and editor code |
| **Babylon.js** | 3D engine in the browser (WebGL): scenes, cameras, lights, collision and animation |
| **Vite** | Development server and production bundling |
| **HTML and CSS** | Menus, game interface and editor |
| **Blender** | 3D modelling of the original packs (Casamento, Schlachtfest, Praça, Igreja Matriz), the São Bento do Sul map and the scenery around the levels |
| **glTF / GLB** | 3D model format loaded by the game |
| **Cloudflare Pages** | Hosting of the online version |

Free models (CC0) from the **KayKit** packs by Kay Lousberg and from **Kenney** were also used.

## Running locally

For evaluating the project:

```bash
npm install
npm run dev
```

Then open `http://127.0.0.1:5173`. To build the production version: `npm run build`.

## Status

Work in progress. Planned: new levels and recipes, storeys in build mode, sound, and balancing.

## Copyright

© 2026 Plusnar. **All rights reserved.** The code and original files in this repository are public for viewing and academic evaluation only. Copying, modifying, redistributing or reusing any part without the owner's written permission is prohibited. See [LICENSE](LICENSE).
