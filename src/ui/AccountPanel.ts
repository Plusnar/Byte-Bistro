import {
  AccountApiError, avatars, changePassword, currentUser, deleteAccount, logIn, logOut, mergeProgress,
  readAccount, register, syncAccount, type AccountSnapshot, type AccountUser,
} from "../core/PlayerAccount";
import { sanitizePersistentState } from "../core/SaveSystem";
import { createDefaultPersistentState } from "../core/GameState";
import { publicUrl } from "../utils/assetUrl";
import { t, type MessageKey } from "../i18n";
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

/** What each API error tells the player. */
const ERROR_TEXT: Readonly<Record<string, MessageKey>> = {
  "wrong-login": "account.wrongLogin",
  "username-taken": "account.usernameTaken",
  locked: "account.tooManyAttempts",
  "rate-limited": "account.tooManyAttempts",
  "bad-request": "account.invalidDetails",
  "not-configured": "account.unavailable",
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

  constructor(
    private readonly readGuest: () => PersistentGameState,
    private readonly activate: (progress: PersistentGameState | null) => void,
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
      if (stored?.profile && avatars.includes(stored.profile.avatar)) {
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
    this.activate(this.snapshot.progress);
    if (cached) this.persist();
  }

  private signedOut(): void {
    setSessionHint(false);
    this.generation++;
    this.user = null;
    this.snapshot = null;
    this.pending = false;
    this.activate(null);
  }

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
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = t("common.close");
    close.onclick = () => dialog.close();
    const form = document.createElement("form");
    const hint = (text: string) => {
      const small = document.createElement("small");
      small.textContent = text;
      form.append(small);
    };
    const field = (label: string, type: string, autocomplete: string) => {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      const input = document.createElement("input");
      input.type = type;
      input.setAttribute("autocomplete", autocomplete);
      input.required = true;
      wrapper.append(input);
      form.append(wrapper);
      return input;
    };
    const usernameField = (autocomplete: string) => {
      const input = field(t("account.username"), "text", autocomplete);
      input.minLength = USERNAME_MIN;
      input.maxLength = USERNAME_MAX;
      input.pattern = "[A-Za-z0-9_.]+";
      input.spellcheck = false;
      input.setAttribute("autocapitalize", "none");
      return input;
    };
    const passwordField = (label: string, autocomplete: string) => {
      const input = field(label, "password", autocomplete);
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
      message.textContent = t(ERROR_TEXT[code] ?? "account.failed");
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
      button.textContent = label;
      form.append(button);
      form.onsubmit = (event) => { event.preventDefault(); handle(run); };
    };

    if (this.unavailable) {
      message.textContent = t("account.unavailable");
    } else if (this.snapshot && this.user && mode === "password") {
      const current = passwordField(t("account.currentPassword"), "current-password");
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
      const name = field(t("account.name"), "text", "nickname");
      name.required = false;
      name.maxLength = 40;
      name.value = profile.name;
      const summary = document.createElement("p");
      summary.textContent = t("account.stats", {
        stars: Object.values(progress.levelStars).reduce((sum, stars) => sum + stars, 0),
        record: Math.max(0, ...Object.values(progress.levelBestScore)),
      });
      const options = document.createElement("div");
      options.className = "bistro-avatars";
      let selected = profile.avatar;
      for (const avatar of avatars) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-label", avatar);
        button.setAttribute("aria-pressed", String(selected === avatar));
        const image = document.createElement("img");
        image.alt = "";
        image.src = publicUrl(`assets/ui/avatar-${avatar}.webp`);
        image.width = image.height = 56;
        button.append(image);
        button.onclick = () => {
          selected = avatar;
          for (const option of options.querySelectorAll("button")) option.setAttribute("aria-pressed", String(option === button));
        };
        options.append(button);
      }
      form.append(summary, options);
      submit(t("account.save"), async () => {
        if (!this.snapshot) return;
        this.snapshot = { ...this.snapshot, profile: { name: name.value.trim(), avatar: selected } };
        this.persist();
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
      const username = usernameField(creating ? "username" : "username");
      if (creating) hint(t("account.usernameRules"));
      const password = passwordField(t("account.password"), creating ? "new-password" : "current-password");
      if (creating) {
        hint(t("account.passwordRules"));
        const warning = document.createElement("p");
        warning.className = "bistro-account-warning";
        warning.textContent = t("account.noRecoveryWarning");
        form.append(warning);
      }
      submit(t(creating ? "account.register" : "account.login"), async () => {
        const name = cleanUsername(username.value);
        if (!name || (creating && !validPassword(password.value))) throw new AccountApiError("bad-request", 400);
        const user = creating ? await register(name, password.value) : await logIn(name, password.value);
        await this.load(user);
        this.show();
      });
      if (creating) action(t("account.haveAccount"), () => this.show("login"));
      else action(t("account.register"), () => this.show("register"));
    }
    dialog.append(heading, form, message, close);
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
  }

  /** A status line on the open dialog, e.g. after a step that redraws it. */
  private setMessage(text: string): void {
    const status = this.dialog?.querySelector("[role=status]");
    if (status) status.textContent = text;
  }
}
