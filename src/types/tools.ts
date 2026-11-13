/**
 * Tool calls, security confirmation gates, and OS Accessibility node types
 */

export type ToolStatus = 'pending' | 'executing' | 'approved' | 'rejected' | 'completed' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, any>;
  status?: ToolStatus;
  result?: any;
  error?: string;
  timestamp?: number;
}

export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ToolConfirmationPayload {
  toolCallId: string;
  toolName: string;
  description: string;
  parameters: Record<string, any>;
  severity: RiskSeverity;
  screenshotUrl?: string;
  requiresExplicitConfirm?: boolean;
}

export interface A11yNode {
  id: string;
  role: string;
  name: string;
  bbox: [number, number, number, number]; // [x, y, width, height]
  value?: string;
  children?: A11yNode[];
  focused?: boolean;
  disabled?: boolean;
}
