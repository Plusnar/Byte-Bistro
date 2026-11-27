import {
  AccountApiError, avatarPath, avatars, changePassword, isAvatar, type Avatar, currentUser, deleteAccount, logIn, logOut, mergeProgress,
  readAccount, register, syncAccount, type AccountSnapshot, type AccountUser,
} from "../core/PlayerAccount";
import { sanitizePersistentState } from "../core/SaveSystem";
import { createDefaultPersistentState } from "../core/GameState";
import { publicUrl } from "../utils/assetUrl";
import { t } from "../i18n";
import { accountErrorText } from "../core/accountErrors";
import { closeCorner } from "./closeCorner";
import type { PhoneFieldKind } from "../net/mp/protocol";
import type { PersistentGameState } from "../types/game";
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, cleanUsername, validPassword } from "../../workers/accounts/src/rules";

type Mode = "login" | "register" | "password" | "delete";

/**
 * Remembers that this browser has an account session, so the game only asks the server
 * who is signed in when there may be someone (Game.ts reads the same key).
 */
const ACCOUNT_SESSION_HINT = "byte-bistro:account:session";
const setSessionHint = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(ACCOUNT_SESSION_HINT, "1");
    else localStorage.removeItem(ACCOUNT_SESSION_HINT);
  } catch { /* private mode: the account still works when opened */ }
};

/**
 * The avatar wheel: one big picture in the middle, its neighbours fading out on each side.
 * Left/right turn it: player 1's D-pad (`navstep` from MenuNavigator), the arrow keys, the
 * side arrows with the mouse or a swipe.
 */
const avatarWheel = (initial: Avatar) => {
  const element = document.createElement("div");
  element.className = "bistro-avatar-wheel";
  element.tabIndex = 0;
  element.dataset.nav = "";
  element.dataset.navX = "";
  element.setAttribute("role", "spinbutton");
  element.setAttribute("aria-label", t("account.pickAvatar"));
  const arrow = (direction: -1 | 1) => {
    const button = document.createElement("span");
    button.className = "bistro-wheel-arrow";
    button.textContent = direction < 0 ? "◀" : "▶";
    button.setAttribute("aria-hidden", "true");
    button.onclick = () => step(direction);
    return button;
  };
  const track = document.createElement("div");
  track.className = "bistro-wheel-track";
  const OFFSETS = [-2, -1, 0, 1, 2] as const;
  const slots = OFFSETS.map((offset) => {
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.dataset.offset = String(offset);
    track.append(image);
    return image;
  });
  const counter = document.createElement("span");
  counter.className = "bistro-wheel-count";
  const hint = document.createElement("span");
  hint.className = "bistro-wheel-hint";
  hint.textContent = t("account.avatarHint");
  element.append(arrow(-1), track, arrow(1), counter, hint);

  let index = Math.max(0, avatars.indexOf(initial));
  const count = avatars.length;
  const render = () => {
    slots.forEach((image, slot) => {
      image.src = publicUrl(avatarPath(avatars[(index + OFFSETS[slot]! + count) % count]!));
    });
    counter.textContent = `${index + 1} / ${count}`;
    element.setAttribute("aria-valuenow", String(index + 1));
    element.setAttribute("aria-valuetext", `${index + 1} / ${count}`);
  };
  const step = (direction: number) => {
    index = (index + direction + count) % count;
    render();
    // A short slide in the direction it turned (restarted on every step).
    element.dataset.turn = direction < 0 ? "left" : "right";
    track.getAnimations().forEach((animation) => animation.cancel());
    track.classList.remove("turning");
    void track.offsetWidth;
    track.classList.add("turning");
  };
  element.addEventListener("navstep", (event) => step((event as CustomEvent<number>).detail));
  element.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    step(event.key === "ArrowLeft" ? -1 : 1);
  });
  let swipeFrom: number | null = null;
  element.addEventListener("pointerdown", (event) => { swipeFrom = event.clientX; });
  element.addEventListener("pointerup", (event) => {
    if (swipeFrom !== null && Math.abs(event.clientX - swipeFrom) > 30) step(event.clientX < swipeFrom ? 1 : -1);
    swipeFrom = null;
  });
  render();
  return { element, selected: () => avatars[index]! };
};

/**
 * The player's account: sign up or in with a username and password, then a profile (name,
 * avatar), the progress synced to Cloudflare, password change and account deletion.
 *
 * The session lives in an HttpOnly cookie the browser sends by itself; this panel only asks
 * the API who is signed in (`resume`). Progress is cached per account in localStorage and
 * synced with revisions, so playing offline or on two devices never loses a save.
 */
export class AccountPanel {
  private dialog: HTMLDialogElement | null = null;
  private user: AccountUser | null = null;
  private snapshot: AccountSnapshot | null = null;
  /** The account server answered `not-configured`: the game stays guest-only. */
  private unavailable = false;
  private sending = false;
  private pending = false;
  private generation = 0;
  private readonly listeners = new AbortController();
  /** The signed-in player's picture (null: signed out), for the menu's account button. */
  onAvatar: (path: string | null) => void = () => undefined;
  /** The picture picked on the sign-up form, applied once the account exists. */
  private registerAvatar: Avatar | null = null;
  /** Player 1's phone can type the fields (see PhoneTyping); set by the game. */
  phoneTypingAvailable: () => boolean = () => false;
  /** A dialog just opened (its first field has the focus). */
  onShown: () => void = () => undefined;

  constructor(
    private readonly readGuest: () => PersistentGameState,
    private readonly activate: (progress: PersistentGameState | null) => void,
    /** Who is signed in now (null: nobody), called on every change. */
    private readonly onUser: (user: AccountUser | null) => void = () => undefined,
  ) {
    window.addEventListener("online", () => void this.flush(), { signal: this.listeners.signal });
  }

  dispose(): void {
    this.generation++;
    this.listeners.abort();
    this.dialog?.close();
  }

  private key(id: string) { return `byte-bistro:account:${id}`; }

  update(progress: PersistentGameState): boolean {
    if (!this.user || !this.snapshot) return false;
    const settingsAt = JSON.stringify(this.snapshot.progress.settings) === JSON.stringify(progress.settings)
      ? this.snapshot.settingsAt : Date.now();
    this.snapshot = { ...this.snapshot, progress, settingsAt };
    this.persist();
    return true;
  }

  private persist() {
    if (!this.user || !this.snapshot) return;
    this.pending = true;
    try { localStorage.setItem(this.key(this.user.id), JSON.stringify(this.snapshot)); } catch { /* in-memory retry */ }
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.pending || !this.user || !this.snapshot) return;
    const user = this.user;
    const generation = this.generation;
    const sent = this.snapshot;
    this.sending = true;
    this.pending = false;
    try {
      const synced = await syncAccount(sent);
      if (generation === this.generation && this.snapshot === sent) {
        this.snapshot = synced;
        this.activate(synced.progress);
        try { localStorage.setItem(this.key(user.id), JSON.stringify(synced)); } catch { /* cloud copy is current */ }
      }
    } catch (error) {
      // The session ended elsewhere (password changed, account deleted): back to guest.
      if (error instanceof AccountApiError && error.status === 401) {
        if (generation === this.generation) this.signedOut();
        return;
      }
      if (generation === this.generation) {
        this.pending = true;
        return;
      }
    } finally {
      this.sending = false;
    }
    if (this.pending) void this.flush();
  }

  private async load(user: AccountUser): Promise<void> {
    const generation = ++this.generation;
    let cached: AccountSnapshot | null = null;
    try {
      const stored = JSON.parse(localStorage.getItem(this.key(user.id)) ?? "null") as AccountSnapshot | null;
      if (stored?.profile && isAvatar(stored.profile.avatar)) {
        cached = { ...stored, progress: sanitizePersistentState(stored.progress, createDefaultPersistentState()) };
      }
    } catch { /* invalid cache */ }
    const remote = await readAccount().catch((error: unknown) => {
      if (!cached) throw error;
      return null;
    });
    if (generation !== this.generation) return;
    this.user = user;
    setSessionHint(true);
    this.snapshot = cached ?? remote?.snapshot ?? {
      progress: createDefaultPersistentState(), profile: { name: user.username, avatar: "william" }, settingsAt: 0,
    };
    // The picture chosen while creating the account becomes its first profile picture.
    const picked = this.registerAvatar;
    this.registerAvatar = null;
    if (picked && !cached && !remote) {
      this.snapshot = { ...this.snapshot, profile: { ...this.snapshot.profile, avatar: picked } };
      this.persist();
    }
    this.activate(this.snapshot.progress);
    this.onUser(user);
    this.onAvatar(avatarPath(this.snapshot.profile.avatar));
    if (cached) this.persist();
  }

  private signedOut(): void {
    setSessionHint(false);
    this.generation++;
    this.user = null;
    this.snapshot = null;
    this.pending = false;
    this.activate(null);
    this.onUser(null);
    this.onAvatar(null);
  }

  close(): void { this.dialog?.close(); }

  expireSession(): void { if (this.user) this.signedOut(); }

  get signedInUser(): AccountUser | null { return this.user; }

  /** Restores a signed-in session (the cookie survives reloads). Quiet when there is none. */
  async resume(): Promise<void> {
    if (this.user || this.unavailable) return;
    try {
      const user = await currentUser();
      if (user) await this.load(user);
      else setSessionHint(false);
    } catch (error) {
      if (error instanceof AccountApiError && error.code === "not-configured") this.unavailable = true;
      else throw error;
    }
  }

  show(mode: Mode = "login"): void {
    if (this.dialog?.open) this.dialog.close();
    const dialog = document.createElement("dialog");
    this.dialog = dialog;
    dialog.className = "bistro-collection bistro-profile";
    const heading = document.createElement("h2");
    heading.id = "bistro-account-title";
    heading.textContent = t(this.snapshot ? "account.profile" : "account.title");
    dialog.setAttribute("aria-labelledby", heading.id);
    const message = document.createElement("p");
    message.setAttribute("role", "status");
    const close = closeCorner(dialog);
    const form = document.createElement("form");
    const hint = (text: string) => {
      const small = document.createElement("small");
      small.textContent = text;
      form.append(small);
    };
    /** A text field; `phone` is how player 1's phone offers to type it (PhoneTyping). */
    const field = (label: string, type: string, autocomplete: string, phone: PhoneFieldKind) => {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      const input = document.createElement("input");
      input.type = type;
      input.dataset.phoneField = phone;
      input.setAttribute("autocomplete", autocomplete);
      input.required = true;
      wrapper.append(input);
      form.append(wrapper);
      return input;
    };
    const usernameField = (autocomplete: string) => {
      const input = field(t("account.username"), "text", autocomplete, "username");
      input.minLength = USERNAME_MIN;
      input.maxLength = USERNAME_MAX;
      input.pattern = "[A-Za-z0-9_.]+";
      input.spellcheck = false;
      input.setAttribute("autocapitalize", "none");
      return input;
    };
    const passwordField = (label: string, autocomplete: string) => {
      const input = field(label, "password", autocomplete, autocomplete === "new-password" ? "new-password" : "password");
      input.minLength = autocomplete === "new-password" ? PASSWORD_MIN : 1;
      input.maxLength = PASSWORD_MAX;
      return input;
    };
    const action = (label: string, run: () => void, parent: HTMLElement = form) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.onclick = run;
      parent.append(button);
    };
    const explain = (error: unknown) => {
      const code = error instanceof AccountApiError ? error.code : "";
      message.textContent = t(accountErrorText(code));
    };
    const handle = (run: () => Promise<void>) => {
      if (form.getAttribute("aria-busy") === "true") return;
      form.setAttribute("aria-busy", "true");
      for (const control of form.querySelectorAll("button")) control.disabled = true;
      void run().catch(explain).finally(() => {
        form.removeAttribute("aria-busy");
        for (const control of form.querySelectorAll("button")) control.disabled = false;
      });
    };
    const submit = (label: string, run: () => Promise<void>) => {
      const button = document.createElement("button");
      button.type = "submit";
      // Full width under the fields: "down" from the last field always lands on it.
      button.className = "bistro-form-main";
      button.textContent = label;
      form.append(button);
      form.onsubmit = (event) => { event.preventDefault(); handle(run); };
    };

    if (this.unavailable) {
      message.textContent = t("account.unavailable");
    } else if (this.snapshot && this.user && mode === "password") {
      const current = passwordField(t("account.currentPassword"), "current-password");
      current.autofocus = true;
      const next = passwordField(t("account.newPassword"), "new-password");
      hint(t("account.passwordRules"));
      submit(t("account.changePassword"), async () => {
        if (!validPassword(next.value)) throw new AccountApiError("bad-request", 400);
        await changePassword(current.value, next.value);
        this.show();
        this.setMessage(t("account.passwordChanged"));
      });
      action(t("account.back"), () => this.show());
    } else if (this.snapshot && this.user && mode === "delete") {
      const warning = document.createElement("p");
      warning.textContent = t("account.confirmDelete");
      form.append(warning);
      const password = passwordField(t("account.password"), "current-password");
      password.autofocus = true;
      submit(t("account.deleteAccount"), async () => {
        const id = this.user?.id;
        await deleteAccount(password.value);
        if (id) try { localStorage.removeItem(this.key(id)); } catch { /* nothing cached */ }
        this.signedOut();
        this.show();
      });
      action(t("account.back"), () => this.show());
    } else if (this.snapshot && this.user) {
      const profile = this.snapshot.profile;
      const progress = this.snapshot.progress;
      const who = document.createElement("p");
      who.textContent = t("account.signedInAs", { username: this.user.username });
      form.append(who);
      const name = field(t("account.name"), "text", "nickname", "name");
      name.required = false;
      name.maxLength = 40;
      name.value = profile.name;
      const summary = document.createElement("p");
      summary.textContent = t("account.stats", {
        stars: Object.values(progress.levelStars).reduce((sum, stars) => sum + stars, 0),
        record: Math.max(0, ...Object.values(progress.levelBestScore)),
      });
      const picker = avatarWheel(profile.avatar);
      // The cursor starts on the wheel (autofocus also beats the corner ✕ for the browser).
      picker.element.autofocus = true;
      form.append(summary, picker.element);
      submit(t("account.save"), async () => {
        if (!this.snapshot) return;
        this.snapshot = { ...this.snapshot, profile: { name: name.value.trim(), avatar: picker.selected() } };
        this.persist();
        this.onAvatar(avatarPath(picker.selected()));
        message.textContent = t("account.saved");
      });
      action(t("account.import"), () => {
        if (!this.snapshot || !window.confirm(t("account.confirmImport"))) return;
        // Preserve the guest save and import through the same conflict resolver.
        const source = this.readGuest();
        const { levelRanks, levelStars, levelBestScore, ...rest } = source;
        const onlyOfficial = <T>(entries: Record<string, T>) => Object.fromEntries(
          Object.entries(entries).filter(([key]) => !key.startsWith("slot:")),
        );
        const imported = {
          ...rest, levelRanks: onlyOfficial(levelRanks), levelStars: onlyOfficial(levelStars),
          levelBestScore: onlyOfficial(levelBestScore),
        };
        this.snapshot = {
          ...this.snapshot,
          settingsAt: Date.now(),
          progress: mergeProgress(this.snapshot.progress, imported, false),
        };
        this.activate(this.snapshot.progress);
        this.persist();
        this.show();
      });
      action(t("account.changePassword"), () => this.show("password"));
      action(t("account.logout"), () => handle(async () => {
        await logOut();
        this.signedOut();
        this.show();
      }));
      action(t("account.deleteAccount"), () => this.show("delete"));
    } else {
      const creating = mode === "register";
      if (this.phoneTypingAvailable()) {
        const phone = document.createElement("p");
        phone.className = "bistro-phone-typing";
        phone.textContent = `📱 ${t("account.typeOnPhone")}`;
        form.append(phone);
      }
      const username = usernameField("username");
      // The cursor (and player 1's phone keyboard) starts on the first field.
      username.autofocus = true;
      if (creating) hint(t("account.usernameRules"));
      const password = passwordField(t("account.password"), creating ? "new-password" : "current-password");
      const picker = creating ? avatarWheel(this.registerAvatar ?? avatars[0]) : null;
      if (creating) {
        heading.textContent = t("account.createTitle");
        hint(t("account.passwordRules"));
        const label = document.createElement("p");
        label.className = "bistro-avatar-label";
        label.textContent = t("account.pickAvatar");
        form.append(label, picker!.element);
        const warning = document.createElement("p");
        warning.className = "bistro-account-warning";
        warning.textContent = t("account.noRecoveryWarning");
        form.append(warning);
      }
      const signIn = async (typedName: string, typedPassword: string) => {
        const name = cleanUsername(typedName);
        if (!name || (creating && !validPassword(typedPassword))) throw new AccountApiError("bad-request", 400);
        if (picker) this.registerAvatar = picker.selected();
        const user = creating ? await register(name, typedPassword) : await logIn(name, typedPassword);
        await this.load(user);
        this.show();
      };
      submit(t(creating ? "account.register" : "account.login"), () => signIn(username.value, password.value));
      if (creating) action(t("account.haveAccount"), () => this.show("login"));
      else action(t("account.register"), () => this.show("register"));
    }
    dialog.append(close, heading, form, message);
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    this.onShown();
  }

  /** A status line on the open dialog, e.g. after a step that redraws it or why it opened. */
  setMessage(text: string): void {
    const status = this.dialog?.querySelector("[role=status]");
    if (status) status.textContent = text;
  }
}
