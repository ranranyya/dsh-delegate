// dsh-delegate settings UI — stylesheet, injected once by the client entry.
//
// The page lives *inside* the native settings dialog, so it must not restyle
// anything it does not own: every rule below is scoped to `.dshdg-*` class names
// this plugin is the only producer of, and every colour/radius/font reads a
// native design token (`--dsw-*`, `--ds-*`) with a safe literal fallback. That is
// how the page follows the operator's light/dark theme and locale-specific font
// without shipping a second design system or touching the shell's CSS.
//
// Injection contract (from the native client module system,
// `@deepseek-ai/dsh-client-modules` 0.2.0-rc.2): a `<style>` element authored
// inside the bundle factory is claimed for the materializing plugin by
// `data-plugin`, and the loader removes exactly the tags carrying this plugin's
// id when the plugin is disabled. We therefore tag the element ourselves and
// also return a disposer, so HMR/unload cannot leave an orphaned sheet behind.

/** Attribute the native module system uses to attribute and clean up styles. */
export const STYLE_PLUGIN_ATTRIBUTE = 'data-plugin';

/** Plugin id used for style ownership; matches the bundle registration id. */
export const STYLE_PLUGIN_ID = 'dsh-delegate';

/** Stable element id so a second injection replaces instead of stacking. */
export const STYLE_ELEMENT_ID = 'dsh-delegate-settings';

/**
 * The stylesheet text.
 *
 * Layout notes worth keeping: the authorization block is rendered before the
 * tab bar in the DOM (not merely first visually), so reading order, keyboard
 * order and screen-reader order all put authorization above the four areas. Grid
 * tracks use `minmax(0, 1fr)` so a long model id or diff line cannot push the
 * form wider than the settings panel.
 */
export const CSS_TEXT = `
.dshdg-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 24px;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.55;
}
.dshdg-root * { box-sizing: border-box; }
.dshdg-root h3, .dshdg-root h4 { margin: 0; font-weight: 600; }
.dshdg-root h3 { font-size: 15px; }
.dshdg-root h4 { font-size: 13px; }
.dshdg-root p { margin: 0; }
.dshdg-muted { color: var(--dsw-alias-label-secondary, #61666d); }
.dshdg-faint { color: var(--dsw-alias-label-tertiary, #8a9098); }
.dshdg-mono {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
}
.dshdg-card {
  border: 1px solid var(--dsw-alias-border-l2, #e2e5e9);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, #fff);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dshdg-card-danger { border-color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
.dshdg-row-end { justify-content: flex-end; }
.dshdg-switch { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.dshdg-switch input { width: 18px; height: 18px; margin: 0; accent-color: #087e8b; }
.dshdg-spacer { flex: 1 1 auto; }
.dshdg-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); min-width: 0; }
.dshdg-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshdg-field > label { font-weight: 500; color: var(--dsw-alias-label-secondary, #61666d); font-size: 12px; }
.dshdg-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a9098); }
.dshdg-root input[type="text"],
.dshdg-root input[type="password"],
.dshdg-root input[type="number"],
.dshdg-root select,
.dshdg-root textarea {
  width: 100%;
  padding: 5px 8px;
  color: inherit;
  font: inherit;
  background: var(--dsw-alias-bg-base, #f7f8f9);
  border: 1px solid var(--dsw-alias-border-l3, #d3d7dd);
  border-radius: var(--dsw-radius-sm, 6px);
  min-width: 0;
}
.dshdg-root textarea { resize: vertical; min-height: 76px; }
.dshdg-root input:focus-visible,
.dshdg-root select:focus-visible,
.dshdg-root textarea:focus-visible,
.dshdg-root button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #3457d5);
  outline-offset: 1px;
}
.dshdg-root input:disabled, .dshdg-root select:disabled, .dshdg-root textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.dshdg-root button {
  font: inherit;
  padding: 5px 12px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l3, #d3d7dd);
  background: var(--dsw-alias-button-tool-bar-fill, #f2f3f5);
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.dshdg-root button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #e9ebee); }
.dshdg-root button:disabled { opacity: 0.55; cursor: not-allowed; }
.dshdg-root button.dshdg-primary {
  background: var(--dsw-alias-button-primary-fill, #3457d5);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dshdg-root button.dshdg-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #2b49b8); }
.dshdg-root button.dshdg-danger { color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-check { display: flex; flex-wrap: wrap; gap: 6px 12px; }
.dshdg-check label { display: inline-flex; gap: 5px; align-items: center; font-size: 12px; }
.dshdg-check input { margin: 0; }
.dshdg-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e2e5e9); }
.dshdg-tab {
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--dsw-radius-sm, 6px) var(--dsw-radius-sm, 6px) 0 0;
  background: transparent;
  padding: 6px 14px;
}
.dshdg-tab[aria-selected="true"] {
  background: var(--dsw-alias-bg-layer-3, #fff);
  border-color: var(--dsw-alias-border-l2, #e2e5e9);
  font-weight: 600;
}
.dshdg-panel { display: flex; flex-direction: column; gap: 14px; }
.dshdg-notices { display: flex; flex-direction: column; gap: 6px; }
.dshdg-notice {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 7px 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l2, #e2e5e9);
  background: var(--dsw-alias-bg-layer-4, #f7f8f9);
}
.dshdg-notice-error { border-color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-notice-success { border-color: var(--dsw-alias-state-business-primary, #12b76a); }
.dshdg-notice > span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dshdg-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l3, #d3d7dd);
  font-size: 11px;
  white-space: nowrap;
}
.dshdg-badge-on { border-color: var(--dsw-alias-state-business-primary, #12b76a); }
.dshdg-badge-off { border-color: var(--dsw-alias-label-tertiary, #8a9098); color: var(--dsw-alias-label-secondary, #61666d); }
.dshdg-badge-warn { border-color: var(--dsw-alias-label-error, #d92d20); color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-list { display: flex; flex-direction: column; gap: 8px; }
.dshdg-item {
  border: 1px solid var(--dsw-alias-border-l2, #e2e5e9);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dshdg-item-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
.dshdg-item-head strong { overflow-wrap: anywhere; }
.dshdg-secret-warning {
  border: 1px solid var(--dsw-alias-label-error, #d92d20);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dshdg-token {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px dashed var(--dsw-alias-border-l3, #d3d7dd);
  background: var(--dsw-alias-bg-base, #f7f8f9);
  overflow-wrap: anywhere;
  user-select: all;
}
.dshdg-pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  background: var(--dsw-alias-markdown-code-block, #f5f6f8);
  border-radius: var(--dsw-radius-sm, 6px);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
}
.dshdg-layers { display: grid; gap: 6px; }
.dshdg-layer { display: grid; grid-template-columns: minmax(120px, 180px) minmax(0, 1fr); gap: 8px; align-items: start; }
.dshdg-layer-detail { overflow-wrap: anywhere; }
.dshdg-ok { color: var(--dsw-alias-state-business-primary, #12b76a); }
.dshdg-fail { color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-unknown { color: var(--dsw-alias-label-tertiary, #8a9098); }
.dshdg-table { display: grid; gap: 4px; }
.dshdg-kv { display: grid; grid-template-columns: minmax(96px, 140px) minmax(0, 1fr); gap: 4px 10px; }
.dshdg-kv dt { color: var(--dsw-alias-label-secondary, #61666d); }
.dshdg-kv dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 560px) {
  .dshdg-layer, .dshdg-kv { grid-template-columns: minmax(0, 1fr); }
}
`;

/**
 * Inject the stylesheet once.
 *
 * @param {Document | null | undefined} doc - document to inject into; a non-browser
 *   or test composition passes `null` and receives a no-op disposer.
 * @returns {() => void} disposer removing exactly the element this call created.
 */
export function injectStyles(doc) {
  const document_ = doc ?? (typeof document === 'undefined' ? null : document);
  if (document_ === null || typeof document_.createElement !== 'function') return () => {};

  const existing = typeof document_.getElementById === 'function'
    ? document_.getElementById(STYLE_ELEMENT_ID)
    : null;
  if (existing !== null && existing !== undefined) {
    // A previous instance of this plugin (HMR, re-enable) owns the sheet. Take it
    // over instead of stacking a duplicate, and give the caller a disposer for it.
    return () => {
      existing.remove?.();
    };
  }

  const element = document_.createElement('style');
  element.id = STYLE_ELEMENT_ID;
  element.setAttribute(STYLE_PLUGIN_ATTRIBUTE, STYLE_PLUGIN_ID);
  element.textContent = CSS_TEXT;
  const parent = document_.head ?? document_.documentElement ?? document_.body;
  parent.appendChild(element);
  return () => {
    element.remove?.();
  };
}
