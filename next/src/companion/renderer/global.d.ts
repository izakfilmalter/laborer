import type { LaborerCompanionBridge } from "../shared.ts";

declare global {
  interface Window {
    readonly laborerCompanion: LaborerCompanionBridge;
  }
}
