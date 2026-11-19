import { accountAvailable, avatars, getAccountClient, readAccount, syncAccount, mergeProgress, type AccountSnapshot } from "../core/PlayerAccount";
import { sanitizePersistentState } from "../core/SaveSystem";
import { createDefaultPersistentState } from "../core/GameState";
import { publicUrl } from "../utils/assetUrl";
import { t } from "../i18n";
import type { PersistentGameState } from "../types/game";

export class AccountPanel {
  private dialog: HTMLDialogElement | null = null;
  private id: string | null = null;
  private snapshot: AccountSnapshot | null = null;
  private sending = false;
  private pending = false;
  private generation = 0;
  private readonly listeners = new AbortController();
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    private readonly readGuest: () => PersistentGameState,
    private readonly activate: (progress: PersistentGameState | null) => void,
  ) {
    if (!accountAvailable) return;
    const { data } = getAccountClient().auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") queueMicrotask(() => this.show("reset"));
      if (event === "SIGNED_OUT" || (this.id && session && this.id !== session.user.id)) {
        this.generation++;
        this.id = null;
        this.snapshot = null;
        this.pending = false;
        this.activate(null);
      }
    });
    this.unsubscribe = () => data.subscription.unsubscribe();
    window.addEventListener("online", () => void this.flush(), { signal: this.listeners.signal });
  }

  dispose(): void {
    this.generation++;
    this.listeners.abort();
    this.unsubscribe?.();
    this.dialog?.close();
  }

  private key(id: string) { return `byte-bistro:account:${id}`; }

  update(progress: PersistentGameState): boolean {
    if (!this.id || !this.snapshot) return false;
    const settingsAt = JSON.stringify(this.snapshot.progress.settings) === JSON.stringify(progress.settings)
      ? this.snapshot.settingsAt : Date.now();
    this.snapshot = { ...this.snapshot, progress, settingsAt };
    this.persist();
    return true;
  }

  private persist() {
    if (!this.id || !this.snapshot) return;
    this.pending = true;
    try { localStorage.setItem(this.key(this.id), JSON.stringify(this.snapshot)); } catch { /* in-memory retry */ }
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.pending || !this.id || !this.snapshot) return;
    const id = this.id;
    const generation = this.generation;
    const sent = this.snapshot;
    this.sending = true;
    this.pending = false;
    try {
      const synced = await syncAccount(id, sent);
      if (generation === this.generation && this.snapshot === sent) {
        this.snapshot = synced;
        this.activate(synced.progress);
        try { localStorage.setItem(this.key(id), JSON.stringify(synced)); } catch { /* cloud copy is current */ }
      }
    } catch {
      if (generation === this.generation) {
        this.pending = true;
        return;
      }
    } finally {
      this.sending = false;
    }
    if (this.pending) void this.flush();
  }

  private async load(id: string): Promise<void> {
    const generation = ++this.generation;
    let cached: AccountSnapshot | null = null;
    try {
      const stored = JSON.parse(localStorage.getItem(this.key(id)) ?? "null") as AccountSnapshot | null;
      if (stored?.profile && avatars.includes(stored.profile.avatar)) {
        cached = { ...stored, progress: sanitizePersistentState(stored.progress, createDefaultPersistentState()) };
      }
    } catch { /* invalid cache */ }
    const remote = await readAccount(id).catch((error: unknown) => {
      if (!cached) throw error;
      return null;
    });
    if (generation !== this.generation) return;
    this.id = id;
    this.snapshot = cached ?? remote?.snapshot ?? {
      progress: createDefaultPersistentState(), profile: { name: "", avatar: "william" }, settingsAt: 0,
    };
    this.activate(this.snapshot.progress);
    if (cached) this.persist();
  }

  async resume(): Promise<void> {
    if (!accountAvailable || this.id) return;
    const { data } = await getAccountClient().auth.getSession();
    if (data.session) await this.load(data.session.user.id);
  }

  show(mode: "login" | "register" | "recover" | "reset" = "login"): void {
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
    const action = (label: string, run: () => void, parent: HTMLElement = form) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.onclick = run;
      parent.append(button);
    };
    const handle = (run: () => Promise<void>) => {
      if (form.getAttribute("aria-busy") === "true") return;
      form.setAttribute("aria-busy", "true");
      for (const control of form.querySelectorAll("button")) control.disabled = true;
      void run().catch(() => { message.textContent = t("account.failed"); }).finally(() => {
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

    if (!accountAvailable) {
      message.textContent = t("account.unavailable");
    } else if (this.snapshot && mode !== "reset") {
      const profile = this.snapshot.profile;
      const progress = this.snapshot.progress;
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
      action(t("account.logout"), () => handle(async () => {
        const { error } = await getAccountClient().auth.signOut({ scope: "local" });
        if (error) throw error;
        this.show();
      }));
    } else {
      const email = mode === "reset" ? null : field(t("account.email"), "email", "email");
      const password = mode === "recover" ? null : field(t("account.password"), "password", mode === "login" ? "current-password" : "new-password");
      const redirectTo = new URL("./", location.href).href;
      submit(t(`account.${mode}`), async () => {
        const auth = getAccountClient().auth;
        if (mode === "login") {
          const { data, error } = await auth.signInWithPassword({ email: email!.value, password: password!.value });
          if (error) throw error;
          if (data.user) await this.load(data.user.id);
          this.show();
        } else if (mode === "register") {
          const { error } = await auth.signUp({ email: email!.value, password: password!.value, options: { emailRedirectTo: redirectTo } });
          if (error) throw error;
          message.textContent = t("account.emailSent");
        } else if (mode === "recover") {
          const { error } = await auth.resetPasswordForEmail(email!.value, { redirectTo });
          if (error) throw error;
          message.textContent = t("account.emailSent");
        } else {
          const { error } = await auth.updateUser({ password: password!.value });
          if (error) throw error;
          await this.resume();
          this.show();
        }
      });
      if (mode !== "login") action(t("account.login"), () => this.show());
      if (mode === "login") {
        action(t("account.register"), () => this.show("register"));
        action(t("account.recover"), () => this.show("recover"));
      }
    }
    dialog.append(heading, form, message, close);
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
  }
}
