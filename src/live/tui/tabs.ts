import type { LiveModel } from "../model.js";
import { armDisplayName, armsForDisplay } from "../../arms.js";

// A tab is identified by a stable string, never by index: Greg swaps which
// sessions are live between phases (one "greg" panel while planning, the two
// arms while building), so the tab list changes shape mid-run. Selecting by id
// means the view stays where the human put it, and falls back to the overview
// only when the selected tab genuinely disappears.
export interface Tab {
  id: string;
  label: string;
}

export const OVERVIEW: Tab = { id: "overview", label: "overview" };
export const LOG: Tab = { id: "log", label: "log" };

export function armTabId(arm: string): string {
  return `arm:${arm}`;
}

// The tab strip for the current moment. Future tabs (a recent-PR list, say)
// slot in here and nothing else has to change.
export function tabsFor(model: LiveModel): Tab[] {
  const arms = armsForDisplay(model.live.snapshot()).map((state) => ({
    id: armTabId(state.arm),
    label: armDisplayName(state.arm),
  }));
  const notes = model.notesLabel
    ? [{ id: "notes", label: model.notesLabel }]
    : [];
  return [OVERVIEW, ...arms, ...notes, LOG];
}

// Resolve the selected id against the tabs that actually exist right now.
export function resolveSelected(tabs: Tab[], selected: string): string {
  return tabs.some((tab) => tab.id === selected) ? selected : OVERVIEW.id;
}

// Cycle by `delta`, wrapping at both ends.
export function stepTab(tabs: Tab[], selected: string, delta: number): string {
  if (tabs.length === 0) return selected;
  const current = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === resolveSelected(tabs, selected)),
  );
  const next = (current + delta + tabs.length) % tabs.length;
  return tabs[next]!.id;
}

// "1".."9" jump straight to a tab; anything out of range is ignored.
export function tabForDigit(tabs: Tab[], input: string): string | undefined {
  if (!/^[1-9]$/.test(input)) return undefined;
  return tabs[Number(input) - 1]?.id;
}
