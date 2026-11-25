import { t } from "../i18n";
import type { AbstractEngine } from "@babylonjs/core";
import type { MapData, MapMeta } from "./MapData";
import { EditorScene } from "../scenes/EditorScene";
import { EditorUI } from "./EditorUI";
import type { ManagedScene } from "../core/SceneManager";

export interface EditorControllerOptions {
  readonly engine: AbstractEngine;
  readonly host: HTMLElement;
  readonly initialMap: MapData;
  readonly initialSlotId: string;
  readonly onPlay: (map: MapData) => void;
  readonly onExit: () => void;
  /** A slot was saved or deleted in this browser (the game mirrors it to the account). */
  readonly onSlotSaved?: (slotId: string) => void;
  readonly onSlotDeleted?: (slotId: string) => void;
}

export class EditorController implements ManagedScene {
  readonly scene: EditorScene["scene"];

  private readonly editorScene: EditorScene;
  private readonly ui: EditorUI;
  private readonly options: EditorControllerOptions;
  private destroyed = false;
  /**
   * True while a slot or a new map is being built. The scene already holds the new map but
   * the UI still shows the old slot, so a save now would write one map into another's slot.
   */
  private busy = false;
  /** The scene state the chrome last showed; the DOM is only touched when it moves. */
  private syncedVersion = -1;

  constructor(options: EditorControllerOptions) {
    this.options = options;
    this.editorScene = new EditorScene(
      options.engine,
      options.host,
      {
        onExit: () => this.options.onExit(),
        onPlay: (map) => this.options.onPlay(map),
        onNotice: (message, tone) => this.ui?.notify(message, tone),
      },
      options.initialMap,
      options.initialSlotId,
    );
    this.scene = this.editorScene.scene;
    const scene = this.editorScene;
    this.ui = new EditorUI(
      options.host,
      options.initialMap.name,
      options.initialSlotId,
      scene.listSlots(),
      {
        onSave: (name, meta, slotId) => this.save(name, meta, slotId),
        onLoadSlot: async (slotId) => this.loadSlot(slotId),
        onDeleteSlot: (slotId) => this.deleteSlot(slotId),
        onNewMap: (name) => void this.newMap(name),
        onSetTool: (tool) => scene.setTool(tool),
        onSetAsset: (asset) => scene.setAsset(asset),
        onSetGizmoMode: (mode) => scene.setGizmoMode(mode),
        onDeleteSelected: () => scene.deleteSelected(),
        onDuplicateSelected: () => scene.duplicateSelected(),
        onCopySelected: () => this.copySelected(),
        onSelectAll: () => scene.selectAll(),
        onClearSelection: () => scene.clearSelection(),
        onPlay: () => scene.playCurrentMap(),
        onPlacementOptions: (snap, height) => scene.setPlacementOptions(snap, height),
        onSetWallMode: (mode) => scene.setWallMode(mode),
        onToggleGrid: () => scene.setGridVisible(!scene.isGridVisible()),
        onToggleTopView: () => scene.toggleTopView(),
        onRotate: (direction) => scene.rotateSelected(direction),
        onTransform: (group, axis, value) => scene.editSelected(group, axis, value),
        onRobotConfig: (patch) => scene.editSelectedRobots(patch),
        onMechanismConfig: (patch) => scene.editSelectedMechanisms(patch),
        onColorPreview: (material, hex) => scene.previewSelectedColor(material, hex),
        onColorCommit: (material, hex) => scene.commitSelectedColor(material, hex),
        onResetColors: () => scene.resetSelectedColors(),
        onUndo: (redo) => scene.undo(redo),
        onClose: () => this.options.onExit(),
        listSlots: () => scene.listSlots(),
        hasUnsavedChanges: () => scene.hasUnsavedChanges(),
        getCurrentMap: () => scene.getCurrentMap(),
        onImportMap: (map) => scene.loadImportedMap(map),
      },
    );
    this.ui.setMap(options.initialMap, options.initialSlotId);
  }

  getCurrentMap(): MapData { return this.editorScene.getCurrentMap(); }
  getCurrentSlotId(): string { return this.editorScene.getCurrentSlotId(); }

  update(deltaSeconds: number): void {
    if (this.destroyed) return;
    const version = this.editorScene.getStateVersion();
    if (version !== this.syncedVersion) {
      this.syncedVersion = version;
      const scene = this.editorScene;
      this.ui.sync({
        map: scene.getCurrentMap(),
        selection: scene.getSelectedObjects(),
        tool: scene.getCurrentTool(),
        asset: scene.getCurrentAsset(),
        gizmo: scene.getGizmoMode(),
        wallMode: scene.getWallMode(),
        gridVisible: scene.isGridVisible(),
        freePlacement: scene.isFreePlacement(),
        topView: scene.isTopView(),
        placementHeight: scene.getPlacementHeight(),
        canUndo: scene.canUndo(),
        canRedo: scene.canRedo(),
        hint: scene.getHint(),
        loading: scene.getLoadingProgress(),
        colors: scene.getSelectionColors(),
      });
    }
    this.editorScene.update(deltaSeconds);
    this.editorScene.render();
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ui.destroy();
    this.editorScene.dispose();
  }

  private save(name: string, meta: MapMeta, slotId?: string): string | null {
    if (this.busy) {
      this.ui.notify(t("editor.waitLoading"), "warning");
      return null;
    }
    const result = this.editorScene.saveCurrentMap(name, meta, slotId || undefined);
    if (result) {
      this.ui.setCurrentSlot(result);
      this.ui.setSlots(this.editorScene.listSlots());
      this.ui.setMeta(this.editorScene.getCurrentMap());
      this.ui.setMapName(this.editorScene.getCurrentMap().name);
      this.ui.notify(t("editor.saved"), "success");
      this.options.onSlotSaved?.(result);
    } else {
      this.ui.notify(t("editor.saveFailed"), "error");
    }
    return result;
  }

  private async loadSlot(slotId: string): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    let data: MapData | null;
    try {
      data = await this.editorScene.loadSlot(slotId);
    } finally {
      this.busy = false;
    }
    if (!data || this.destroyed) return false;
    this.ui.setMap(data, slotId);
    this.ui.setSlots(this.editorScene.listSlots());
    this.ui.notify(t("editor.opened", { name: data.name }), "success");
    return true;
  }

  private copySelected(): void {
    const label = this.editorScene.startCopying();
    if (label) this.ui.notify(t("editor.eyedropperStart", { name: label }), "info");
    else this.ui.notify(t("editor.selectToCopy"), "warning");
  }

  private deleteSlot(slotId: string): boolean {
    const ok = this.editorScene.deleteSlot(slotId);
    if (ok) {
      this.ui.setSlots(this.editorScene.listSlots());
      this.ui.notify(t("editor.deleted"), "warning");
      this.options.onSlotDeleted?.(slotId);
    } else {
      this.ui.notify(t("editor.deleteFailed"), "error");
    }
    return ok;
  }

  private async newMap(name: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let data: MapData;
    try {
      data = await this.editorScene.newMap(name);
    } finally {
      this.busy = false;
    }
    if (this.destroyed) return;
    this.ui.setMap(data, "");
    this.ui.setSlots(this.editorScene.listSlots());
    this.ui.notify(t("editor.created", { name }), "success");
  }
}
