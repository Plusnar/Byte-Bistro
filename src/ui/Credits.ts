import { t, type MessageKey } from "../i18n";
import { publicUrl } from "../utils/assetUrl";
import { closeCorner } from "./closeCorner";

/**
 * The project's story and credits, rolling up the screen like the end of a film.
 *
 * It scrolls by itself while left alone; the wheel, a drag, the arrow keys or player 1's
 * D-pad (MenuNavigator scrolls `.bistro-credits-roll`) take over, and it carries on rolling
 * a few seconds after the last touch. The roll runs only while the dialog is open.
 */

/** Pixels per second the credits rise by themselves. */
const ROLL_SPEED = 34;
/** Seconds after a manual scroll before the roll carries on. */
const RESUME_AFTER = 4;

/** Free packs the levels are built with, all CC0, by their authors. */
const PACKS: readonly { readonly author: string; readonly site: string; readonly packs: string }[] = [
  {
    author: "Kay Lousberg",
    site: "kaylousberg.com",
    packs: "KayKit — Restaurant Bits · Furniture Bits · Forest Nature Pack · Platformer Pack · Prototype Bits · Block Bits · Space Base Bits · Character Animations · Mannequin Character",
  },
  {
    author: "Kenney",
    site: "kenney.nl",
    packs: "Food Kit · Factory Kit · Mini Market · Cube Pets · Modular Space Kit · Tower Defense Kit",
  },
];

const TEAM: readonly { readonly name: string; readonly roles: MessageKey }[] = [
  { name: "William Fagundes", roles: "credits.williamRoles" },
  { name: "Sandriely Maciel", roles: "credits.sandrielyRoles" },
];

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function openCredits(): void {
  const dialog = document.createElement("dialog");
  dialog.className = "bistro-credits";
  dialog.setAttribute("aria-labelledby", "bistro-credits-title");
  const roll = element("div", "bistro-credits-roll");
  roll.tabIndex = 0;
  const content = element("div", "bistro-credits-content");

  const logo = document.createElement("img");
  logo.className = "bistro-credits-logo";
  logo.src = publicUrl("assets/ui/bistro-emblem.webp");
  logo.alt = "Byte Bistro";
  const title = element("h2", "bistro-credits-title", t("credits.title"));
  title.id = "bistro-credits-title";
  content.append(logo, title);

  const section = (heading: MessageKey) => {
    const block = element("section", "bistro-credits-section");
    block.append(element("h3", "", t(heading)));
    content.append(block);
    return block;
  };

  const story = section("credits.storyHeading");
  for (const key of ["credits.story1", "credits.story2", "credits.story3", "credits.story4", "credits.story5"] as const) {
    story.append(element("p", "bistro-credits-story", t(key)));
  }

  const behind = section("credits.behindHeading");
  for (const key of ["credits.behind1", "credits.behind2", "credits.behind3", "credits.behind4", "credits.behind5"] as const) {
    behind.append(element("p", "bistro-credits-story", t(key)));
  }
  behind.append(element("p", "bistro-credits-closing", t("credits.closing")));

  const team = section("credits.teamHeading");
  for (const member of TEAM) {
    team.append(element("p", "bistro-credits-name", member.name), element("p", "bistro-credits-role", t(member.roles)));
  }
  team.append(element("p", "bistro-credits-school", t("credits.school")));

  const thanks = section("credits.thanksHeading");
  thanks.append(
    element("p", "bistro-credits-name", t("credits.professorMilena")),
    element("p", "bistro-credits-name", t("credits.professorJean")),
  );

  const packs = section("credits.packsHeading");
  for (const pack of PACKS) {
    packs.append(
      element("p", "bistro-credits-name", `${pack.author} · ${pack.site}`),
      element("p", "bistro-credits-role", pack.packs),
    );
  }
  packs.append(element("p", "bistro-credits-note", t("credits.packsNote")));

  const tools = section("credits.toolsHeading");
  tools.append(element("p", "bistro-credits-role", "Babylon.js · TypeScript · Vite · Blender · Cloudflare"));

  content.append(element("p", "bistro-credits-end", t("credits.thanksForPlaying")));
  roll.append(content);
  dialog.append(closeCorner(dialog), roll);
  document.body.append(dialog);

  // The roll: only while open, paused by any manual scroll for a few seconds.
  const hooks = new AbortController();
  let frame = 0;
  let last = 0;
  let idleUntil = 0;
  let position = 0;
  const step = (now: number) => {
    const delta = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (now >= idleUntil && roll.scrollTop < roll.scrollHeight - roll.clientHeight - 1) {
      position = Math.max(position, roll.scrollTop) + ROLL_SPEED * delta;
      roll.scrollTop = position;
    } else {
      position = roll.scrollTop;
    }
    frame = requestAnimationFrame(step);
  };
  const hold = () => { idleUntil = performance.now() + RESUME_AFTER * 1000; };
  for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) {
    roll.addEventListener(type, hold, { passive: true, signal: hooks.signal });
  }
  // MenuNavigator scrolls the roll with the D-pad; any scroll it makes holds the roll too.
  roll.addEventListener("scroll", () => {
    if (Math.abs(roll.scrollTop - position) > 2) hold();
  }, { passive: true, signal: hooks.signal });

  dialog.addEventListener("close", () => {
    cancelAnimationFrame(frame);
    hooks.abort();
    dialog.remove();
  }, { once: true });
  dialog.showModal();
  roll.focus({ preventScroll: true });
  frame = requestAnimationFrame(step);
}
