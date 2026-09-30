import { DIALOGUES } from "../data/dialogues";
import type { DialogueLine, QualityLabel } from "../types/game";

export class DialogueSystem {
  constructor(private readonly dialogues: readonly DialogueLine[] = DIALOGUES) {}

  getLines(trigger: string, chapter: number): readonly DialogueLine[] {
    return this.dialogues
      .filter((line) => line.trigger === trigger && line.chapter <= chapter)
      .sort((left, right) => right.priority - left.priority);
  }

  select(
    trigger: string,
    chapter: number,
    excludedIds: ReadonlySet<string> = new Set<string>(),
  ): DialogueLine | undefined {
    return this.getLines(trigger, chapter).find((line) => !excludedIds.has(line.id));
  }

  selectForQuality(
    label: QualityLabel,
    chapter: number,
    excludedIds: ReadonlySet<string> = new Set<string>(),
  ): DialogueLine | undefined {
    const trigger =
      label === "PERFECT COMPILE"
        ? "dish:perfect"
        : label === "POOR" || label === "CORRUPTED"
          ? "dish:poor"
          : "dish:good";
    return this.select(trigger, chapter, excludedIds);
  }
}
