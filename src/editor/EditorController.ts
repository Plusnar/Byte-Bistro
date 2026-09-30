import type { Engine } from "@babylonjs/core";
import type { MapData, MapMeta } from "./MapData";
import { EditorScene } from "../scenes/EditorScene";
import { EditorUI } from "./EditorUI";
import type { ManagedScene } from "../core/SceneManager";

export interface EditorControllerOptions {
  readonly engine: Engine;
  readonly host: HTMLElement;
  readonly initialMap: MapData;
  readonly initialSlotId: string;
  readonly onPlay: (map: MapData) => void;
  readonly onExit: () => void;
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
        onPlacementOptions: (snap, surface, height) => scene.setPlacementOptions(snap, surface, height),
        onAllowOverlap: (allow) => scene.setAllowOverlap(allow),
        onSetWallMode: (mode) => scene.setWallMode(mode),
        onToggleGrid: () => scene.setGridVisible(!scene.isGridVisible()),
        onToggleTopView: () => scene.toggleTopView(),
        onRotate: (direction) => scene.rotateSelected(direction),
        onTransform: (group, axis, value) => scene.editSelected(group, axis, value),
        onRobotConfig: (patch) => scene.editSelectedRobots(patch),
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
        topView: scene.isTopView(),
        allowOverlap: scene.isOverlapAllowed(),
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
      this.ui.notify("Aguarde o mapa terminar de carregar para salvar.", "warning");
      return null;
    }
    const result = this.editorScene.saveCurrentMap(name, meta, slotId || undefined);
    if (result) {
      this.ui.setCurrentSlot(result);
      this.ui.setSlots(this.editorScene.listSlots());
      this.ui.setMeta(this.editorScene.getCurrentMap());
      this.ui.setMapName(this.editorScene.getCurrentMap().name);
      this.ui.notify("Mapa salvo", "success");
    } else {
      this.ui.notify("Não foi possível salvar (armazenamento do navegador cheio ou bloqueado)", "error");
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
    this.ui.notify(`Mapa "${data.name}" aberto`, "success");
    return true;
  }

  private copySelected(): void {
    const label = this.editorScene.startCopying();
    if (label) this.ui.notify(`Conta-gotas: clique para colocar cópias de "${label}" · Esc para parar`, "info");
    else this.ui.notify("Selecione um objeto para copiar", "warning");
  }

  private deleteSlot(slotId: string): boolean {
    const ok = this.editorScene.deleteSlot(slotId);
    if (ok) {
      this.ui.setSlots(this.editorScene.listSlots());
      this.ui.notify("Mapa excluído", "warning");
    } else {
      this.ui.notify("Não foi possível excluir o mapa", "error");
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
    this.ui.notify(`Mapa "${name}" criado`, "success");
  }
}
