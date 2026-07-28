// Load lifecycle stages (mirrors the loads.status CHECK in 020_scan_inventory.sql).
// Plain module (not 'use server') so the value can be imported by both server
// actions and pages — a 'use server' file may only export async functions.
export type LoadStage =
  | 'declared'
  | 'matched'
  | 'scheduled'
  | 'picked_up'
  | 'delivered'
  | 'closed'
  | 'canceled';

export const LOAD_STAGES: LoadStage[] = [
  'declared', 'matched', 'scheduled', 'picked_up', 'delivered', 'closed', 'canceled',
];
