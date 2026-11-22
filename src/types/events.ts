/**
 * Event payloads communicated over Tauri IPC between Rust backend and Frontend
 */

export interface OverlayPointEvent {
  x: number; // Normalized 0..1000
  y: number; // Normalized 0..1000
  label: string;
  screenIndex?: number;
  durationMs?: number;
}

export type DrawShape =
  | "line"
  | "dashed"
  | "arrow"
  | "curve"
  | "polygon"
  | "polyline"
  | "circle"
  | "ellipse"
  | "box"
  | "text";

export interface OverlayDrawEvent {
  id?: string;
  shape: DrawShape;
  coords: number[]; // Normalized 0..1000: line/dashed/arrow/box [x1,y1,x2,y2], curve [x1,y1,cx,cy,x2,y2], polygon/polyline [x1,y1,...], circle [cx,cy,r], ellipse [cx,cy,rx,ry], text [x,y]
  label?: string;
  color?: string;
  fadeMs?: number; // Default 14000ms (only applies when persistent === false)
  persistent?: boolean;
  style?: "sketch" | "clean";
}

export type VizKind = "html" | "canvas" | "svg" | "mermaid" | "three" | "chart";

export interface OverlayVizEvent {
  id: string;
  kind: VizKind;
  title: string;
  code: string;
  width?: number;
  height?: number;
}

export interface OverlayVizLoadingEvent {
  kind: string;
  title: string;
}

export interface PartPin {
  id: string;
  name: string;
  description: string;
  position: [number, number, number];
}

export interface Overlay3DEvent {
  id: string;
  title: string;
  modelUrl?: string;
  geometryType?: 'robot' | 'drone' | 'arm' | 'sensor' | 'custom';
  bbox?: [number, number, number, number]; // [x, y, w, h] in pixels
  partPins?: PartPin[];
  visible?: boolean;
}

export interface WalkthroughStep {
  step: number;
  instruction: string;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  completed?: boolean;
}

export interface WalkthroughEvent {
  active: boolean;
  currentStep: number;
  totalSteps: number;
  steps: WalkthroughStep[];
}

export type DriveState = 'idle' | 'prompt' | 'driving' | 'paused' | 'aborted' | 'completed';

import type { RiskSeverity } from "./tools";

export interface DriveConfirmationPayload {
  toolCallId: string;
  toolName: string;
  description: string;
  parameters: Record<string, any>;
  severity?: RiskSeverity;
  screenshotUrl?: string;
}

export interface DriveStatusEvent {
  state: DriveState;
  actionDescription?: string;
  targetTool?: string;
  progress?: number;
  requiresConfirmation?: boolean;
  confirmationPayload?: DriveConfirmationPayload;
}

export interface TranscriptEvent {
  id: string;
  speaker: 'user' | 'clicky' | 'system';
  text: string;
  isPartial: boolean;
  timestamp: number;
  audioActive?: boolean;
  tags?: string[];
}

export type AgentWorkStatus = 'idle' | 'listening' | 'thinking' | 'speaking' | 'working' | 'error';

export interface AgentStatusEvent {
  agentId: string;
  agentName?: string;
  status: AgentWorkStatus;
  currentTask?: string;
  progress?: number;
}
