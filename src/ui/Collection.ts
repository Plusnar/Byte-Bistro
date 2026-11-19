import { FOOD_DEFINITIONS, STATION_KIND_LABEL } from "../data/kitchen";
import { getIngredient } from "../data/ingredients";
import { SCENARIOS } from "../data/scenarios";
import { ingredientIllustration } from "./illustrations";
import { publicUrl } from "../utils/assetUrl";
import { t } from "../i18n";
import type { PersistentGameState } from "../types/game";

const ingredients = Object.keys(FOOD_DEFINITIONS);
const equipment = Object.keys(STATION_KIND_LABEL) as (keyof typeof STATION_KIND_LABEL)[];

export function achievementProgress(state: PersistentGameState) {
  const levels = new Set<string>();
  for (const key of Object.keys(state.levelRanks)) {
    if (key.startsWith("official:")) levels.add(key.slice("official:".length));
    const scenario = SCENARIOS.find((entry) => key === `scenario:${entry.id}`);
    if (scenario?.levelId) levels.add(scenario.levelId);
  }
  return [
    { key: "collection.orders", count: state.lifetimeOrders ?? 0, goal: 50 },
    { key: "collection.levels", count: levels.size, goal: 10 },
    { key: "collection.discoveries", count: new Set(state.discoveries).size, goal: 20 },
  ] as const;
}

export function openCollection(view: "items" | "achievements", state: PersistentGameState): void {
  const dialog = document.createElement("dialog");
  dialog.className = `bistro-collection bistro-${view}`;
  const title = document.createElement("h2");
  title.id = "bistro-collection-title";
  title.textContent = t(`collection.${view}`);
  dialog.setAttribute("aria-labelledby", title.id);
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = t("common.close");
  close.onclick = () => dialog.close();
  const content = document.createElement("div");
  content.className = "bistro-collection-grid";
  const discovered = new Set(state.discoveries);
  const add = (name: string, detail: string, locked = false) => {
    const card = document.createElement("article");
    card.dataset.locked = String(locked);
    const heading = document.createElement("strong");
    heading.textContent = name;
    const description = document.createElement("span");
    description.textContent = detail;
    card.append(heading, description);
    content.append(card);
    return card;
  };
  dialog.append(title);
  if (view === "items") {
    const filters = document.createElement("div");
    filters.className = "bistro-collection-filters";
    const render = (tab: "ingredients" | "equipment") => {
      content.replaceChildren();
      for (const button of filters.querySelectorAll("button")) {
        button.setAttribute("aria-pressed", String(button.dataset.filter === tab));
      }
      const entries = tab === "ingredients"
        ? ingredients.map((id) => [id, getIngredient(id)?.displayName ?? id])
        : equipment.map((id) => [`station:${id}`, STATION_KIND_LABEL[id]]);
      for (const [id, label] of entries) {
        if (!id || !label) continue;
        const locked = !discovered.has(id);
        const card = add(label, locked ? t("collection.locked") : "✓", locked);
        const image = document.createElement("img");
        image.width = image.height = 48;
        image.alt = "";
        image.loading = "lazy";
        image.src = publicUrl(tab === "ingredients" ? ingredientIllustration(id) : `assets/ui/hud/${id === "station:delivery" ? "serve" : id.slice("station:".length)}.webp`);
        card.prepend(image);
      }
    };
    for (const tab of ["ingredients", "equipment"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.filter = tab;
      button.textContent = t(`collection.${tab}`);
      button.onclick = () => render(tab);
      filters.append(button);
    }
    dialog.append(filters);
    render("ingredients");
  } else {
    for (const { key, count, goal } of achievementProgress(state)) {
      const card = add(t(key), `${Math.min(count, goal)} / ${goal}`, count < goal);
      const progress = document.createElement("progress");
      progress.max = goal;
      progress.value = Math.min(count, goal);
      progress.setAttribute("aria-label", t(key));
      card.append(progress);
    }
  }
  dialog.append(content, close);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}
