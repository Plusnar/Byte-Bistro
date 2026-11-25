import { FOOD_DEFINITIONS, MIX_RECIPES, STATION_KIND_LABEL } from "../data/kitchen";
import { getIngredient } from "../data/ingredients";
import { SCENARIOS } from "../data/scenarios";
import { ingredientIllustration } from "./illustrations";
import { publicUrl } from "../utils/assetUrl";
import { closeCorner } from "./closeCorner";
import { t, type MessageKey } from "../i18n";
import type { PersistentGameState } from "../types/game";

const ingredients = Object.keys(FOOD_DEFINITIONS);
const equipment = Object.keys(STATION_KIND_LABEL) as (keyof typeof STATION_KIND_LABEL)[];

/**
 * Prepared ingredients have no crate: they are made in the mixer. Their card says so, and
 * their detail lists what goes into the bowl, so a missing crate does not look like a gap.
 */
const mixedFrom = (id: string): string | null => {
  const mix = MIX_RECIPES.find((recipe) => recipe.output === id);
  if (!mix) return null;
  return mix.inputs.map((input) => {
    const name = getIngredient(input.ingredientId)?.displayName ?? input.ingredientId;
    return input.state === "chopped" ? t("collection.choppedItem", { name }) : name;
  }).join(" + ");
};

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

/** The ✕ in the top-right corner every collection-style dialog closes with. */
const imageFor = (id: string): string => publicUrl(id.startsWith("station:")
  ? `assets/ui/hud/${id === "station:delivery" ? "serve" : id.slice("station:".length)}.webp`
  : ingredientIllustration(id));

export function openCollection(view: "items" | "achievements", state: PersistentGameState): void {
  const dialog = document.createElement("dialog");
  dialog.className = `bistro-collection bistro-${view}`;
  const title = document.createElement("h2");
  title.id = "bistro-collection-title";
  title.textContent = t(`collection.${view}`);
  dialog.setAttribute("aria-labelledby", title.id);
  const close = closeCorner(dialog);
  const content = document.createElement("div");
  content.className = "bistro-collection-grid";
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
  dialog.append(close, title);
  if (view === "items") {
    const filters = document.createElement("div");
    filters.className = "bistro-collection-filters";
    let current: "ingredients" | "equipment" = "ingredients";
    /** One item, opened from its card: big picture, name and a short, silly description. */
    const about = (id: string) => t(`collection.about.${id.replace(/^station:/, "")}` as MessageKey);
    const showDetail = (id: string, label: string) => {
      const detail = document.createElement("section");
      detail.className = "bistro-item-detail";
      const image = document.createElement("img");
      image.alt = "";
      image.width = image.height = 160;
      image.src = imageFor(id);
      const name = document.createElement("h3");
      name.textContent = label;
      const text = document.createElement("p");
      text.textContent = about(id);
      const recipe = mixedFrom(id);
      const made = document.createElement("p");
      made.className = "bistro-item-mixed";
      made.hidden = !recipe;
      if (recipe) made.textContent = t("collection.mixedFrom", { recipe });
      const back = document.createElement("button");
      back.type = "button";
      back.textContent = t("collection.back");
      back.onclick = () => {
        render(current);
        // Back on the card that was opened, so the cursor carries on from there.
        [...content.querySelectorAll<HTMLButtonElement>(".bistro-card-open")].find((button) => button.dataset.item === id)?.focus();
      };
      // B on player 1's phone returns to the list instead of closing the dialog.
      back.dataset.navBack = "";
      detail.append(image, name, text, made, back);
      filters.hidden = true;
      content.replaceChildren(detail);
      back.focus();
    };
    const render = (tab: "ingredients" | "equipment") => {
      current = tab;
      filters.hidden = false;
      content.replaceChildren();
      for (const button of filters.querySelectorAll("button")) {
        button.setAttribute("aria-pressed", String(button.dataset.filter === tab));
      }
      const entries = tab === "ingredients"
        ? ingredients.map((id) => [id, getIngredient(id)?.displayName ?? id])
        : equipment.map((id) => [`station:${id}`, STATION_KIND_LABEL[id]]);
      for (const [id, label] of entries) {
        if (!id || !label) continue;
        // Every item is open from the start: the list is a guide to the kitchen, not a reward.
        const card = add(label, about(id));
        card.classList.add("bistro-item-card");
        if (mixedFrom(id)) {
          const badge = document.createElement("em");
          badge.className = "bistro-item-badge";
          badge.textContent = t("collection.mixerBadge");
          card.append(badge);
        }
        const image = document.createElement("img");
        image.width = image.height = 48;
        image.alt = "";
        image.loading = "lazy";
        image.src = imageFor(id);
        card.prepend(image);
        // The whole card opens the item's detail; a button so the D-pad and Enter reach it.
        const open = document.createElement("button");
        open.type = "button";
        open.className = "bistro-card-open";
        open.setAttribute("aria-label", label);
        open.dataset.item = id;
        open.onclick = () => showDetail(id, label);
        card.append(open);
        // The cursor starts on the first item, not on the corner ✕.
        if (content.childElementCount === 1) open.autofocus = true;
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
  dialog.append(content);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}
