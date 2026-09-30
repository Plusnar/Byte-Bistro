import type { Transformation } from "../types/game";

export const TRANSFORMATIONS: readonly Transformation[] = [
  {
    id: "crush_ram_module",
    stationId: "bit_crusher",
    inputs: ["ram_module"],
    output: "ram_powder",
    duration: 3,
  },
  {
    id: "mix_ram_dough",
    stationId: "data_mixer",
    inputs: ["ram_powder", "ram_powder", "binary_sugar"],
    output: "ram_dough",
    duration: 5,
  },
  {
    id: "compile_ram_cake_base",
    stationId: "compiler_oven",
    inputs: ["ram_dough"],
    output: "ram_cake_base",
    duration: 10,
    idealDuration: 7.5,
  },
  {
    id: "plate_ram_cake",
    stationId: "plating_station",
    inputs: ["ram_cake_base", "cache_cream"],
    output: "ram_cake",
    duration: 2,
  },
  {
    id: "mix_cookie_dough",
    stationId: "data_mixer",
    inputs: ["cache_fragment", "binary_sugar"],
    output: "cookie_dough",
    duration: 4,
  },
  {
    id: "compile_cache_cookies",
    stationId: "compiler_oven",
    inputs: ["cookie_dough"],
    output: "cache_cookies",
    duration: 9,
    idealDuration: 6.8,
  },
  {
    id: "mix_gelato",
    stationId: "data_mixer",
    inputs: ["cooling_fluid", "data_cream"],
    output: "gelato_mix",
    duration: 4,
  },
  {
    id: "freeze_cooling_gelato",
    stationId: "cache_freezer",
    inputs: ["gelato_mix"],
    output: "cooling_gelato",
    duration: 7,
    idealDuration: 6,
  },
];
